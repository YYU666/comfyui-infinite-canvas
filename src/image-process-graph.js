import { normalizeAdjustments, normalizeBlendSettings, normalizeHslSettings, normalizeLevelsSettings } from './image-compositing.js';
import { DEFAULT_PHOTO_SETTINGS, normalizePhotoAdjustment } from './photo-adjustments.js';
import { CHANNEL_KEYS, normalizeChannelPackSettings } from './channel-packing.js';

export const IMAGE_PROCESS_MODES = ['colorAdjust', 'imageBlend', 'channelPack'];
export const isImageProcess = (node) => node?.type === 'imageProcess';
export const imageProcessPorts = (mode) => mode === 'channelPack' ? CHANNEL_KEYS : mode === 'imageBlend' ? ['base', 'overlay', 'mask'] : ['guide'];

export function imageProcessSettings(data) {
  if (data.mode === 'channelPack') return normalizeChannelPackSettings(data);
  return data.mode === 'imageBlend'
    ? { ...normalizeBlendSettings({ mode: data.blendMode, opacity: data.opacity, maskChannel: data.maskChannel, maskInvert: data.maskInvert }), fit: ['cover', 'contain', 'stretch'].includes(data.fit) ? data.fit : 'cover' }
    : data.adjustmentType === 'hsl' ? normalizeHslSettings(data) : data.adjustmentType === 'levels' ? normalizeLevelsSettings(data) : Object.hasOwn(DEFAULT_PHOTO_SETTINGS, data.adjustmentType) ? normalizePhotoAdjustment(data) : normalizeAdjustments(data);
}

export function imageProcessSnapshot(id, nodes, edges) {
  // Index and memoize only this read: sharing a source across RGBA ports must
  // not expand it four times per level, and later edits must never reuse a cache.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge);
  }
  const visiting = new Set();
  const memo = new Map();
  const read = (nodeId) => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    const node = byId.get(nodeId);
    if (!isImageProcess(node)) throw new Error('找不到图片处理节点。');
    if (visiting.has(nodeId)) throw new Error('图片处理连线不能形成循环。');
    visiting.add(nodeId);
    const refs = (incoming.get(nodeId) || []).filter((edge) => imageProcessPorts(node.data.mode).includes(edge.targetHandle)).map((edge) => {
      const source = byId.get(edge.source);
      if (!source) throw new Error('输入图片节点不存在。');
      if (isImageProcess(source)) {
        const upstream = read(source.id);
        if (!source.data.processedAssetPath || source.data.processedSignature !== upstream.signature) throw new Error(`请先重新输出「${source.data.title || '上游处理节点'}」。`);
        return { ...source, data: { kind: 'image', title: source.data.title, slot: edge.targetHandle, assetPath: source.data.processedAssetPath, url: source.data.processedUrl, rawAssetPath: source.data.processedTgaAssetPath || null } };
      }
      if (source.type !== 'media' || source.data.kind !== 'image') throw new Error('处理节点只接受图片输入。');
      return { ...source, data: { ...source.data, slot: edge.targetHandle, rawAssetPath: source.data.tgaAssetPath || null } };
    }).sort((a, b) => a.data.slot.localeCompare(b.data.slot));
    if (node.data.mode === 'channelPack' && !refs.length) throw new Error('请至少连接一张通道贴图，其余通道使用常量。');
    const required = node.data.mode === 'channelPack' ? [] : node.data.mode === 'imageBlend' ? ['base', 'overlay'] : ['guide'];
    for (const slot of required) if (!refs.some((ref) => ref.data.slot === slot)) throw new Error(slot === 'base' ? '请连接底图。' : slot === 'overlay' ? '请连接叠加图。' : '请连接要调色的图片。');
    const settings = imageProcessSettings(node.data);
    // Preserve existing blend signatures when new options retain their defaults.
    const signatureSettings = { ...settings };
    if (node.data.mode === 'imageBlend') {
      if (signatureSettings.maskChannel === 'luminance') delete signatureSettings.maskChannel;
      if (!signatureSettings.maskInvert) delete signatureSettings.maskInvert;
    }
    const signature = JSON.stringify([node.data.mode, signatureSettings, refs.map((ref) => [ref.id, ref.data.slot, ref.data.assetPath || ref.data.url || ref.data.remoteName || '', ...(node.data.mode === 'channelPack' && ref.data.rawAssetPath ? [ref.data.rawAssetPath] : [])])]);
    const snapshot = { node, refs, settings, signature };
    visiting.delete(nodeId);
    memo.set(nodeId, snapshot);
    return snapshot;
  };
  return read(id);
}

export function acceptsImageProcessConnection(connection, nodes, edges) {
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!isImageProcess(target) || !imageProcessPorts(target.data.mode).includes(connection.targetHandle)) return false;
  if (!(source?.type === 'media' && source.data.kind === 'image') && !isImageProcess(source)) return false;
  const queue = [target.id];
  const seen = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (current === source.id) return false;
    if (seen.has(current)) continue;
    seen.add(current);
    edges.filter((edge) => edge.source === current).forEach((edge) => queue.push(edge.target));
  }
  return true;
}
