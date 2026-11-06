import { CHANNEL_KEYS, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE, readTgaHeader } from './channel-packing';

const abortError = () => new DOMException('图片处理已取消。', 'AbortError');

async function bitmapFor(ref, signal) {
  if (!ref?.data.url) throw new Error(`「${ref?.data.title || '图片'}」尚未加载，请稍后重试。`);
  const response = await fetch(ref.data.url, { signal });
  if (!response.ok) throw new Error(`无法读取「${ref.data.title}」。`);
  return createImageBitmap(await response.blob());
}

function pixels(bitmap, width, height, fit = 'stretch', smoothing = true) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法创建图片处理画布。');
  context.imageSmoothingEnabled = smoothing;
  if (fit === 'stretch') context.drawImage(bitmap, 0, 0, width, height);
  else {
    const scale = Math[fit === 'contain' ? 'min' : 'max'](width / bitmap.width, height / bitmap.height);
    const w = bitmap.width * scale; const h = bitmap.height * scale;
    context.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
  }
  return context.getImageData(0, 0, width, height);
}

export async function readImageHistogram(url, signal) {
  const bitmap = await bitmapFor({ data: { url, title: '直方图原图' } }, signal);
  try {
    signal?.throwIfAborted();
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const image = pixels(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const bins = Object.fromEntries(['rgb', 'red', 'green', 'blue'].map((channel) => [channel, new Array(256).fill(0)]));
    for (let index = 0; index < image.data.length; index += 4) {
      const [red, green, blue, alpha] = image.data.subarray(index, index + 4);
      if (!alpha) continue;
      bins.red[red] += alpha / 255; bins.green[green] += alpha / 255; bins.blue[blue] += alpha / 255;
      bins.rgb[Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue)] += alpha / 255;
    }
    return bins;
  } finally { bitmap.close(); }
}

export async function renderImageProcess(mode, refs, settings, { maxEdge = 0, signal, tga = false, previewChannel = 'rgb' } = {}) {
  signal?.throwIfAborted();
  const loaded = [];
  let worker;
  let rejectPending;
  let requestId = 0;
  const abort = () => rejectPending?.(abortError());
  signal?.addEventListener('abort', abort, { once: true });
  const callWorker = (message, transfers = []) => new Promise((resolve, reject) => {
    rejectPending = reject;
    signal?.throwIfAborted();
    worker ||= new Worker(new URL('./image-compositing.worker.js', import.meta.url), { type: 'module' });
    const currentRequest = ++requestId;
    worker.onmessage = ({ data }) => {
      if (data.requestId !== currentRequest) return;
      if (data.ok) resolve(data); else reject(new Error(data.error));
    };
    worker.onerror = () => reject(new Error('图片处理失败，请减少图片尺寸后重试。'));
    worker.postMessage({ ...message, requestId: currentRequest }, [...new Set(transfers)]);
  }).finally(() => { rejectPending = null; });
  let originalWidth;
  let originalHeight;
  let width;
  let height;
  const setDimensions = (source) => {
    if (originalWidth !== undefined) return;
    originalWidth = source.width; originalHeight = source.height;
    if (!Number.isInteger(originalWidth) || !Number.isInteger(originalHeight) || originalWidth < 1 || originalHeight < 1) throw new Error('输入图片尺寸无效。');
    if (!maxEdge && (originalWidth * originalHeight > MAX_IMAGE_PIXELS || Math.max(originalWidth, originalHeight) > MAX_IMAGE_EDGE)) throw new Error('当前版本单次输出最多 32MP、单边 16384 像素，请先缩小输入图片。');
    const ratio = maxEdge ? Math.min(1, maxEdge / Math.max(originalWidth, originalHeight)) : 1;
    width = Math.max(1, Math.round(originalWidth * ratio)); height = Math.max(1, Math.round(originalHeight * ratio));
    if (width * height > MAX_IMAGE_PIXELS || Math.max(width, height) > MAX_IMAGE_EDGE) throw new Error('预览或输出尺寸超过处理上限。');
  };
  try {
    const load = async (slot) => {
      const ref = refs.find((item) => item.data.slot === slot);
      if (!ref) return null;
      const bitmap = await bitmapFor(ref, signal); loaded.push(bitmap); return bitmap;
    };
    let response;
    if (mode === 'channelPack') {
      for (const channel of CHANNEL_KEYS) {
        const ref = refs.find((item) => item.data.slot === channel);
        if (!ref) continue;
        if (ref.data.rawUrl) {
          const rawResponse = await fetch(ref.data.rawUrl, { signal });
          if (!rawResponse.ok) throw new Error(`无法读取「${ref.data.title || '图片'}」的 TGA 原始通道。`);
          const rawTga = new Uint8Array(await rawResponse.arrayBuffer());
          // Header inspection allocates no native RGBA buffer on the UI thread.
          setDimensions(readTgaHeader(rawTga));
          await callWorker({ type: 'channelInput', channel, rawTga, width, height, settings, fullOutput: !maxEdge }, [rawTga.buffer]);
        } else {
          const bitmap = await bitmapFor(ref, signal);
          try {
            setDimensions(bitmap);
            await callWorker({ type: 'channelInput', channel, bitmap, width, height, settings, fullOutput: !maxEdge }, [bitmap]);
          } finally { bitmap.close(); }
        }
        signal?.throwIfAborted();
      }
      if (originalWidth === undefined) throw new Error('请先连接输入图片。');
      response = await callWorker({ mode, settings, outputTga: !maxEdge, ...(maxEdge ? { previewChannel } : {}) });
    } else {
      const baseBitmap = await load(mode === 'imageBlend' ? 'base' : 'guide');
      if (!baseBitmap) throw new Error('请先连接输入图片。');
      setDimensions(baseBitmap);
      const base = pixels(baseBitmap, width, height);
      const overlayBitmap = mode === 'imageBlend' ? await load('overlay') : null;
      const maskBitmap = mode === 'imageBlend' ? await load('mask') : null;
      const overlay = overlayBitmap ? pixels(overlayBitmap, width, height, settings.fit) : null;
      const mask = maskBitmap ? pixels(maskBitmap, width, height) : null;
      const plain = (image) => image && ({ width: image.width, height: image.height, data: image.data });
      response = await callWorker({ mode, base: plain(base), overlay: plain(overlay), mask: plain(mask), settings, outputTga: !maxEdge && tga },
        [base, overlay, mask].filter(Boolean).map((image) => image.data.buffer));
    }
    signal?.throwIfAborted();
    const result = response.result;
    const tgaBlob = response.tgaBytes ? new Blob([response.tgaBytes], { type: 'image/x-tga' }) : null;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const outputContext = canvas.getContext('2d');
    if (!outputContext) throw new Error('浏览器无法创建图片输出画布。');
    outputContext.putImageData(new ImageData(result.data, width, height), 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 编码失败。')), 'image/png'));
    signal?.throwIfAborted();
    return { blob, width, height, originalWidth, originalHeight, ...(tgaBlob ? { tgaBlob } : {}) };
  } finally {
    worker?.terminate();
    signal?.removeEventListener('abort', abort);
    loaded.forEach((bitmap) => bitmap.close());
  }
}
