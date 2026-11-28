import { isInlineBackingMedia } from './image-inline-output.js';

export const PRODUCTION_ZONE_TITLE = '生产分区';
export const PRODUCTION_ZONE_TITLE_LIMIT = 80;

const HORIZONTAL_PADDING = 24;
const HEADER_PADDING = 58;

function visibleZoneMembers(nodes, candidates) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return candidates.filter((node) => !node.hidden && !isInlineBackingMedia(node, nodeById.get(node.data?.inlineImageOwnerId)));
}

export function selectedProductionZoneMembers(nodes) {
  const selected = nodes.filter((node) => node.selected);
  return selected.length >= 2 ? visibleZoneMembers(nodes, selected) : selected;
}

export function createProductionZone(nodes, id, title = PRODUCTION_ZONE_TITLE) {
  const selected = selectedProductionZoneMembers(nodes);
  if (selected.length < 2) return nodes;
  const ids = new Set(selected.map((node) => node.id));
  const productionZone = { id, title: cleanTitle(title) };
  return nodes.map((node) => ids.has(node.id)
    ? { ...node, selected: false, data: { ...node.data, productionZone } }
    : node);
}

function cleanTitle(title) {
  return title.trim().slice(0, PRODUCTION_ZONE_TITLE_LIMIT) || PRODUCTION_ZONE_TITLE;
}

export function editProductionZone(nodes, id, title) {
  return nodes.map((node) => {
    if (node.data?.productionZone?.id !== id) return node;
    const { productionZone, ...data } = node.data;
    if (title !== null) data.productionZone = { ...productionZone, title: cleanTitle(title) };
    return { ...node, data };
  });
}

export function moveProductionZone(nodes, id, { x, y }) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const owner = byId.get(node.data?.inlineImageOwnerId);
    const zone = isInlineBackingMedia(node, owner) ? owner.data.productionZone : node.data?.productionZone;
    if (zone?.id !== id || !node.position) return node;
    return { ...node, position: { x: node.position.x + x, y: node.position.y + y } };
  });
}

export function productionZoneFrames(nodes) {
  const candidates = nodes.filter((node) => node.data?.productionZone?.id);
  if (!candidates.length) return [];
  const frames = new Map();
  for (const node of visibleZoneMembers(nodes, candidates)) {
    const zone = node.data?.productionZone;
    if (!zone?.id || !node.position) continue;
    const { x, y } = node.position;
    const width = node.measured?.width || node.width || 320;
    const height = node.measured?.height || node.height || 260;
    let frame = frames.get(zone.id);
    if (!frame) {
      frame = { id: zone.id, title: zone.title || PRODUCTION_ZONE_TITLE, left: x, top: y, right: x + width, bottom: y + height };
      frames.set(zone.id, frame);
    } else {
      frame.left = Math.min(frame.left, x);
      frame.top = Math.min(frame.top, y);
      frame.right = Math.max(frame.right, x + width);
      frame.bottom = Math.max(frame.bottom, y + height);
    }
  }
  return [...frames.values()].map(({ id, title, left, top, right, bottom }) => ({
    id, title,
    x: left - HORIZONTAL_PADDING,
    y: top - HEADER_PADDING,
    width: right - left + HORIZONTAL_PADDING * 2,
    height: bottom - top + HEADER_PADDING + HORIZONTAL_PADDING,
  }));
}
