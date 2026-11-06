import { adjustImagePixels, blendImagePixels } from './image-compositing';
import { CHANNEL_KEYS, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE, decodeTga, encodeTga, normalizeChannelPackSettings, packImageChannels, writePackedChannel } from './channel-packing';

let packedResult = null;
const preparedChannels = new Set();
const opaqueSourceError = () => new Error('请使用不透明灰度贴图；透明数据请使用通道合并节点的 TGA 输出。');

function requireOpaque(data) {
  for (let offset = 3; offset < data.length; offset += 4) if (data[offset] !== 255) throw opaqueSourceError();
}

function bitmapPixels(bitmap, width, height, requireOpaqueSource, fullOutput) {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('当前浏览器不支持后台通道处理，请更新 Chrome 或 Edge 后重试。');
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法创建后台通道处理画布。');
  context.imageSmoothingEnabled = false;
  if (requireOpaqueSource && fullOutput) {
    // Native-size validation uses a bounded scratch tile, including pixels
    // which nearest-neighbor resampling would otherwise skip.
    const scratch = new OffscreenCanvas(Math.min(256, bitmap.width), Math.min(256, bitmap.height));
    const scan = scratch.getContext('2d', { willReadFrequently: true });
    if (!scan) throw new Error('浏览器无法检查贴图透明度。');
    for (let y = 0; y < bitmap.height; y += scratch.height) {
      for (let x = 0; x < bitmap.width; x += scratch.width) {
        const w = Math.min(scratch.width, bitmap.width - x);
        const h = Math.min(scratch.height, bitmap.height - y);
        scan.clearRect(0, 0, scratch.width, scratch.height);
        scan.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
        requireOpaque(scan.getImageData(0, 0, w, h).data);
      }
    }
  }
  context.drawImage(bitmap, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  if (requireOpaqueSource && !fullOutput) requireOpaque(image.data);
  return image;
}

function prepareChannel({ channel, width, height, rawTga, bitmap, settings, fullOutput }) {
  try {
    if (!CHANNEL_KEYS.includes(channel) || !Number.isInteger(width) || !Number.isInteger(height)
        || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS || Math.max(width, height) > MAX_IMAGE_EDGE) throw new Error('通道处理尺寸无效或超过输出上限。');
    const { channels } = normalizeChannelPackSettings(settings);
    const image = rawTga ? decodeTga(rawTga, { width, height })
      : bitmapPixels(bitmap, width, height, channels[channel].source !== 'alpha', fullOutput);
    if (!packedResult) packedResult = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    if (packedResult.width !== width || packedResult.height !== height) throw new Error('通道处理尺寸不一致。');
    writePackedChannel(packedResult, channel, image, channels[channel]);
    preparedChannels.add(channel);
  } finally { bitmap?.close(); }
}

self.onmessage = ({ data: { type, requestId, mode, base, overlay, mask, channelInputs, settings, outputTga, previewChannel, ...preparation } }) => {
  try {
    if (type === 'channelInput') {
      prepareChannel({ ...preparation, settings });
      self.postMessage({ ok: true, requestId, prepared: true });
      return;
    }
    if (mode === 'channelPack' && packedResult) {
      const { channels } = normalizeChannelPackSettings(settings);
      for (const channel of CHANNEL_KEYS) if (!preparedChannels.has(channel)) writePackedChannel(packedResult, channel, null, channels[channel]);
    }
    const result = mode === 'channelPack' ? packedResult || packImageChannels(channelInputs, settings)
      : mode === 'imageBlend' ? blendImagePixels(base, overlay, settings, mask) : adjustImagePixels(base, settings);
    // Encode before any display-only alpha conversion; zero-alpha RGB is data.
    const tgaBytes = outputTga ? encodeTga(result) : null;
    if (mode === 'channelPack' && previewChannel && previewChannel !== 'rgba') {
      const channelIndex = CHANNEL_KEYS.indexOf(previewChannel);
      for (let offset = 0; offset < result.data.length; offset += 4) {
        if (channelIndex >= 0) result.data.fill(result.data[offset + channelIndex], offset, offset + 3);
        result.data[offset + 3] = 255;
      }
    }
    self.postMessage({ ok: true, requestId, result, ...(tgaBytes ? { tgaBytes } : {}) },
      [...new Set([result.data.buffer, ...(tgaBytes ? [tgaBytes.buffer] : [])])]);
    packedResult = null;
    preparedChannels.clear();
  } catch (error) {
    self.postMessage({ ok: false, requestId, error: error.message });
  }
};
