const NODE_SIZES = {
  media: { width: 310, height: 250 },
  generator: { width: 440, height: 360 },
  prompt: { width: 370, height: 430 },
  note: { width: 300, height: 250 },
};

const GAP = 70;
const GRID = 22;

function boxAt(position, type) {
  const size = NODE_SIZES[type] || NODE_SIZES.media;
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function overlaps(a, b) {
  return a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x
    && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y;
}

// Keep explicit positions when they are free; otherwise find the nearest
// deterministic opening below, then continue in the next column.
export function findFreePosition(nodes, desired, type = 'media') {
  const occupied = nodes.map((node) => ({
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width || (NODE_SIZES[node.type] || NODE_SIZES.media).width,
    height: node.measured?.height || (NODE_SIZES[node.type] || NODE_SIZES.media).height,
  }));
  const start = {
    x: Math.round(desired.x / GRID) * GRID,
    y: Math.round(desired.y / GRID) * GRID,
  };
  for (let index = 0; index < 240; index += 1) {
    const candidate = {
      x: start.x + Math.floor(index / 12) * 550,
      y: start.y + (index % 12) * 440,
    };
    if (!occupied.some((box) => overlaps(boxAt(candidate, type), box))) return candidate;
  }
  return { x: start.x + 11000, y: start.y };
}
