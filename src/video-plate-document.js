// Settings for the green-screen white-model plate. Same fields as video_plate_document.py.
import { videoProcessorCycle, videoStreamKind } from './video-stream.js';

export const PLATE_PORT = 'v1';
export const PLATE_FIELDS = ['keepPrompts', 'maskGrow', 'maskFeather', 'shadeMode', 'greenColor'];
export const PLATE_SHADES = ['flat', 'shaded'];
const PROMPT = /^[A-Za-z0-9 ._\-\u4e00-\u9fff]{1,40}$/u;
const COLOR = /^#[0-9A-F]{6}$/;

export class PlateDocumentError extends Error {}

function fail(message) {
  throw new PlateDocumentError(message);
}

function whole(value, name, low, high) {
  if (!Number.isInteger(value) || value < low || value > high) fail(`${name} 必须是 ${low}–${high} 的整数。`);
  return value;
}

function color(value) {
  if (typeof value !== 'string') fail('greenColor 必须是 #RRGGBB。');
  const text = value.toUpperCase();
  if (!COLOR.test(text)) fail('greenColor 必须是 #RRGGBB。');
  return text;
}

function prompts(value) {
  const source = value === undefined ? ['person', 'pole'] : value;
  const parts = typeof source === 'string'
    ? source.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
    : source;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 4) fail('keepPrompts 需要 1–4 个文字提示，默认 person 与 pole。');
  const result = [];
  for (const item of parts) {
    if (typeof item !== 'string' || !PROMPT.test(item)) fail('keepPrompts 只接受字母、数字、空格、点、横线和中文，每项最多 40 字。');
    if (!result.includes(item)) result.push(item);
  }
  if (!result.length) fail('keepPrompts 至少要有一个提示词。');
  return result;
}

export function normalizePlateDocument(document = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) fail('plateDocument 必须是对象。');
  const allowed = new Set(['schemaVersion', ...PLATE_FIELDS]);
  const unknown = Object.keys(document).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail(`plateDocument 含有不支持的字段：${unknown.join(', ')}`);
  if ('schemaVersion' in document && document.schemaVersion !== 1) fail('plateDocument.schemaVersion 必须为 1。');
  const shade = document.shadeMode === undefined ? 'flat' : document.shadeMode;
  if (!PLATE_SHADES.includes(shade)) fail('shadeMode 只能是 flat 或 shaded。');
  return {
    schemaVersion: 1,
    keepPrompts: prompts(document.keepPrompts),
    maskGrow: whole(document.maskGrow === undefined ? 8 : document.maskGrow, 'maskGrow', 0, 64),
    maskFeather: whole(document.maskFeather === undefined ? 2 : document.maskFeather, 'maskFeather', 0, 32),
    shadeMode: shade,
    greenColor: color(document.greenColor === undefined ? '#00FF00' : document.greenColor),
  };
}

export function defaultPlateSettings() {
  const document = normalizePlateDocument({});
  return {
    keepPrompts: document.keepPrompts,
    maskGrow: document.maskGrow,
    maskFeather: document.maskFeather,
    shadeMode: document.shadeMode,
    greenColor: document.greenColor,
  };
}

export function plateDocumentFromNode(data = {}) {
  const draft = { schemaVersion: 1 };
  for (const key of PLATE_FIELDS) if (data[key] !== undefined) draft[key] = data[key];
  return normalizePlateDocument(draft);
}

export function isVideoPlate(node) {
  return node?.type === 'videoWhitePlate';
}

export function planVideoPlateConnection(connection, source, target, nodes, edges) {
  const failPlan = (error) => ({ error });
  if (connection.targetHandle !== PLATE_PORT) return failPlan('绿幕白模只有一个视频输入 v1。');
  if (videoStreamKind(source) !== 'video') return failPlan('绿幕白模只接受一段视频。');
  if (videoProcessorCycle(source.id, target.id, edges)) return failPlan('绿幕白模连线不能形成循环。');
  const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: PLATE_PORT };
  const existing = edges.find((edge) => Object.entries(normalized).every(([key, value]) => edge[key] === value));
  return { connection: normalized, source, target, multiple: false, existing };
}

function canonical(document) {
  return JSON.stringify({
    keepPrompts: document.keepPrompts,
    maskGrow: document.maskGrow,
    maskFeather: document.maskFeather,
    shadeMode: document.shadeMode,
    greenColor: document.greenColor,
  });
}

export function videoPlateSummary(data = {}) {
  let current = null;
  try { current = canonical(plateDocumentFromNode(data)); }
  catch { current = null; }
  let submitted = null;
  if (data.plateSubmittedSettings) {
    try { submitted = canonical(normalizePlateDocument(JSON.parse(data.plateSubmittedSettings))); }
    catch { submitted = data.plateSubmittedSettings; }
  }
  const defaults = defaultPlateSettings();
  return {
    keepPrompts: data.keepPrompts ?? defaults.keepPrompts,
    maskGrow: data.maskGrow ?? defaults.maskGrow,
    maskFeather: data.maskFeather ?? defaults.maskFeather,
    shadeMode: data.shadeMode || defaults.shadeMode,
    greenColor: data.greenColor ?? defaults.greenColor,
    plateResultAssetPath: data.plateResultAssetPath || null,
    plateResultNodeId: data.plateResultNodeId || null,
    plateJobId: data.plateJobId || null,
    plateResult: data.plateResult || null,
    plateStale: Boolean(data.plateResultAssetPath && current && submitted !== current),
  };
}
