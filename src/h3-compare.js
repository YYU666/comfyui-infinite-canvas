const PROJECT_VIDEO_ASSET = /^assets\/[a-f0-9]{64}\.(mp4|mov|mkv|webm)$/;
const refineName = (value) => typeof value === 'string' && /^H3_HD_Refine_/i.test(value);

export function h3CompareCandidate(node, projectId) {
  if (node?.type !== 'media' || node.data?.kind !== 'video') return null;
  const { assetPath, type, filename, name, title, subfolder = '' } = node.data;
  if (assetPath) {
    if (typeof assetPath !== 'string' || !PROJECT_VIDEO_ASSET.test(assetPath) || ![name, title, filename].some(refineName)) return null;
    return { type: 'project', projectId, assetPath };
  }
  return type === 'output' && refineName(filename) ? { type, filename, subfolder } : null;
}

export async function loadH3Comparison(projectId, nodeId, signal) {
  const query = new URLSearchParams({ projectId, nodeId });
  const response = await fetch('/api/h3-compare?' + query, { credentials: 'same-origin', cache: 'no-store', signal });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value || !Object.hasOwn(value, 'refined')) {
    const error = new Error(value?.message || '当前工作台没有返回 H3 对照数据。');
    error.routeUnavailable = response.status === 404 && !value?.message || response.ok || value?.code === 'NOT_FOUND';
    throw error;
  }
  return value;
}

export function h3MediaUrl(media) {
  if (media.type === 'project') {
    const filename = media.assetPath.slice('assets/'.length);
    return '/api/projects/' + encodeURIComponent(media.projectId) + '/assets/' + encodeURIComponent(filename);
  }
  return '/api/comfy/view?' + new URLSearchParams({
    filename: media.filename, subfolder: media.subfolder, type: media.type,
  });
}

export const seconds = (time) => time ? time.num / time.den : null;

export function h3FrameTarget(clock, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= clock.count) return null;
  const at = (frame) => clock.step ? frame * seconds(clock.step) : clock.times[frame];
  const pts = at(index);
  const end = index + 1 < clock.count ? at(index + 1) : seconds(clock.end);
  const nextGap = end - pts;
  const previousGap = index > 0 ? pts - at(index - 1) : nextGap;
  if (!(nextGap > 0 && previousGap > 0)) return null;
  return { pts, seekTime: pts + nextGap / 3, tolerance: Math.min(0.001, nextGap / 4, previousGap / 4) };
}

export function presentH3Frame(video, target, signal, timeout = 2200) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (!target || typeof video.requestVideoFrameCallback !== 'function' || typeof video.cancelVideoFrameCallback !== 'function') {
      reject(new Error('当前浏览器不能核验实际显示帧。'));
      return;
    }
    let callback = null;
    let timer = null;
    function finish(error, value) {
      clearTimeout(timer);
      if (callback !== null) video.cancelVideoFrameCallback(callback);
      signal.removeEventListener('abort', abort);
      video.removeEventListener('error', mediaError);
      if (error) reject(error);
      else resolve(value);
    }
    const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
    const mediaError = () => finish(new Error('视频不可解码或读取失败。'));
    function received(_, frame) {
      callback = null;
      if (Math.abs(frame.mediaTime - target.pts) <= target.tolerance) finish(null, frame.mediaTime);
      else callback = video.requestVideoFrameCallback(received);
    }
    signal.addEventListener('abort', abort, { once: true });
    video.addEventListener('error', mediaError, { once: true });
    timer = setTimeout(() => finish(new Error('播放器未确认目标帧。')), timeout);
    try {
      video.pause();
      callback = video.requestVideoFrameCallback(received);
      video.currentTime = target.seekTime;
    } catch (error) { finish(error); }
  });
}
