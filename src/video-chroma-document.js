// Green-screen key settings. Mirrors video_chroma_document.py.
// The agent and the node UI edit the same fields.
import { videoProcessorCycle, videoStreamKind } from './video-stream.js';

export const CHROMA_SCHEMA_VERSION = 1;
export const CHROMA_ANCHORS = ['center', 'top', 'bottom', 'left', 'right', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
export const CHROMA_FITS = ['cover', 'contain', 'stretch'];
export const CHROMA_OUTPUT_SIZES = ['background', 'foreground'];
export const CHROMA_AUDIO = ['preserve', 'mute'];
export const CHROMA_PREVIEW_MODES = ['composite', 'matte', 'foreground'];
export const CHROMA_FG = 'fg';
export const CHROMA_BG = 'bg';
export const CHROMA_FIELDS = ['keyColor', 'similarity', 'blend', 'despill', 'choke', 'feather', 'secondKey', 'secondKeyColor', 'secondSimilarity', 'secondBlend', 'scale', 'offsetX', 'offsetY', 'anchor', 'backgroundFit', 'outputSize', 'chromaAudio', 'startOffset', 'previewTime'];

const DEFAULTS = {
  keyColor: '#00FF00',
  similarity: 0.2,
  blend: 0.08,
  despill: 0.5,
  choke: 0,
  feather: 0,
  secondKey: false,
  secondKeyColor: '#FFFFFF',
  secondSimilarity: 0.06,
  secondBlend: 0.02,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  anchor: 'center',
  backgroundFit: 'cover',
  outputSize: 'background',
  audio: 'preserve',
  startOffset: 0,
};
const ANCHOR_XY = {
  center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5],
  topLeft: [0, 0], topRight: [1, 0], bottomLeft: [0, 1], bottomRight: [1, 1],
};

function fail(message) { throw new Error(message); }
function keys(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} 必须是对象。`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) fail(`${path} 含不支持的字段：${unknown.join(', ')}。`);
}
function snap(value, path, low, high) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) fail(`${path} 必须在 ${low}–${high} 之间。`);
  const milli = Math.round(value * 1000);
  const snapped = milli / 1000;
  if (Math.abs(snapped - value) > 1e-6) fail(`${path} 只精确到 0.001。`);
  return snapped === Math.trunc(snapped) ? Math.trunc(snapped) : snapped;
}
function whole(value, path, low, high) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < low || value > high) fail(`${path} 必须是 ${low}–${high} 的整数。`);
  return value;
}
function color(value, path = 'keyColor') {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) fail(`${path} 必须是 #RRGGBB。`);
  return value.toUpperCase();
}
function choice(value, allowed, path) {
  if (!allowed.includes(value)) fail(`${path} 必须是 ${allowed.join('、')}。`);
  return value;
}
function flag(value, path) {
  if (typeof value !== 'boolean') fail(`${path} 必须是布尔值。`);
  return value;
}
export function spillType(keyColor) {
  const red = Number.parseInt(keyColor.slice(1, 3), 16);
  const green = Number.parseInt(keyColor.slice(3, 5), 16);
  const blue = Number.parseInt(keyColor.slice(5, 7), 16);
  return blue > green && blue >= red ? 'blue' : 'green';
}

export function normalizeChromaDocument(document = {}) {
  keys(document, ['schemaVersion', ...Object.keys(DEFAULTS)], 'chromaDocument');
  if ('schemaVersion' in document && document.schemaVersion !== CHROMA_SCHEMA_VERSION) fail('chromaDocument.schemaVersion 必须为 1。');
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (key in document) merged[key] = document[key];
  const keyColor = color(merged.keyColor);
  return {
    schemaVersion: CHROMA_SCHEMA_VERSION,
    keyColor,
    similarity: snap(merged.similarity, 'similarity', 0, 1),
    blend: snap(merged.blend, 'blend', 0, 1),
    despill: snap(merged.despill, 'despill', 0, 1),
    choke: whole(merged.choke, 'choke', 0, 8),
    feather: whole(merged.feather, 'feather', 0, 16),
    secondKey: flag(merged.secondKey, 'secondKey'),
    secondKeyColor: color(merged.secondKeyColor, 'secondKeyColor'),
    secondSimilarity: snap(merged.secondSimilarity, 'secondSimilarity', 0, 1),
    secondBlend: snap(merged.secondBlend, 'secondBlend', 0, 1),
    scale: snap(merged.scale, 'scale', 0.05, 8),
    offsetX: whole(merged.offsetX, 'offsetX', -4096, 4096),
    offsetY: whole(merged.offsetY, 'offsetY', -4096, 4096),
    anchor: choice(merged.anchor, CHROMA_ANCHORS, 'anchor'),
    backgroundFit: choice(merged.backgroundFit, CHROMA_FITS, 'backgroundFit'),
    outputSize: choice(merged.outputSize, CHROMA_OUTPUT_SIZES, 'outputSize'),
    audio: choice(merged.audio, CHROMA_AUDIO, 'audio'),
    startOffset: snap(merged.startOffset, 'startOffset', 0, 600),
    spill: spillType(keyColor),
  };
}

export function normalizePreviewTime(value) {
  if (value === undefined) return 0;
  return snap(value, 'previewTime', 0, 600);
}

export function defaultChromaSettings() {
  return {
    keyColor: '#00FF00', similarity: 0.2, blend: 0.08, despill: 0.5, choke: 0, feather: 0,
    secondKey: false, secondKeyColor: '#FFFFFF', secondSimilarity: 0.06, secondBlend: 0.02,
    scale: 1, offsetX: 0, offsetY: 0, anchor: 'center', backgroundFit: 'cover', outputSize: 'background',
    chromaAudio: 'preserve', startOffset: 0, previewTime: 0,
  };
}

export function chromaDocumentFromNode(data = {}) {
  const document = { schemaVersion: 1 };
  const pairs = {
    keyColor: data.keyColor, similarity: data.similarity, blend: data.blend, despill: data.despill,
    choke: data.choke, feather: data.feather,
    secondKey: data.secondKey, secondKeyColor: data.secondKeyColor, secondSimilarity: data.secondSimilarity, secondBlend: data.secondBlend,
    scale: data.scale, offsetX: data.offsetX, offsetY: data.offsetY,
    anchor: data.anchor, backgroundFit: data.backgroundFit, outputSize: data.outputSize,
    audio: data.chromaAudio, startOffset: data.startOffset,
  };
  for (const [key, value] of Object.entries(pairs)) if (value !== undefined) document[key] = value;
  return normalizeChromaDocument(document);
}

function evenSize(width, height, path) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) fail(`${path} 尺寸无效。`);
  const evenWidth = width - (width % 2);
  const evenHeight = height - (height % 2);
  if (evenWidth < 16 || evenHeight < 16 || evenWidth > 4096 || evenHeight > 4096) fail(`${path} 宽高取偶数后必须在 16–4096 之间。`);
  return [evenWidth, evenHeight];
}
function scaledEdge(pixels, scaleMilli) {
  let size = Math.floor((pixels * scaleMilli + 500) / 1000);
  size -= size % 2;
  if (size < 2) size = 2;
  if (size > 4096) fail('前景缩放后超过 4096。');
  return size;
}
function half(span) {
  if (span >= 0) return Math.floor((span + 1) / 2);
  return -Math.floor((-span + 1) / 2);
}
function anchorOffset(span, anchor) {
  if (anchor === 0) return 0;
  if (anchor === 1) return span;
  return half(span);
}

export function planPlacement(document, fgWidth, fgHeight, bgWidth, bgHeight) {
  const normalized = document?.spill ? document : normalizeChromaDocument(document);
  const [outW, outH] = normalized.outputSize === 'background' ? evenSize(bgWidth, bgHeight, '背景') : evenSize(fgWidth, fgHeight, '前景');
  const scaleMilli = Math.round(normalized.scale * 1000);
  const fgW = scaledEdge(fgWidth, scaleMilli);
  const fgH = scaledEdge(fgHeight, scaleMilli);
  const [ax, ay] = ANCHOR_XY[normalized.anchor];
  return {
    outputWidth: outW,
    outputHeight: outH,
    foregroundWidth: fgW,
    foregroundHeight: fgH,
    overlayX: anchorOffset(outW - fgW, ax) + normalized.offsetX,
    overlayY: anchorOffset(outH - fgH, ay) + normalized.offsetY,
  };
}

export function isVideoChroma(node) {
  return node?.type === 'videoChromaKey';
}

export function defaultChromaHandle(target, source, edges = []) {
  if (videoStreamKind(source) === 'image') return CHROMA_BG;
  const fgTaken = edges.some((edge) => edge.target === target.id && edge.targetHandle === CHROMA_FG);
  return fgTaken ? CHROMA_BG : CHROMA_FG;
}

export function planVideoChromaConnection(connection, source, target, nodes, edges) {
  const failPlan = (error) => ({ error });
  const port = connection.targetHandle;
  if (port !== CHROMA_FG && port !== CHROMA_BG) return failPlan('绿幕扣像合成只有前景 fg 和背景 bg 两个输入。');
  const kind = videoStreamKind(source);
  if (port === CHROMA_FG) {
    if (kind !== 'video') return failPlan('前景 fg 只接受绿幕视频（素材，或视频编辑、节奏、扣像节点的成片）。');
  } else if (kind !== 'image' && kind !== 'video') {
    return failPlan('背景 bg 只接受图片素材，或视频素材 / 视频处理成片。');
  }
  if (videoProcessorCycle(source.id, target.id, edges)) return failPlan('绿幕扣像连线不能形成循环。');
  const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: port };
  const existing = edges.find((edge) => Object.entries(normalized).every(([key, value]) => edge[key] === value));
  return { connection: normalized, source, target, multiple: false, existing };
}

function canonicalDocument(value) {
  try { return JSON.stringify(normalizeChromaDocument(value)); }
  catch { return null; }
}

export function videoChromaSummary(data = {}) {
  let canonical = null;
  try { canonical = canonicalDocument(chromaDocumentFromNode(data)); }
  catch { canonical = null; }
  let submitted = null;
  if (data.chromaResultSettings) {
    try { submitted = canonicalDocument(JSON.parse(data.chromaResultSettings)); }
    catch { submitted = data.chromaResultSettings; }
  }
  return {
    keyColor: data.keyColor ?? null,
    similarity: data.similarity ?? null,
    blend: data.blend ?? null,
    despill: data.despill ?? null,
    choke: data.choke ?? null,
    feather: data.feather ?? null,
    secondKey: data.secondKey ?? false,
    secondKeyColor: data.secondKeyColor ?? '#FFFFFF',
    secondSimilarity: data.secondSimilarity ?? 0.06,
    secondBlend: data.secondBlend ?? 0.02,
    scale: data.scale ?? null,
    offsetX: data.offsetX ?? null,
    offsetY: data.offsetY ?? null,
    anchor: data.anchor || 'center',
    backgroundFit: data.backgroundFit || 'cover',
    outputSize: data.outputSize || 'background',
    chromaAudio: data.chromaAudio || 'preserve',
    startOffset: data.startOffset ?? 0,
    previewTime: data.previewTime ?? 0,
    chromaResultAssetPath: data.chromaResultAssetPath || null,
    chromaResult: data.chromaResult || null,
    chromaJobId: data.chromaJobId || null,
    chromaStale: Boolean(data.chromaResultAssetPath && canonical && submitted !== canonical),
  };
}
