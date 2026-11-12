// Video edit document (E1). Mirrors video_edit_document.py exactly: integer PTS on
// rational time bases, strict keys, no paths/URLs/filter text. Python remains the
// authority at export time; this copy gives the page and agents early errors.
import { videoProcessorCycle, videoStreamAsset, videoStreamKind, isVideoProcessor } from './video-stream.js';

export const VIDEO_EDIT_SCHEMA_VERSION = 1;
export const VIDEO_EDIT_VIDEO_PORTS = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'];
export const VIDEO_EDIT_PORTS = [...VIDEO_EDIT_VIDEO_PORTS, 'a1'];
export const VIDEO_EDIT_MAX_CLIPS = 64;
export const VIDEO_EDIT_MAX_PAD = 2000;
const MAX_PTS = Number.MAX_SAFE_INTEGER;
const CLIP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_PROFILE = { fps: { num: 24, den: 1 }, audio: 'clips', videoCodec: 'h264', audioCodec: 'aac', crf: 14 };

export const isVideoEdit = (node) => node?.type === 'videoEdit';

function fail(message) { throw new Error(message); }
function keys(value, allowed, path, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} 必须是对象。`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) fail(`${path} 含不支持的字段：${unknown.join(', ')}。`);
  const missing = required.filter((key) => !(key in value));
  if (missing.length) fail(`${path} 缺少字段：${missing.join(', ')}。`);
}
function int(value, path, min = 0, max = MAX_PTS) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${path} 必须是 ${min}–${max} 之间的整数。`);
  return value;
}
function bool(value, path) { if (typeof value !== 'boolean') fail(`${path} 必须是布尔值。`); return value; }
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
function rational(value, path, min, max) {
  keys(value, ['num', 'den'], path, ['num', 'den']);
  const num = int(value.num, `${path}.num`, 1, 1000000), den = int(value.den, `${path}.den`, 1, 1000000);
  if ((min !== undefined && num < min * den) || (max !== undefined && num > max * den)) fail(`${path} 超出允许范围。`);
  return { num, den };
}
function slot(value, path, allowed = VIDEO_EDIT_PORTS) {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${path} 必须是输入端口 ${allowed.join(', ')} 之一。`);
  return value;
}
function range(value, path) {
  const start = int(value.sourceInPts, `${path}.sourceInPts`), end = int(value.sourceOutPts, `${path}.sourceOutPts`);
  if (end <= start) fail(`${path} 的 sourceOutPts 必须大于 sourceInPts（半开区间）。`);
  return [start, end];
}

export function normalizeVideoEditDocument(document) {
  keys(document, ['schemaVersion', 'timelineTimebase', 'outputProfile', 'clips'], 'editDocument', ['schemaVersion', 'clips']);
  if (document.schemaVersion !== VIDEO_EDIT_SCHEMA_VERSION) fail('editDocument.schemaVersion 必须为 1。');
  const supplied = document.outputProfile ?? {};
  keys(supplied, ['fps', 'width', 'height', 'audio', 'audioFrom', 'videoCodec', 'audioCodec', 'crf'], 'outputProfile');
  const profile = { ...DEFAULT_PROFILE, ...supplied };
  profile.fps = rational(profile.fps, 'outputProfile.fps', 1, 120);
  for (const key of ['width', 'height']) if (key in profile) {
    int(profile[key], `outputProfile.${key}`, 16, 7680);
    if (profile[key] % 2) fail(`outputProfile.${key} 必须是偶数（yuv420p）。`);
  }
  if (('width' in profile) !== ('height' in profile)) fail('outputProfile.width 与 height 必须同时提供或同时省略。');
  if (!['clips', 'mute', 'external'].includes(profile.audio)) fail('outputProfile.audio 必须是 clips、mute 或 external。');
  if (profile.videoCodec !== 'h264') fail('outputProfile.videoCodec 目前只支持 h264。');
  if (profile.audioCodec !== 'aac') fail('outputProfile.audioCodec 目前只支持 aac。');
  int(profile.crf, 'outputProfile.crf', 0, 51);
  if (profile.audio === 'external') {
    const source = profile.audioFrom;
    keys(source, ['inputSlot', 'sourceInPts', 'sourceOutPts', 'timebase'], 'outputProfile.audioFrom', ['inputSlot', 'sourceInPts', 'sourceOutPts']);
    const normalized = { inputSlot: slot(source.inputSlot, 'outputProfile.audioFrom.inputSlot') };
    [normalized.sourceInPts, normalized.sourceOutPts] = range(source, 'outputProfile.audioFrom');
    if ('timebase' in source) normalized.timebase = rational(source.timebase, 'outputProfile.audioFrom.timebase');
    profile.audioFrom = normalized;
  } else if ('audioFrom' in profile) fail('只有 outputProfile.audio=external 时才能提供 audioFrom。');
  const timebase = rational(document.timelineTimebase ?? { num: profile.fps.den, den: profile.fps.num }, 'timelineTimebase');
  // ticks per output frame = 1 / (fps * timebase) must be an integer.
  const tickNum = profile.fps.den * timebase.den, tickDen = profile.fps.num * timebase.num;
  if (tickNum % tickDen !== 0) fail('timelineTimebase 必须能用整数刻度表示每个输出帧（例如 fps 24 对应 1/24 或 1/12288）。');
  const clipsIn = document.clips;
  if (!Array.isArray(clipsIn) || clipsIn.length < 1 || clipsIn.length > VIDEO_EDIT_MAX_CLIPS) fail(`clips 必须是 1–${VIDEO_EDIT_MAX_CLIPS} 个镜头的数组。`);
  const seen = new Set();
  const clips = clipsIn.map((clip, index) => {
    const path = `clips[${index}]`;
    keys(clip, ['id', 'inputSlot', 'sourceInPts', 'sourceOutPts', 'timebase', 'reverse', 'pad', 'muted', 'gain'], path, ['id', 'inputSlot', 'sourceInPts', 'sourceOutPts']);
    if (typeof clip.id !== 'string' || !CLIP_ID.test(clip.id) || seen.has(clip.id)) fail(`${path}.id 必须是唯一的 1–64 位字母数字标识。`);
    seen.add(clip.id);
    const item = { id: clip.id, inputSlot: slot(clip.inputSlot, `${path}.inputSlot`, VIDEO_EDIT_VIDEO_PORTS) };
    [item.sourceInPts, item.sourceOutPts] = range(clip, path);
    if ('timebase' in clip) item.timebase = rational(clip.timebase, `${path}.timebase`);
    item.reverse = bool(clip.reverse ?? false, `${path}.reverse`);
    const pad = clip.pad ?? { mode: 'none', count: 0 };
    keys(pad, ['mode', 'count'], `${path}.pad`, ['mode']);
    if (!['none', 'last_frame'].includes(pad.mode)) fail(`${path}.pad.mode 必须是 none 或 last_frame。`);
    const count = int(pad.count ?? 0, `${path}.pad.count`, 0, VIDEO_EDIT_MAX_PAD);
    if (pad.mode === 'none' && count) fail(`${path}.pad.mode=none 时 count 必须为 0。`);
    item.pad = { mode: pad.mode, count };
    item.muted = bool(clip.muted ?? false, `${path}.muted`);
    const gain = clip.gain ?? 1;
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 1) fail(`${path}.gain 必须是 0–1 的线性音量（1 为原音量）。`);
    item.gain = gain;
    return item;
  });
  return { schemaVersion: VIDEO_EDIT_SCHEMA_VERSION, timelineTimebase: timebase, outputProfile: profile, clips };
}

export function defaultVideoEditDocument() {
  // Valid placeholder: one clip on v1 (first second at 24 fps). The panel replaces
  // it with the probed source range once a video is connected.
  return { schemaVersion: 1, timelineTimebase: { num: 1, den: 24 }, outputProfile: { ...DEFAULT_PROFILE, fps: { num: 24, den: 1 } },
    clips: [{ id: 'clip1', inputSlot: 'v1', sourceInPts: 0, sourceOutPts: 24, timebase: { num: 1, den: 24 }, reverse: false, pad: { mode: 'none', count: 0 }, muted: false, gain: 1 }] };
}

export function usedVideoEditSlots(document) {
  const slots = new Set(document.clips.map((clip) => clip.inputSlot));
  if (document.outputProfile?.audio === 'external') slots.add(document.outputProfile.audioFrom.inputSlot);
  return VIDEO_EDIT_PORTS.filter((port) => slots.has(port));
}

// ---- time helpers (display only; never the source of truth)
export function ptsToSeconds(pts, timebase) { return (pts * timebase.num) / timebase.den; }
export function framesOf(clip, fps) {
  // Mirrors the Python grid: ceil(out*fps) - ceil(in*fps) when the clip has a timebase.
  if (!clip.timebase) return null;
  const at = (pts) => Math.ceil((pts * clip.timebase.num * fps.num) / (clip.timebase.den * fps.den) - 1e-9);
  return at(clip.sourceOutPts) - at(clip.sourceInPts) + (clip.pad?.mode === 'last_frame' ? clip.pad.count : 0);
}
export function timecode(frames, fps) {
  const rate = fps.num / fps.den, whole = Math.round(rate);
  const seconds = Math.floor(frames / rate), frame = frames - Math.round(seconds * rate);
  const hh = Math.floor(seconds / 3600), mm = Math.floor(seconds / 60) % 60, ss = seconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(Math.max(0, Math.min(whole - 1, frame))).padStart(2, '0')}`;
}
export function reducedTimebase(rationalValue) {
  const divisor = gcd(rationalValue.num, rationalValue.den);
  return { num: rationalValue.num / divisor, den: rationalValue.den / divisor };
}

// ---- graph helpers
export const videoEditInputEdges = (id, edges) => edges.filter((edge) => edge.target === id && VIDEO_EDIT_PORTS.includes(edge.targetHandle));


// Resolve the connected inputs to project asset paths. Generated results that only
// exist in ComfyUI output are "pending" until the page imports them (cached on the
// edit node by source id + url, so the source node itself is never modified).
export function videoEditInputs(id, nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cache = byId.get(id)?.data.editInputCache || {};
  const inputs = {}, pending = {}, sources = {};
  for (const edge of videoEditInputEdges(id, edges)) {
    const source = byId.get(edge.source);
    if (!source) continue;
    sources[edge.targetHandle] = source;
    const resolved = videoStreamAsset(source, cache);
    if (resolved.needsExport) throw new Error(`请先导出上游「${resolved.needsExport}」。`);
    if (resolved.assetPath) inputs[edge.targetHandle] = resolved.assetPath;
    else if (resolved.pendingUrl) pending[edge.targetHandle] = resolved.pendingUrl;
    else throw new Error(`「${resolved.missing || edge.targetHandle}」还没有可用的视频文件。`);
  }
  return { inputs, pending, sources };
}

// Display view of connected inputs (never throws; used by the node and panel).
export function videoEditInputView(id, nodes, edges, assetUrl) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cache = byId.get(id)?.data.editInputCache || {};
  const view = {};
  for (const edge of videoEditInputEdges(id, edges)) {
    const source = byId.get(edge.source);
    if (!source) continue;
    const assetPath = videoStreamAsset(source, cache).assetPath || null;
    view[edge.targetHandle] = { nodeId: source.id, title: source.data.title || edge.targetHandle, kind: isVideoProcessor(source) ? 'video' : source.data.kind,
      assetPath, url: assetPath ? assetUrl(assetPath) : source.data.url || null };
  }
  return view;
}

export function nextVideoEditPort(target, source, edges) {
  if (videoStreamKind(source) === 'audio') return 'a1';
  const used = new Set(videoEditInputEdges(target.id, edges).map((edge) => edge.targetHandle));
  return VIDEO_EDIT_VIDEO_PORTS.find((port) => !used.has(port)) || 'v1';
}

export function planVideoEditConnection(connection, source, target, nodes, edges) {
  const fail = (error) => ({ error });
  const port = connection.targetHandle;
  if (!VIDEO_EDIT_PORTS.includes(port)) return fail('视频编辑只接受 v1–v8 视频端口和 a1 音频端口。');
  const kind = videoStreamKind(source);
  if (port === 'a1' ? !['audio', 'video'].includes(kind) : kind !== 'video') return fail(port === 'a1' ? 'a1 只接受音频或带声音的视频。' : '视频端口只接受视频素材、视频编辑或其他视频处理节点。');
  if (videoProcessorCycle(source.id, target.id, edges)) return fail('视频编辑连线不能形成循环。');
  const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: port };
  const existing = edges.find((edge) => Object.entries(normalized).every(([key, value]) => edge[key] === value));
  return { connection: normalized, source, target, multiple: false, existing };
}

export function videoEditSummary(data = {}) {
  const document = data.editDocument;
  return {
    editDocument: document || null,
    clipCount: Array.isArray(document?.clips) ? document.clips.length : 0,
    editResultAssetPath: data.editResultAssetPath || null,
    editResult: data.editResult || null,
    videoEditJobId: data.videoEditJobId || null,
    editStale: Boolean(data.editResultAssetPath && data.editResultDocument !== JSON.stringify(document ?? null)),
  };
}
