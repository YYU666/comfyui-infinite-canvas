// Video rhythm settings. Mirrors video_rhythm_document.py.
// The agent and the node UI edit the same fields: `speed` or `remapKeyframes`.
import { videoProcessorCycle, videoStreamKind } from './video-stream.js';

export const RHYTHM_SCHEMA_VERSION = 1;
export const RHYTHM_INTERPOLATION = ['linear', 'easeIn', 'easeOut', 'easeInOut'];
export const RHYTHM_AUDIO = ['preserve', 'stretch', 'mute'];
export const RHYTHM_PORT = 'v1';
const MAX_KEYS = 64;
const MAX_SECONDS = 600;

function fail(message) { throw new Error(message); }
function keys(value, allowed, path, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} 必须是对象。`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) fail(`${path} 含不支持的字段：${unknown.join(', ')}。`);
  const missing = required.filter((key) => !(key in value));
  if (missing.length) fail(`${path} 缺少字段：${missing.join(', ')}。`);
}
function speedValue(value, path = 'speed') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 4) fail(`${path} 必须在 0.25–4 之间（0.5 为两倍慢放 / 升格，2 为两倍快放）。`);
  return value;
}
function seconds(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) fail(`${path} 必须是 0–${MAX_SECONDS} 的有限秒数。`);
  const milliseconds = Math.round(value * 1000);
  if (Math.abs(milliseconds / 1000 - value) > 1e-6) fail(`${path} 只精确到毫秒。`);
  return milliseconds / 1000;
}
function interpolation(value, path) {
  if (!RHYTHM_INTERPOLATION.includes(value)) fail(`${path} 必须是 linear、easeIn、easeOut 或 easeInOut。`);
  return value;
}

export function normalizeSpeedDocument(document) {
  keys(document, ['schemaVersion', 'operation', 'speed', 'audio'], 'speedDocument', ['schemaVersion', 'speed']);
  if (document.schemaVersion !== RHYTHM_SCHEMA_VERSION) fail('speedDocument.schemaVersion 必须为 1。');
  if ('operation' in document && document.operation !== 'speed') fail('speedDocument.operation 必须是 speed。');
  const speed = speedValue(document.speed);
  const rate = rationalSpeed(speed);
  return { schemaVersion: RHYTHM_SCHEMA_VERSION, operation: 'speed', speed: rate, audio: RHYTHM_AUDIO.includes(document.audio ?? 'preserve') ? (document.audio ?? 'preserve') : fail('audio 必须是 preserve、stretch 或 mute。') };
}

function rationalSpeed(value) {
  // Match Python Fraction(value).limit_denominator(1000) for common rates.
  const den = 1000;
  let best = { num: Math.round(value), den: 1, error: Math.abs(value - Math.round(value)) };
  for (let candidate = 1; candidate <= den; candidate += 1) {
    const num = Math.round(value * candidate);
    const error = Math.abs(value - num / candidate);
    if (error < best.error) best = { num, den: candidate, error };
  }
  if (best.error > 1e-6) fail('speed 无法表示为精确倍率。');
  const divisor = gcd(best.num, best.den);
  return { num: best.num / divisor, den: best.den / divisor };
}
const gcd = (a, b) => { let x = Math.abs(a), y = Math.abs(b); while (y) [x, y] = [y, x % y]; return x || 1; };

export function normalizeRemapDocument(document) {
  keys(document, ['schemaVersion', 'operation', 'keyframes'], 'remapDocument', ['schemaVersion', 'keyframes']);
  if (document.schemaVersion !== RHYTHM_SCHEMA_VERSION) fail('remapDocument.schemaVersion 必须为 1。');
  if ('operation' in document && document.operation !== 'remap') fail('remapDocument.operation 必须是 remap。');
  return { schemaVersion: RHYTHM_SCHEMA_VERSION, operation: 'remap', keyframes: normalizeRemapKeyframes(document.keyframes) };
}

export function normalizeRemapKeyframes(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > MAX_KEYS) fail(`keyframes 必须是 2–${MAX_KEYS} 个关键帧。`);
  const keyframes = [];
  rows.forEach((row, index) => {
    const path = `keyframes[${index}]`;
    keys(row, ['output', 'source', 'interpolation'], path, ['output', 'source']);
    const item = {
      output: seconds(row.output, `${path}.output`),
      source: seconds(row.source, `${path}.source`),
      interpolation: interpolation(row.interpolation ?? 'linear', `${path}.interpolation`),
    };
    if (keyframes.length && item.output <= keyframes.at(-1).output) fail(`${path}.output 必须严格递增（成片时间轴）。`);
    if (keyframes.length && item.source < keyframes.at(-1).source) fail(`${path}.source 不能回退；倒放请用视频编辑节点。`);
    keyframes.push(item);
  });
  if (keyframes[0].output !== 0) fail('第一个关键帧的 output 必须是 0。');
  return keyframes;
}

export function defaultSpeedSettings() {
  return { speed: 0.5, rhythmAudio: 'preserve' };
}

// Realtime 1 second. The freeze example is `freezeAt` / the docs, not the default,
// so a short source can still export.
export function defaultRemapKeyframes() {
  return [
    { output: 0, source: 0, interpolation: 'linear' },
    { output: 1, source: 1, interpolation: 'linear' },
  ];
}

// Hold source time `at` for `hold` seconds of output, after playing 1:1 up to `at`.
export function freezeAt(at = 2, hold = 1) {
  return normalizeRemapKeyframes([
    { output: 0, source: 0, interpolation: 'linear' },
    { output: at, source: at, interpolation: 'linear' },
    { output: at + hold, source: at, interpolation: 'linear' },
  ]);
}

export function speedFrameCount(frameCount, speed) {
  const rate = rationalSpeed(speedValue(speed));
  return Math.max(1, Math.round(frameCount * rate.den / rate.num));
}

function ease(amount, kind) {
  if (kind === 'linear') return amount;
  if (kind === 'easeIn') return amount * amount;
  if (kind === 'easeOut') return 1 - (1 - amount) ** 2;
  if (kind === 'easeInOut') return amount * amount * (3 - 2 * amount);
  fail('不支持的插值。');
}

export function sampleSourceTime(keyframes, outputTime) {
  const rows = normalizeRemapKeyframes(keyframes);
  if (outputTime <= rows[0].output) return rows[0].source;
  if (outputTime >= rows.at(-1).output) return rows.at(-1).source;
  for (let index = 0; index < rows.length - 1; index += 1) {
    const start = rows[index], end = rows[index + 1];
    if (outputTime < start.output || outputTime > end.output) continue;
    if (end.output === start.output || end.source === start.source) return start.source;
    const amount = (outputTime - start.output) / (end.output - start.output);
    if (start.interpolation === 'linear') return start.source + (end.source - start.source) * amount;
    return start.source + (end.source - start.source) * ease(amount, start.interpolation);
  }
  return rows.at(-1).source;
}

export function isVideoRhythm(node) {
  return node?.type === 'videoSpeed' || node?.type === 'videoTimeRemap';
}

export function planVideoRhythmConnection(connection, source, target, nodes, edges) {
  const failPlan = (error) => ({ error });
  if (connection.targetHandle !== RHYTHM_PORT) return failPlan('视频节奏节点只有一个视频输入 v1。');
  const kind = videoStreamKind(source);
  if (kind !== 'video') return failPlan('视频节奏节点只接受一段视频（素材、视频编辑或其他节奏节点的成片）。');
  if (videoProcessorCycle(source.id, target.id, edges)) return failPlan('视频节奏连线不能形成循环。');
  const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: RHYTHM_PORT };
  const existing = edges.find((edge) => Object.entries(normalized).every(([key, value]) => edge[key] === value));
  return { connection: normalized, source, target, multiple: false, existing };
}

export function videoRhythmSummary(data = {}, type = '') {
  let canonical = null;
  try {
    canonical = JSON.stringify(type === 'videoSpeed'
      ? normalizeSpeedDocument({ schemaVersion: 1, speed: data.speed, audio: data.rhythmAudio })
      : normalizeRemapDocument({ schemaVersion: 1, keyframes: data.remapKeyframes }));
  } catch { canonical = null; }
  return {
    ...(type === 'videoSpeed' ? { speed: data.speed ?? null, rhythmAudio: data.rhythmAudio || 'preserve' } : {}),
    ...(type === 'videoTimeRemap' ? { remapKeyframes: data.remapKeyframes || null } : {}),
    rhythmResultAssetPath: data.rhythmResultAssetPath || null,
    rhythmResult: data.rhythmResult || null,
    rhythmJobId: data.rhythmJobId || null,
    rhythmStale: Boolean(data.rhythmResultAssetPath && canonical && data.rhythmResultSettings !== canonical),
  };
}
