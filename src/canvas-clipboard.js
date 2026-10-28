import { allocateReferenceTag, replaceReferenceTags } from './reference-tags.js';

const NODE_SIZES = {
  media: { width: 310, height: 250 },
  generator: { width: 440, height: 360 },
  prompt: { width: 370, height: 430 },
  note: { width: 300, height: 250 },
};

const GAP = 70;
const GRID = 22;
const TEXT_FIELDS = ['prompt', 'idea', 'optimizedPrompt'];

function cloneData(data = {}) {
  const { file, ...serializable } = data;
  return structuredClone(serializable);
}

function nodeBox(node, position = node.position) {
  const size = NODE_SIZES[node.type] || NODE_SIZES.media;
  return {
    x: position.x,
    y: position.y,
    width: node.measured?.width || node.width || size.width,
    height: node.measured?.height || node.height || size.height,
  };
}

function overlaps(a, b) {
  return a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x
    && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y;
}

function findGroupPosition(nodes, existingNodes) {
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const start = {
    x: Math.round((minX + GRID * 2) / GRID) * GRID,
    y: Math.round((minY + GRID * 2) / GRID) * GRID,
  };
  const occupied = existingNodes.map((node) => nodeBox(node));
  for (let index = 0; index < 240; index += 1) {
    const candidate = {
      x: start.x + Math.floor(index / 12) * 550,
      y: start.y + (index % 12) * 440,
    };
    const offset = { x: candidate.x - minX, y: candidate.y - minY };
    const boxes = nodes.map((node) => nodeBox(node, {
      x: node.position.x + offset.x,
      y: node.position.y + offset.y,
    }));
    if (!boxes.some((box) => occupied.some((other) => overlaps(box, other)))) return offset;
  }
  return { x: start.x + 11000 - minX, y: start.y - minY };
}

export function copyCanvasSelection(nodes, edges) {
  const selected = nodes.filter((node) => node.selected);
  const ids = new Set(selected.map((node) => node.id));
  return {
    nodes: selected.map((node) => ({
      id: node.id,
      type: node.type,
      position: { ...node.position },
      measured: node.measured ? { ...node.measured } : undefined,
      width: node.width,
      height: node.height,
      data: cloneData(node.data),
    })),
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({
      ...structuredClone(edge), selected: false,
    })),
  };
}

export function pasteCanvasSelection(clipboard, existingNodes, idFactory) {
  if (!clipboard?.nodes?.length) return { nodes: [], edges: [], idMap: new Map() };
  const usedIds = new Set(existingNodes.map((node) => node.id));
  const idMap = new Map();
  const freshId = (kind) => {
    let id;
    do { id = idFactory(kind); } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  clipboard.nodes.forEach((node) => idMap.set(node.id, freshId(node.type)));
  const titleMap = new Map(clipboard.nodes.filter((node) => node.data?.title)
    .map((node) => [node.data.title, `${node.data.title} · 副本`]));
  const replaceMentions = (text) => {
    if (typeof text !== 'string') return text;
    let result = text;
    [...titleMap.entries()].sort((a, b) => b[0].length - a[0].length).forEach(([before, after]) => {
      result = result.split(`@${before}`).join(`@${after}`);
    });
    return result;
  };
  const usedRefTags = new Set(existingNodes.map((node) => node.data?.refTag).filter(Boolean));
  const tagMap = new Map();
  const pastedRefTags = new Map();
  for (const node of clipboard.nodes) {
    if (node.type !== 'media') continue;
    const previous = node.data?.refTag;
    const refTag = allocateReferenceTag(usedRefTags, node.data?.kind || 'image');
    pastedRefTags.set(node.id, refTag);
    if (previous && previous !== refTag) tagMap.set(previous, refTag);
  }
  const offset = findGroupPosition(clipboard.nodes, existingNodes);
  const nodes = clipboard.nodes.map((source) => {
    const data = cloneData(source.data);
    if (data.title) data.title = `${data.title} · 副本`;
    if (pastedRefTags.has(source.id)) data.refTag = pastedRefTags.get(source.id);
    TEXT_FIELDS.forEach((field) => { if (field in data) data[field] = replaceReferenceTags(replaceMentions(data[field]), tagMap); });
    if (source.type === 'generator') {
      Object.assign(data, { status: 'idle', progress: 0, stage: '', runs: [] });
      ['promptId', 'resultUrl', 'error', 'hasMedia'].forEach((field) => { delete data[field]; });
    }
    return {
      id: idMap.get(source.id),
      type: source.type,
      position: { x: source.position.x + offset.x, y: source.position.y + offset.y },
      measured: source.measured ? { ...source.measured } : undefined,
      width: source.width,
      height: source.height,
      data,
      selected: true,
    };
  });
  const edges = (clipboard.edges || []).filter((edge) => idMap.has(edge.source) && idMap.has(edge.target)).map((edge) => ({
    ...structuredClone(edge),
    id: freshId('edge'),
    source: idMap.get(edge.source),
    target: idMap.get(edge.target),
    selected: false,
    type: 'default',
  }));
  return { nodes, edges, idMap };
}
