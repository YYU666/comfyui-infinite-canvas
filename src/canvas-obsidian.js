const imageTools = new Set(['characterSheet', 'identityEdit', 'outfitEdit', 'localRealism', 'qwenEdit', 'imageUpscale', 'mossPose']);
const videoTools = new Set(['videoEdit', 'videoSpeed', 'videoTimeRemap', 'videoChromaKey', 'videoWhitePlate', 'videoLocalRepair']);
const colors = {
  gold: '#e5b869', jade: '#4fd6b5', coral: '#e88b5a', violet: '#9d8bff', pearl: '#e6ddc7',
};

export function canvasNodeModality(type, data = {}) {
  if (type === 'native3d' || data.kind === 'model') return 'jade';
  if (type === 'media' && ['video', 'audio'].includes(data.kind)) return 'coral';
  if (videoTools.has(type) || type === 'video' || type === 'audio') return 'coral';
  if (type === 'imageProcess' || type === 'spriteAtlas' || data.mediaRole === 'mask') return 'violet';
  if (type === 'note' && data.noteRole === 'videoDownload') return 'coral';
  if (type === 'generator') {
    if (data.mode === 'image') return 'gold';
    if (imageTools.has(data.mode)) return 'violet';
    if (data.mode === 'customWorkflow') {
      const output = data.workflowDefinition?.outputs?.[0]?.type;
      return ({ image: 'gold', model: 'jade', video: 'coral', audio: 'coral' })[output] || 'violet';
    }
    return 'coral';
  }
  return 'gold';
}

function portTone(node, handle, direction) {
  const { type, data = {} } = node || {};
  if (handle === 'prompt' || type === 'prompt') return 'gold';
  if (handle === 'model' || (type === 'native3d' && ['plan', 'high', 'provenance'].includes(handle))) return 'jade';
  if (type === 'native3d' && ['reference', 'diagnostic'].includes(handle)) return 'pearl';
  if (handle === 'video' || handle === 'audio') return 'coral';
  if (handle === 'image' || handle === 'mask') return 'pearl';
  if (type === 'generator' && direction === 'target') {
    if (handle === 'guide' && ['swap', 'upscale', 'videoSuperResolution'].includes(data.mode)) return 'coral';
    return 'pearl';
  }
  if (type === 'videoChromaKey' && handle === 'bg') return 'pearl';
  if ((type === 'media' && data.kind === 'image') || ['imageProcess', 'artDirector', 'spriteAtlas'].includes(type)) return 'pearl';
  return node ? canvasNodeModality(type, data) : 'pearl';
}

export function canvasNodeStatus(type, data = {}) {
  const status = type === 'note' && data.noteRole === 'videoDownload'
    ? data.downloadStatus : data.status;
  if (['failed', 'error'].includes(status)) return { tone: 'error', label: '失败' };
  if (status === 'queued') return { tone: 'queued', label: '排队中' };
  if (['uploading', 'running', 'finishing', 'optimizing', 'downloading'].includes(status)) {
    const label = ({ uploading: '导入中', optimizing: '优化中', finishing: '保存中', downloading: '下载中' })[status] || '处理中';
    return { tone: 'running', label };
  }
  if (status === 'stale' || data.artDirectorStale) return { tone: 'stale', label: '待更新' };
  if (status === 'cancelled') return { tone: 'cancelled', label: '已取消' };
  if (status === 'done' || status === 'completed') return { tone: 'done', label: '已完成' };
  if (type === 'media' && data.assetPath && data.url) return { tone: 'done', label: '已保存' };
  return { tone: 'idle', label: '' };
}

const CONNECTED_FIELDS = ['assetPath', 'url', 'title', 'kind', 'name', 'posterAssetPath', 'mediaRole', 'status', 'resultUrl', 'resultAssetPath'];

export function connectedGraphStamp(nodeId, edges = [], nodeLookup) {
  let stamp = '';
  for (const edge of edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const otherId = edge.source === nodeId ? edge.target : edge.source;
    const other = nodeLookup?.get?.(otherId);
    const data = other?.data || {};
    stamp += `${edge.id}\0${edge.source}\0${edge.target}\0${edge.sourceHandle || ''}\0${edge.targetHandle || ''}\0${other?.type || ''}`;
    for (const field of CONNECTED_FIELDS) stamp += `\0${data[field] || ''}`;
    stamp += '\n';
  }
  return stamp;
}

export function canvasEdgeLook(source, sourceHandle, target, targetHandle) {
  const from = portTone(source, sourceHandle, 'source');
  const mixedReference = target?.type === 'generator' && targetHandle === 'references'
    && (!target.data?.mode || target.data.mode === 'reference');
  const to = mixedReference ? from : portTone(target, targetHandle, 'target');
  return {
    from: colors[from],
    to: colors[to],
    linked: Boolean(source?.selected || target?.selected),
    activeEndpoint: canvasNodeStatus(source?.type, source?.data).tone === 'running'
      || canvasNodeStatus(target?.type, target?.data).tone === 'running',
  };
}
