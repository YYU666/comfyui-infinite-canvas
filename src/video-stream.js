// Shared connection helpers for the independently shipped video processors.
export const isVideoEditNode = node => node?.type === 'videoEdit';
export const isVideoRhythmNode = node => ['videoSpeed', 'videoTimeRemap'].includes(node?.type);
export const isVideoProcessor = node => isVideoEditNode(node) || isVideoRhythmNode(node);

export function videoStreamKind(source) {
  if (isVideoProcessor(source)) return 'video';
  return source?.type === 'media' ? source.data?.kind || null : null;
}

export function videoStreamAsset(source, cache = {}) {
  if (isVideoRhythmNode(source)) return source.data?.rhythmResultAssetPath ? { assetPath: source.data.rhythmResultAssetPath } : { needsExport: source.data?.title || '视频节奏' };
  if (isVideoEditNode(source)) return source.data?.editResultAssetPath
    ? { assetPath: source.data.editResultAssetPath }
    : { needsExport: source.data?.title || '视频编辑' };
  if (source?.data?.assetPath) return { assetPath: source.data.assetPath };
  if (source?.data?.url && cache[source.id]?.url === source.data.url) return { assetPath: cache[source.id].assetPath };
  if (source?.data?.url) return { pendingUrl: source };
  return { missing: source?.data?.title || '输入' };
}

export function videoProcessorCycle(sourceId, targetId, edges) {
  const queue = [targetId], seen = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (current === sourceId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.source === current) queue.push(edge.target);
  }
  return false;
}
