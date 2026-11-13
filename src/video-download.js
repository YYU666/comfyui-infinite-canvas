/** Shared checks for the page's existing video-link download. No network and no logging. */

export const VIDEO_DOWNLOAD_TIMEOUT_MS = 8 * 60 * 1000;

const SHARE_URL_PATTERN = /https?:\/\/[^\s<>"'，。！？；、【】（）]+/i;
const TRAILING_PUNCTUATION = /[.,!?;，。！？；、)\]}]+$/;
const DOWNLOAD_STATUSES = new Set(['queued', 'downloading', 'done', 'failed']);

export function validatePublicVideoUrl(value) {
  if (typeof value !== 'string') throw new Error('请提供 http 或 https 视频链接。');
  const text = value.trim();
  if (!text || text.length > 4000) throw new Error('视频链接无效或过长。');
  const match = text.match(SHARE_URL_PATTERN);
  if (!match) throw new Error('没有检测到视频链接，请提供 http 或 https 链接。');
  const urlText = match[0].replace(TRAILING_PUNCTUATION, '');
  let parsed;
  try { parsed = new URL(urlText); }
  catch { throw new Error('请提供有效的 HTTP 或 HTTPS 视频链接。'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只接受 HTTP 或 HTTPS 视频链接。');
  if (parsed.username || parsed.password) throw new Error('视频链接不能包含账号或密码。');
  if (!parsed.hostname) throw new Error('请提供有效的 HTTP 或 HTTPS 视频链接。');
  return urlText;
}

export function publicDownloadError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '视频下载超时，请换较短的视频，或下载后手动上传。';
  const message = String(error?.message || '视频下载失败。').replace(/https?:\/\/[^\s/@]*:[^\s/@]*@/gi, 'https://');
  return message.slice(0, 500) || '视频下载失败。';
}

export function videoDownloadSignal(timeoutMs = VIDEO_DOWNLOAD_TIMEOUT_MS) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer?.unref === 'function') timer.unref();
  return controller.signal;
}

/** Fields canvas_get_state adds for a 视频链接下载 node. Null for every other node. */
export function videoDownloadState(data = {}) {
  if (data.noteRole !== 'videoDownload') return null;
  const downloadStatus = DOWNLOAD_STATUSES.has(data.downloadStatus) ? data.downloadStatus : 'idle';
  const message = String(data.downloadMessage || (downloadStatus === 'failed' ? data.error : '') || '');
  return {
    noteRole: 'videoDownload',
    downloadStatus,
    message,
    ...(downloadStatus === 'failed' && message ? { error: message } : {}),
    downloadJobId: data.downloadJobId || null,
    videoNodeId: data.videoNodeId || null,
    sourceUrl: data.sourceUrl || '',
  };
}
