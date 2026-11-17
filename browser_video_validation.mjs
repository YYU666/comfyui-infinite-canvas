import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink } from 'node:fs/promises';
const run = promisify(execFile);

export class VideoImportError extends Error {}

export function postId(value) {
  try {
    const url = new URL(value);
    if (!(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return '';
    return url.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1] || url.searchParams.get('modal_id')?.match(/^\d+$/)?.[0] || '';
  } catch { return ''; }
}

// Only a video nested in the exact requested post can supply a download URL.
export function findPostVideo(payload, id) {
  if (!id || !payload || typeof payload !== 'object') return null;
  const queue = [payload];
  for (let index = 0; index < queue.length && index < 20000; index++) {
    const item = queue[index];
    if (String(item.aweme_id ?? item.awemeId ?? '') === id) {
      const video = item.video;
      const duration = Number(video?.duration ?? item.duration) / 1000;
      const addresses = [video?.play_addr, video?.playAddr, ...(video?.bit_rate || []).map(rate => rate.play_addr)];
      for (const address of addresses) {
        const url = (address?.url_list || address?.urlList || []).find(value => {
          try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
        });
        if (url && Number.isFinite(duration) && duration > 0) return {url, duration, awemeId: id, title: String(item.desc || '抖音视频参考')};
      }
    }
    for (const value of Object.values(item)) if (value && typeof value === 'object') queue.push(value);
  }
  return null;
}

export function validateDuration(actual, expected) {
  if (!Number.isFinite(actual) || actual <= 0 || !Number.isFinite(expected) || expected <= 0 || Math.abs(actual - expected) > Math.max(0.5, expected * 0.03)) {
    throw new VideoImportError('下载视频时长与目标作品不符，可能是占位或预览视频，请手动上传原视频。');
  }
}

export async function validateDownloadedVideo(path, expected, ffmpeg, execute = run) {
  try {
    if (!ffmpeg) throw new VideoImportError('缺少视频内容校验工具。');
    // Decode the video, not just its container header. Never include decoder stderr in user errors.
    const result = await execute(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-i', path, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-progress', 'pipe:1', '-f', 'null', '-'], {timeout: 90000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
    const progress = result.stdout || '';
    const times = [...progress.matchAll(/^out_time_us=(\d+)$/gm)];
    const frames = [...progress.matchAll(/^frame=(\d+)$/gm)];
    const duration = /progress=end/.test(progress) && Number(frames.at(-1)?.[1]) > 0
      ? Number(times.at(-1)?.[1]) / 1000000 : NaN;
    validateDuration(duration, expected);
    return duration;
  } catch (error) {
    await unlink(path).catch(() => {});
    if (error instanceof VideoImportError) throw error;
    throw new VideoImportError('下载的视频未通过目标作品内容校验，可能是占位、预览或损坏文件，请手动上传原视频。');
  }
}
