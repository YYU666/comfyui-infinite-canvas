export const REFMUSE_ORIGINS = ['https://refmuse.cn', 'https://www.refmuse.cn'];
export const REFMUSE_IMAGE_LIMIT = 32 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}

export function normalizeRefmuseReference(reference = {}) {
  return {
    title: String(reference?.title || 'Refmuse 场景参考').slice(0, 160),
    author: String(reference?.author || '').slice(0, 160),
    sourceUrl: httpsUrl(reference?.sourceUrl),
    mediaUrl: httpsUrl(reference?.mediaUrl),
    attribution: 'refmuse-selected-reference',
  };
}

// The remote page may deliver bytes, never a command or a URL to fetch locally.
export function createRefmuseCanvasBridge({ getFrame, channel, onImport, isActive = () => true, isReadOnly, isBusy, onReady, onBusy, onMessage }) {
  const receipts = new Map();
  let stopped = false;
  let importing = false;
  const init = () => {
    if (stopped) return;
    for (const origin of REFMUSE_ORIGINS) getFrame()?.postMessage({ type: 'refmuse.canvas.init', version: 1, channel }, origin);
  };
  const receive = async (event) => {
    const frame = getFrame();
    const data = event.data;
    if (stopped || !frame || event.source !== frame || !REFMUSE_ORIGINS.includes(event.origin)
      || data?.version !== 1 || data?.channel !== channel) return;
    if (data.type === 'refmuse.canvas.ready') { onReady?.(); return; }
    if (data.type !== 'refmuse.canvas.import' || typeof data.requestId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.requestId)) return;
    const reply = (result) => {
      if (!stopped) frame.postMessage({ type: 'refmuse.canvas.result', version: 1, channel, requestId: data.requestId, ...result }, event.origin);
    };
    if (receipts.has(data.requestId)) { reply(await receipts.get(data.requestId)); return; }
    // Bounded lifetime: never evict a receipt and accidentally replay a write.
    if (receipts.size >= 100) {
      const result = { ok: false, code: 'SESSION_LIMIT', retryable: false, message: '本次参考库会话已达到 100 次请求，请点击「重新加载」开启新会话。' };
      onMessage(result); reply(result); return;
    }
    const run = async () => {
      if (!isActive()) return { ok: false, code: 'LIBRARY_HIDDEN', retryable: true, message: '参考库已收起，请重新打开后点击重试。' };
      if (isReadOnly()) return { ok: false, code: 'READ_ONLY', retryable: true, message: '当前画布为只读，无法导入。' };
      if (importing || isBusy()) return { ok: false, code: 'BUSY', retryable: true, message: '正在保存另一张参考图，请稍后重新选择。' };
      if (!(data.blob instanceof Blob) || !IMAGE_TYPES[data.blob.type] || data.blob.size < 1 || data.blob.size > REFMUSE_IMAGE_LIMIT) {
        return { ok: false, code: 'INVALID_IMAGE', retryable: false, message: '仅支持不超过 32 MiB 的单张 PNG、JPEG 或 WebP 图片。' };
      }
      importing = true; onBusy(true);
      try {
        const reference = normalizeRefmuseReference(data.reference);
        const filename = reference.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        const file = new File([data.blob], `${filename}.${IMAGE_TYPES[data.blob.type]}`, { type: data.blob.type });
        await onImport(file, 'refmuse', reference);
        const result = { ok: true, message: '参考图和画布已保存。' };
        onMessage(result); return result;
      } catch {
        // Do not leak local paths/project details to the remote website.
        const result = { ok: false, code: 'SAVE_UNCONFIRMED', retryable: false, message: '导入未完成，请检查本地画布的保存状态；已有节点时请勿重复导入。' };
        return result;
      } finally { importing = false; onBusy(false); }
    };
    const pending = run(); receipts.set(data.requestId, pending);
    const result = await pending;
    if (!result.ok) onMessage({ ...result, message: `${normalizeRefmuseReference(data.reference).title}：${result.message}` });
    reply(result);
  };
  return { init, receive, stop() { stopped = true; } };
}
