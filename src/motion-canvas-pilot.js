// Agent-authored, data-only timing for the Motion Canvas preview.
import { VIDEO_EDIT_VIDEO_PORTS } from './video-edit-document.js';

export const MOTION_CANVAS_MAX_CUES = 5;
const MAX_SOURCE_MS = 60 * 60 * 1000;
const MAX_PREVIEW_MS = 60 * 1000;

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\p{Cc}\p{Surrogate}]/u.test(value)) {
    throw new Error(label + '需要 1–' + max + ' 字的单行文本。');
  }
  return value.trim();
}

export function normalizeMotionCanvasPreview(plan) {
  if (!plan || !VIDEO_EDIT_VIDEO_PORTS.includes(plan.slot)) throw new Error('请选择有效的视频输入端口。');
  const { slot, sourceInMs, sourceOutMs, title, cues } = plan;
  if (!Number.isInteger(sourceInMs) || !Number.isInteger(sourceOutMs) || sourceInMs < 0 ||
      sourceOutMs > MAX_SOURCE_MS || sourceOutMs - sourceInMs < 1000 || sourceOutMs - sourceInMs > MAX_PREVIEW_MS) {
    throw new Error('请选择源视频内 1–60 秒的连续预览区间。');
  }
  if (!Array.isArray(cues) || cues.length < 1 || cues.length > MOTION_CANVAS_MAX_CUES) {
    throw new Error('每次预览可以安排 1–5 个口播触发点。');
  }
  let previous = sourceInMs - 1;
  const markers = cues.map((cue) => {
    if (!cue || !Number.isInteger(cue.atMs) || cue.atMs <= previous || cue.atMs >= sourceOutMs) {
      throw new Error('触发点须位于预览区间内，并按源视频毫秒时间严格递增。');
    }
    previous = cue.atMs;
    return { atMs: cue.atMs, label: text(cue.label, 24, '要点'), detail: text(cue.detail, 52, '说明') };
  });
  return { slot, sourceInMs, sourceOutMs, title: text(title, 42, '标题'), cues: markers };
}
