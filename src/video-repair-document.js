import { videoProcessorCycle, videoStreamAsset, videoStreamKind } from './video-stream.js';

export const REPAIR_PORT = 'video';
export const REPAIR_FIELDS = ['repairSettings', 'previewTime'];
export const REPAIR_PREVIEW_MODES = ['original', 'mask', 'repaired'];
export const isVideoRepair = (node) => node?.type === 'videoLocalRepair';

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} 含无效字段。`);
}
function number(value, low, high, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new Error(`${label} 必须在 ${low}–${high} 之间。`);
  return value;
}
export function normalizeRepairDocument(value = {}) {
  object(value, ['schemaVersion', 'rect', 'start', 'end'], 'repairSettings');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('schemaVersion 必须为 1。');
  const rect = value.rect ?? { x: 0.75, y: 0.9, width: 0.2, height: 0.06 };
  object(rect, ['x', 'y', 'width', 'height'], 'rect');
  const x = number(rect.x, 0, 1, 'x'), y = number(rect.y, 0, 1, 'y');
  const width = number(rect.width, Number.EPSILON, 0.5, 'width'), height = number(rect.height, Number.EPSILON, 0.5, 'height');
  if (x + width > 1 || y + height > 1 || width * height > 0.15) throw new Error('矩形必须在画面内，面积不超过 15%。实际像素边缘须留至少 2 px，后台会核验。');
  const start = number(value.start ?? 0, 0, 120, 'start');
  const end = value.end == null ? null : number(value.end, 0, 120, 'end');
  if (end !== null && end <= start) throw new Error('结束时间必须大于开始时间。');
  return { schemaVersion: 1, rect: { x, y, width, height }, start, end };
}
export const normalizeRepairPreviewTime = (value = 0) => number(value, 0, 120, 'previewTime');
export const defaultRepairSettings = () => ({ repairSettings: normalizeRepairDocument(), previewTime: 0 });
export const repairDocumentFromNode = (data = {}) => normalizeRepairDocument(data.repairSettings);
export function repairSourceSignature(id, nodes, edges, seen = new Set()) {
  if (seen.has(id)) return null;
  const nextSeen = new Set(seen).add(id);
  const edge = edges.find(item => item.target === id && item.targetHandle === REPAIR_PORT);
  const source = nodes.find(item => item.id === edge?.source);
  if (!source) return null;
  const resolved = videoStreamAsset(source, {}, { nodes, edges, seen: nextSeen });
  if (resolved.needsExport) return null;
  return JSON.stringify([source.id, resolved.assetPath || source.data?.url || null]);
}
export function videoRepairSummary(data = {}, context = {}) {
  let settings = null;
  try { settings = repairDocumentFromNode(data); } catch { /* Invalid drafts are visible and cannot run. */ }
  const sourceSignature = 'sourceSignature' in context ? context.sourceSignature
    : context.nodes && context.edges && context.nodeId ? repairSourceSignature(context.nodeId, context.nodes, context.edges, context.seen) : null;
  const stale = Boolean(data.repairResultAssetPath && (!settings || JSON.stringify(settings) !== data.repairResultSettings || !sourceSignature || sourceSignature !== data.repairResultSource));
  return {
    repairSettings: settings, previewTime: data.previewTime ?? 0,
    repairResultAssetPath: data.repairResultAssetPath || null,
    repairResult: data.repairResult || null, repairJobId: data.repairJobId || null,
    repairStale: stale,
    repairResultCurrent: Boolean(data.repairResultAssetPath && !stale),
  };
}
export function planVideoRepairConnection(connection, source, target, nodes, edges) {
  if (connection.targetHandle !== REPAIR_PORT) return { error: '局部修复只有 video 视频输入。' };
  if (videoStreamKind(source) !== 'video') return { error: '局部修复只接受视频素材或已导出的视频处理成片。' };
  if (videoProcessorCycle(source.id, target.id, edges)) return { error: '局部修复连线不能形成循环。' };
  const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: REPAIR_PORT };
  return { connection: normalized, source, target, multiple: false, existing: edges.find(edge => Object.entries(normalized).every(([key, value]) => edge[key] === value)) };
}
