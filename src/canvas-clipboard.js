import { remapQwenReferences } from './qwen-references.js';
import { allocateReferenceTag, replaceReferenceTags } from './reference-tags.js';
import { findFreePosition, nodeLayoutSize, visibleLayoutNodes } from './canvas-layout.js';

const GRID = 22;
const TEXT_FIELDS = ['prompt', 'idea', 'optimizedPrompt'];

function cloneData(data = {}) {
  const { file, ...serializable } = data;
  return structuredClone(serializable);
}

function nodeBox(node, position = node.position) {
  const size = nodeLayoutSize(node);
  return {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };
}

function findGroupPosition(nodes, existingNodes) {
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const start = {
    x: Math.round((minX + GRID * 2) / GRID) * GRID,
    y: Math.round((minY + GRID * 2) / GRID) * GRID,
  };
  const boxes = visibleLayoutNodes(nodes).map(node => nodeBox(node));
  if (!boxes.length) return { x: start.x - minX, y: start.y - minY };
  const candidate = findFreePosition(existingNodes, start, {
    type: 'group',
    measured: {
      width: Math.max(...boxes.map(box => box.x + box.width)) - minX,
      height: Math.max(...boxes.map(box => box.y + box.height)) - minY,
    },
  });
  return { x: candidate.x - minX, y: candidate.y - minY };
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
  // Pasting clears the completed presentation. Reserve the idle card, which can
  // be taller than a completed landscape result, before looking for space.
  const layoutNodes = clipboard.nodes.map(node => node.type === 'generator'
    ? { ...node, data: { ...node.data, status: 'idle', resultUrl: null } } : node);
  const offset = findGroupPosition(layoutNodes, existingNodes);
  const nodes = clipboard.nodes.map((source) => {
    const data = remapQwenReferences(cloneData(source.data), idMap);
    if (data.maskSourceId) data.maskSourceId = idMap.get(data.maskSourceId) || data.maskSourceId;
    if (data.inlineImageOwnerId) {
      if (idMap.has(data.inlineImageOwnerId)) data.inlineImageOwnerId = idMap.get(data.inlineImageOwnerId);
      else delete data.inlineImageOwnerId;
    }
    if (data.title) data.title = `${data.title} · 副本`;
    if (pastedRefTags.has(source.id)) data.refTag = pastedRefTags.get(source.id);
    TEXT_FIELDS.forEach((field) => { if (field in data) data[field] = replaceReferenceTags(replaceMentions(data[field]), tagMap); });
    if (source.type === 'spriteAtlas') {
      Object.assign(data, { status: 'idle', stage: '' });
      ['spriteJobId', 'spriteJobSignature', 'spriteFiles', 'spriteResultSignature', 'error'].forEach(key => delete data[key]);
    }
    if (source.type === 'artDirector') {
      Object.assign(data,{status:'idle',stage:'',analysis:null,boardAssetPath:null,boardSignature:null,boardResultId:null,stale:false});
      delete data.error;
    }
    if (data.sourceArtDirectorId) data.sourceArtDirectorId = idMap.get(data.sourceArtDirectorId) || null;
    if (['videoSpeed', 'videoTimeRemap'].includes(source.type)) {
      Object.assign(data, { status: 'idle', stage: '', progress: 0 });
      ['rhythmJobId', 'rhythmSubmittedSettings', 'rhythmResultAssetPath', 'rhythmResult', 'rhythmResultSettings', 'rhythmResultJobId', 'rhythmInputCache', 'error'].forEach(key => delete data[key]);
    }
    if (source.type === 'videoChromaKey') { Object.assign(data, { status: 'idle', stage: '', progress: 0 }); ['chromaJobId', 'chromaSubmittedSettings', 'chromaResultAssetPath', 'chromaResult', 'chromaResultSettings', 'chromaResultJobId', 'chromaInputCache', 'error'].forEach(key => delete data[key]); }
    if (source.type === 'videoLocalRepair') { Object.assign(data, { status: 'idle', stage: '', progress: 0 }); ['repairJobId', 'repairSubmittedSettings', 'repairSubmittedSource', 'repairInputCache', 'repairPendingResult', 'repairResultAssetPath', 'repairResult', 'repairResultSettings', 'repairResultSource', 'repairResultJobId', 'error'].forEach(key => delete data[key]); }
    if (source.type === 'videoWhitePlate') { Object.assign(data, { status: 'idle', stage: '', progress: 0 }); ['plateJobId', 'plateSubmittedSettings', 'plateResultAssetPath', 'plateResultNodeId', 'plateResultUrl', 'plateResult', 'plateResultJobId', 'plateInputCache', 'error'].forEach(key => delete data[key]); }
    if (source.type === 'videoEdit') {
      Object.assign(data, { status: 'idle', stage: '', progress: 0 });
      ['videoEditJobId', 'editResultAssetPath', 'editResult', 'editResultDocument', 'editSubmittedDocument', 'editResultJobId', 'editInputCache', 'error'].forEach(key => delete data[key]);
    }
    if (source.type === 'generator' || source.type === 'imageProcess') {
      Object.assign(data, { status: 'idle', progress: 0, stage: '', runs: [] });
      ['promptId', 'resultUrl', 'error', 'hasMedia', 'inlineImageOutputId'].forEach((field) => { delete data[field]; });
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
