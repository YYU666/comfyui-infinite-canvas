// Shared by add, paste and tidy; distances are in canvas units, independent of zoom.
export const CANVAS_SPACING = { horizontal: 44, vertical: 44, grid: 22, rowWidth: 3200 };

const NODE_SIZES = {
  spriteAtlas: { width: 430, height: 1100 },
  artDirector: { width: 540, height: 1700 },
  imageProcess: { width: 370, height: 1000 },
  videoEdit: { width: 400, height: 420 },
  videoSpeed: { width: 360, height: 300 },
  videoTimeRemap: { width: 380, height: 420 },
  videoChromaKey: { width: 400, height: 640 },
  videoLocalRepair: { width: 400, height: 920 },
  videoWhitePlate: { width: 400, height: 560 },
  media: { width: 440, height: 550 },
  generator: { width: 440, height: 520 },
  prompt: { width: 370, height: 430 },
  note: { width: 310, height: 250 },
};

const positive = value => Number.isFinite(value) && value > 0;
const snap = value => Math.round(value / CANVAS_SPACING.grid) * CANVAS_SPACING.grid;
const ceilGrid = value => Math.ceil(value / CANVAS_SPACING.grid) * CANVAS_SPACING.grid;

export function nodeLayoutSize(node) {
  if (typeof node === 'string') node = { type: node };
  const data = node.data || {};
  let size = NODE_SIZES[node.type] || NODE_SIZES.media;
  if (node.type === 'media') {
    size = data.kind === 'audio' ? { width: 270, height: 220 } : size;
  }
  if (node.type === 'generator' && data.resultUrl && ['done', 'completed'].includes(data.status) && !data.error) {
    size = { width: 440, height: 550 };
  }
  // Compact rendering shrinks measured heights. Reserve the normal footprint
  // so zooming back in cannot make neighbouring rows overlap.
  return {
    width: Math.max(size.width, positive(node.measured?.width) ? node.measured.width : 0, positive(node.width) ? node.width : 0),
    height: Math.max(size.height, positive(node.measured?.height) ? node.measured.height : 0, positive(node.height) ? node.height : 0),
  };
}

export function visibleLayoutNodes(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return nodes.filter(node => !node.hidden && !(node.type === 'media' && node.data?.kind === 'image'
    && node.data.output && byId.get(node.data.inlineImageOwnerId)?.type === 'generator'));
}

const box = node => ({ ...node.position, ...nodeLayoutSize(node) });
const overlaps = (a, b) => a.x < b.x + b.width + CANVAS_SPACING.horizontal
  && a.x + a.width + CANVAS_SPACING.horizontal > b.x
  && a.y < b.y + b.height + CANVAS_SPACING.vertical
  && a.y + a.height + CANVAS_SPACING.vertical > b.y;

export function findFreePosition(nodes, desired, type = 'media', { rowWidth = CANVAS_SPACING.rowWidth } = {}) {
  const occupied = visibleLayoutNodes(nodes).map(box);
  const size = nodeLayoutSize(type);
  const start = { x: snap(desired.x), y: snap(desired.y) };
  const fits = position => !occupied.some(other => overlaps({ ...position, ...size }, other));
  if (fits(start)) return start;
  // Fill a bounded row from left to right. Candidate edges come from actual
  // boxes, without fixed vertical jumps or a collision-blind search limit.
  const maxX = start.x + Math.max(rowWidth, size.width) - size.width;
  const xs = [...new Set([start.x, ...occupied.map(other => ceilGrid(other.x + other.width + CANVAS_SPACING.horizontal))])]
    .filter(x => x >= start.x && x <= maxX).sort((a, b) => a - b);
  const ys = [...new Set([start.y, ...occupied.map(other => ceilGrid(other.y + other.height + CANVAS_SPACING.vertical))])]
    .filter(y => y >= start.y).sort((a, b) => a - b);
  for (const y of ys) for (const x of xs) if (fits({ x, y })) return { x, y };
  return { x: start.x, y: ceilGrid(Math.max(start.y, ...occupied.map(other => other.y + other.height + CANVAS_SPACING.vertical))) };
}

export function findReferencePosition(nodes, target, y = target.position.y) {
  const size = nodeLayoutSize('media');
  const x = Math.floor((target.position.x - size.width - CANVAS_SPACING.horizontal) / CANVAS_SPACING.grid) * CANVAS_SPACING.grid;
  // An input stays in the column to the left; collision search only moves down.
  return findFreePosition(nodes, { x, y }, 'media', { rowWidth: size.width });
}

export function planReferencePositions(nodes, target, count) {
  const occupied = [...nodes];
  return Array.from({ length: count }, () => {
    const position = findReferencePosition(occupied, target);
    occupied.push({ id: Symbol('planned-reference'), type: 'media', position });
    return position;
  });
}

export function compactCanvasPositions(nodes, edges = [], { rowWidth = CANVAS_SPACING.rowWidth } = {}) {
  const visible = visibleLayoutNodes(nodes);
  const byId = new Map(visible.map(node => [node.id, node]));
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const order = (a, b) => originalIndex.get(a.id) - originalIndex.get(b.id);
  const parents = new Map(), results = new Map();
  const allById = new Map(nodes.map(node => [node.id, node]));
  const visibleId = id => byId.has(id) ? id : byId.has(allById.get(id)?.data?.inlineImageOwnerId) ? allById.get(id).data.inlineImageOwnerId : null;
  for (const edge of edges) {
    const source = visibleId(edge.source), target = visibleId(edge.target);
    if (!source || !target || source === target) continue;
    if (!parents.has(target)) parents.set(target, new Set());
    parents.get(target).add(source);
    if (edge.targetHandle === 'preview' && byId.get(target).data?.output) {
      if (!results.has(source)) results.set(source, new Set());
      results.get(source).add(target);
    }
  }
  // Bring every reference before its consumer, even when imported later. Use
  // persisted node order as a stable tie-breaker, independent of prior tidy.
  // Shared mothers appear once; long workflows wrap into compact new rows.
  const ordered = [], seen = new Set(), visiting = new Set();
  const append = node => {
    if (seen.has(node.id) || visiting.has(node.id)) return;
    visiting.add(node.id);
    for (const parent of [...(parents.get(node.id) || [])].map(id => byId.get(id)).sort(order)) append(parent);
    visiting.delete(node.id);
    if (seen.has(node.id)) return;
    seen.add(node.id); ordered.push(node);
    for (const child of [...(results.get(node.id) || [])].map(id => byId.get(id)).sort(order)) append(child);
  };
  for (const node of visible) append(node);
  const positions = new Map(), occupied = [];
  const consumers = new Set([...parents.values()].flatMap(ids => [...ids]));
  for (const node of ordered) {
    const size = nodeLayoutSize(node);
    const inputs = [...(parents.get(node.id) || [])].filter(id => positions.has(id));
    const minX = Math.max(0, ...inputs.map(id => ceilGrid(positions.get(id).x + nodeLayoutSize(byId.get(id)).width + CANVAS_SPACING.horizontal)));
    const minY = Math.max(0, ...inputs.map(id => positions.get(id).y));
    // Reserve the leftmost possible column for reusable mothers/processors.
    // Terminal results and disconnected cards fill the remaining row slots.
    // Long chains can extend beyond rowWidth rather than reversing a wire.
    const maxX = consumers.has(node.id) ? minX : Math.max(minX, rowWidth - size.width);
    const xs = [...new Set([minX, ...occupied.map(other => ceilGrid(other.x + other.width + CANVAS_SPACING.horizontal))])]
      .filter(x => x >= minX && x <= maxX).sort((a, b) => a - b);
    const ys = [...new Set([minY, ...occupied.map(other => ceilGrid(other.y + other.height + CANVAS_SPACING.vertical))])]
      .filter(y => y >= minY).sort((a, b) => a - b);
    let position;
    for (const y of ys) {
      for (const x of xs) if (!occupied.some(other => overlaps({ x, y, ...size }, other))) { position = { x, y }; break; }
      if (position) break;
    }
    positions.set(node.id, position);
    occupied.push({ ...position, ...size });
  }
  // Persisted backing results retain media identity but consume no layout slot.
  for (const node of nodes) if (!positions.has(node.id) && positions.has(node.data?.inlineImageOwnerId)) {
    positions.set(node.id, { ...positions.get(node.data.inlineImageOwnerId) });
  }
  return positions;
}
