// Paint node document: paper, layers, signatures, and connection rules.
// Pixel buffers stay out of project.json; only asset paths are persisted.

export const MAX_LAYERS = 12;
export const HISTORY_LIMIT = 40;
export const MIN_PAPER = 64;
export const MAX_PAPER = 4096;
export const LAYER_LIMIT_MESSAGE = '已达单节点 12 层上限，请向下合并图层或新建下一个绘画节点继续';

export const PAPER_PRESETS = [
  { id: '1024', width: 1024, height: 1024, label: '1024×1024' },
  { id: '720p', width: 1280, height: 720, label: '1280×720' },
  { id: '1080p', width: 1920, height: 1080, label: '1920×1080' },
  { id: 'portrait', width: 720, height: 1280, label: '720×1280' },
  { id: '1200', width: 1200, height: 900, label: '1200×900' },
  { id: '2048', width: 2048, height: 2048, label: '2048×2048' },
];

export const BACKGROUNDS = ['transparent', 'white', 'warm', 'dark'];
export const TEXTURES = ['none', 'sketch', 'watercolor'];
export const GUIDES = ['none', 'thirds', 'grid', 'story-2x2', 'story-3x2'];
export const OUTPUT_MODES = ['transparent', 'composite', 'mask'];
export const LAYER_BLEND_MODES = ['normal', 'multiply', 'screen', 'add', 'overlay', 'soft-light'];
export const OUTPUT_MODE_LABELS = { transparent: '透明层', composite: '合并成图', mask: '黑白遮罩' };

// Phase-2 extension slots. This release stores them and does not interpret them.
export const PAINT_EXTENSIONS = { symmetry: null, perspective: null, annotation: null, timelapse: null };

const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
};

export function normalizeOpacity(value, fallback = 100) {
  return clampInt(value, 0, 100, fallback);
}

export function normalizeBlendMode(mode) {
  return LAYER_BLEND_MODES.includes(mode) ? mode : 'normal';
}

export function clampPaperSize(width, height, fallbackW = 1280, fallbackH = 720) {
  return {
    width: clampInt(width, MIN_PAPER, MAX_PAPER, fallbackW),
    height: clampInt(height, MIN_PAPER, MAX_PAPER, fallbackH),
  };
}

export function matchBaseSize(width, height) {
  const safeW = Math.max(1, Math.round(Number(width) || 1));
  const safeH = Math.max(1, Math.round(Number(height) || 1));
  const longEdge = Math.max(safeW, safeH);
  const scale = longEdge > MAX_PAPER ? MAX_PAPER / longEdge : 1;
  return clampPaperSize(safeW * scale, safeH * scale, safeW, safeH);
}

export function normalizePaper(paper = {}) {
  const size = clampPaperSize(paper.width, paper.height);
  return {
    width: size.width,
    height: size.height,
    background: BACKGROUNDS.includes(paper.background) ? paper.background : 'transparent',
    texture: TEXTURES.includes(paper.texture) ? paper.texture : 'none',
    textureOpacity: normalizeOpacity(paper.textureOpacity, 20),
    textureInOutput: paper.textureInOutput === true,
    guideGrid: GUIDES.includes(paper.guideGrid) ? paper.guideGrid : 'none',
  };
}

export function createLayer(index = 1, id = `layer-${index}`) {
  return {
    id: String(id),
    name: `图层 ${index}`,
    visible: true,
    opacity: 100,
    blendMode: 'normal',
    alphaLock: false,
    clippingMask: false,
    assetPath: '',
    url: '',
  };
}

export function normalizeLayer(layer = {}, index = 1) {
  const id = typeof layer.id === 'string' && layer.id && !layer.id.includes('/') && !layer.id.includes('..')
    ? layer.id.slice(0, 64) : `layer-${index}`;
  return {
    id,
    name: typeof layer.name === 'string' && layer.name.trim() ? layer.name.trim().slice(0, 40) : `图层 ${index}`,
    visible: layer.visible !== false,
    opacity: normalizeOpacity(layer.opacity),
    blendMode: normalizeBlendMode(layer.blendMode),
    alphaLock: layer.alphaLock === true,
    clippingMask: layer.clippingMask === true,
    assetPath: typeof layer.assetPath === 'string' && layer.assetPath.startsWith('assets/') ? layer.assetPath : '',
    url: typeof layer.url === 'string' ? layer.url : '',
  };
}

export function createPaintData(extra = {}) {
  const base = {
    title: '绘画节点',
    paper: normalizePaper(),
    outputMode: 'transparent',
    maskOverlayColor: 'rgba(255, 48, 56, 0.5)',
    baseOverlay: { visible: true, opacity: 55, position: 'below' },
    activeLayerId: 'layer-1',
    layers: [createLayer(1, 'layer-1')],
    assetPath: '',
    url: '',
    paintSignature: '',
    touched: false,
    swatches: [],
    extensions: { ...PAINT_EXTENSIONS },
  };
  return normalizePaintData({ ...base, ...extra, paper: { ...base.paper, ...(extra.paper || {}) }, baseOverlay: { ...base.baseOverlay, ...(extra.baseOverlay || {}) } });
}

export function normalizePaintData(data = {}) {
  const layers = (Array.isArray(data.layers) && data.layers.length ? data.layers : [createLayer(1)]).slice(0, MAX_LAYERS).map((layer, index) => normalizeLayer(layer, index + 1));
  const seen = new Set();
  layers.forEach((layer, index) => {
    if (seen.has(layer.id)) layer.id = `layer-${index + 1}-${seen.size}`;
    seen.add(layer.id);
  });
  const active = layers.some((layer) => layer.id === data.activeLayerId) ? data.activeLayerId : layers[layers.length - 1].id;
  const position = data.baseOverlay?.position === 'above' ? 'above' : 'below';
  return {
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 80) : '绘画节点',
    paper: normalizePaper(data.paper),
    outputMode: OUTPUT_MODES.includes(data.outputMode) ? data.outputMode : 'transparent',
    maskOverlayColor: typeof data.maskOverlayColor === 'string' ? data.maskOverlayColor : 'rgba(255, 48, 56, 0.5)',
    baseOverlay: {
      visible: data.baseOverlay?.visible !== false,
      opacity: normalizeOpacity(data.baseOverlay?.opacity, 55),
      position,
    },
    activeLayerId: active,
    layers,
    assetPath: typeof data.assetPath === 'string' && data.assetPath.startsWith('assets/') ? data.assetPath : '',
    url: typeof data.url === 'string' ? data.url : '',
    paintSignature: typeof data.paintSignature === 'string' ? data.paintSignature : '',
    touched: data.touched === true,
    swatches: Array.isArray(data.swatches) ? data.swatches.filter((item) => typeof item === 'string').slice(0, 24) : [],
    extensions: { ...PAINT_EXTENSIONS, ...(data.extensions && typeof data.extensions === 'object' ? data.extensions : {}) },
  };
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function paintSignature(data) {
  const doc = normalizePaintData(data);
  const payload = JSON.stringify({
    outputMode: doc.outputMode,
    paper: doc.paper,
    baseOverlay: doc.baseOverlay,
    layers: doc.layers.map((layer) => ({
      id: layer.id, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode,
      alphaLock: layer.alphaLock, clippingMask: layer.clippingMask, assetPath: layer.assetPath,
    })),
    assetPath: doc.assetPath,
  });
  return fnv1a(payload);
}

export function initialPaperForBase(data, baseSize) {
  const doc = normalizePaintData(data);
  if (doc.touched || !baseSize) return doc.paper;
  const matched = matchBaseSize(baseSize.width, baseSize.height);
  return { ...doc.paper, width: matched.width, height: matched.height };
}

function nextLayerId(layers) {
  const used = new Set(layers.map((layer) => layer.id));
  for (let index = 1; index < 1000; index += 1) {
    const id = `layer-${index}`;
    if (!used.has(id)) return id;
  }
  return `layer-${Date.now()}`;
}

export function addLayer(data) {
  const doc = normalizePaintData(data);
  if (doc.layers.length >= MAX_LAYERS) return { doc, error: LAYER_LIMIT_MESSAGE };
  const layer = createLayer(doc.layers.length + 1, nextLayerId(doc.layers));
  layer.name = `图层 ${doc.layers.length + 1}`;
  return { doc: { ...doc, layers: [...doc.layers, layer], activeLayerId: layer.id } };
}

export function deleteLayer(data, layerId = data.activeLayerId) {
  const doc = normalizePaintData(data);
  if (doc.layers.length <= 1) return { doc, error: '至少保留 1 个图层。' };
  const layers = doc.layers.filter((layer) => layer.id !== layerId);
  if (layers.length === doc.layers.length) return { doc, error: '找不到要删除的图层。' };
  const activeLayerId = doc.activeLayerId === layerId ? layers[layers.length - 1].id : doc.activeLayerId;
  return { doc: { ...doc, layers, activeLayerId } };
}

export function duplicateLayer(data, layerId = data.activeLayerId) {
  const doc = normalizePaintData(data);
  if (doc.layers.length >= MAX_LAYERS) return { doc, error: LAYER_LIMIT_MESSAGE };
  const index = doc.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return { doc, error: '找不到要复制的图层。' };
  const copy = { ...doc.layers[index], id: nextLayerId(doc.layers), name: `${doc.layers[index].name} 副本`, assetPath: '', url: '' };
  const layers = doc.layers.slice();
  layers.splice(index + 1, 0, copy);
  return { doc: { ...doc, layers, activeLayerId: copy.id }, sourceId: layerId };
}

export function moveLayer(data, layerId, direction) {
  const doc = normalizePaintData(data);
  const index = doc.layers.findIndex((layer) => layer.id === layerId);
  const next = index + (direction === 'up' ? 1 : -1);
  if (index < 0 || next < 0 || next >= doc.layers.length) return { doc };
  const layers = doc.layers.slice();
  const [item] = layers.splice(index, 1);
  layers.splice(next, 0, item);
  return { doc: { ...doc, layers } };
}

export function renameLayer(data, layerId, name) {
  const doc = normalizePaintData(data);
  return { doc: { ...doc, layers: doc.layers.map((layer) => layer.id === layerId ? normalizeLayer({ ...layer, name }, 1) : layer) } };
}

export function patchLayer(data, layerId, patch) {
  const doc = normalizePaintData(data);
  return {
    doc: {
      ...doc,
      layers: doc.layers.map((layer) => layer.id === layerId ? normalizeLayer({ ...layer, ...patch, id: layer.id }, 1) : layer),
    },
  };
}

export function createHistory(limit = HISTORY_LIMIT) {
  return { undo: [], redo: [], limit: Math.max(1, Math.min(50, limit)) };
}

export function pushHistory(history, entry) {
  if (!entry) return history;
  history.undo.push(entry);
  while (history.undo.length > history.limit) history.undo.shift();
  history.redo = [];
  return history;
}

export function undoHistory(history) {
  const entry = history.undo.pop();
  if (!entry) return null;
  history.redo.push(entry);
  return entry;
}

export function redoHistory(history) {
  const entry = history.redo.pop();
  if (!entry) return null;
  history.undo.push(entry);
  return entry;
}

export function directedCycle(sourceId, targetId, edges) {
  const queue = [targetId];
  const seen = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (current === sourceId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.source === current) queue.push(edge.target);
  }
  return false;
}

const existingEdge = (edges, normalized) => edges.find((edge) => Object.entries(normalized).every(([key, value]) => edge[key] === value));

export function planPaintBaseConnection(connection, source, target, edges) {
  if (connection.targetHandle && connection.targetHandle !== 'base') return { error: '绘画节点只接受参考底图端口。' };
  const image = (source?.type === 'media' && source.data?.kind === 'image') || source?.type === 'imageProcess' || source?.type === 'paint';
  if (!image) return { error: '绘画节点的参考底图只接受图片。' };
  if (directedCycle(source.id, target.id, edges)) return { error: '绘画节点连线不能形成循环。' };
  const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: 'base' };
  return { connection: normalized, source, target, multiple: false, existing: existingEdge(edges, normalized) };
}

export function planPaintGeneratorConnection(connection, source, target, nodes, edges) {
  if (target?.type !== 'generator') return { error: '请把绘画输出连接到图片输入端口。' };
  const mode = target.data?.mode || 'reference';
  let targetHandle = connection.targetHandle;
  let multiple = false;
  if (mode === 'qwenEdit' && targetHandle === 'mask') {
    if (target.data.qwenModel === 'h3_image') return { error: 'H3-Image 不支持局部遮罩，请切回 Qwen。' };
    if (source.data?.outputMode !== 'mask') return { error: '请将绘画节点切换为黑白遮罩后再连接遮罩端口。' };
  } else if (mode === 'qwenEdit' && ['references', 'guide', 'identity'].includes(targetHandle)) {
    targetHandle = 'references';
    multiple = true;
    const refs = edges.filter((edge) => edge.target === target.id && ['guide', 'identity', 'references'].includes(edge.targetHandle));
    if (refs.some((edge) => edge.source === source.id)) return { error: '这张图片已连接。' };
    if (refs.length >= 10) return { error: '图生图最多连接10张参考图片。' };
  } else if (mode === 'reference' && targetHandle === 'references') {
    multiple = true;
    const refs = edges.filter((edge) => edge.target === target.id && edge.targetHandle === 'references');
    if (refs.some((edge) => edge.source === source.id)) return { error: '此素材已连接。' };
    const images = refs.filter((edge) => {
      const node = nodes.find((item) => item.id === edge.source);
      return node?.type === 'paint' || node?.data?.kind === 'image';
    });
    if (images.length >= 9) return { error: '此类参考最多连接 9 个素材。' };
  } else if (mode === 'customWorkflow' && target.data.workflowDefinition?.inputs?.some((port) => port.id === targetHandle && port.type === 'image' && !port.list)) {
    // Single image custom input.
  } else if (mode === 'mossPose' && ['guide', 'identity'].includes(targetHandle)) {
    // Pose or identity image.
  } else if (mode === 'frames' && ['first', 'last'].includes(targetHandle)) {
    // Keyframe still.
  } else if (['swap', 'upscale'].includes(mode) && targetHandle === 'identity') {
    // Optional identity image.
  } else if (mode === 'characterSheet' && ['body_reference', 'back_reference', 'guide'].includes(targetHandle)) {
    // Character references.
  } else if (['imageUpscale', 'identityEdit', 'outfitEdit', 'localRealism', 'image'].includes(mode) && targetHandle === 'guide') {
    // Single image input. Text-to-image has no required guide, but a connected guide is still an image.
  } else if (['outfitEdit', 'localRealism'].includes(mode) && targetHandle === 'identity') {
    // Secondary image.
  } else if (mode === 'image' && !targetHandle) {
    targetHandle = 'guide';
  } else return { error: '素材类型与输入端口不匹配，请连接对应的图片、视频或遮罩端口。' };
  const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle };
  return { connection: normalized, source, target, multiple, existing: existingEdge(edges, normalized) };
}

export function paintReferenceData(source, slot) {
  if (source?.type !== 'paint') return null;
  return {
    kind: 'image',
    title: source.data.title || '绘画节点',
    url: source.data.url || '',
    assetPath: source.data.assetPath || '',
    name: 'paint.png',
    slot,
    paintSignature: source.data.paintSignature || '',
    mediaRole: source.data.outputMode === 'mask' ? 'mask' : undefined,
  };
}
