const KIND_LABEL = { image: 'Picture', video: 'Video', audio: 'Audio' };
const TAG_PATTERN = /^<(Picture|Video|Audio) [1-9][0-9]*>$/;

export function allocateReferenceTag(used, kind) {
  const label = KIND_LABEL[kind] || KIND_LABEL.image;
  let index = 1;
  while (used.has(`<${label} ${index}>`)) index += 1;
  const tag = `<${label} ${index}>`;
  used.add(tag);
  return tag;
}

export function nextReferenceTag(nodes, kind) {
  return allocateReferenceTag(new Set(nodes.map((node) => node.data?.refTag).filter((tag) => TAG_PATTERN.test(tag))), kind);
}

export function ensureReferenceTags(nodes) {
  const used = new Set();
  return nodes.map((node) => {
    if (node.type !== 'media' && node.type !== 'image' && node.type !== 'video') return node;
    const kind = node.data?.kind || (node.type === 'video' ? 'video' : 'image');
    const current = node.data?.refTag;
    const refTag = TAG_PATTERN.test(current) && !used.has(current) ? current : allocateReferenceTag(used, kind);
    used.add(refTag);
    return current === refTag ? node : { ...node, data: { ...node.data, refTag } };
  });
}

export function referenceDescriptors(nodes) {
  const counters = { image: 0, video: 0, audio: 0 };
  return nodes.map((node) => {
    const kind = node.data.kind || 'image';
    counters[kind] += 1;
    return { node, kind, tag: node.data.refTag || `<${KIND_LABEL[kind]} ${counters[kind]}>` };
  });
}

export function replaceReferenceTags(text, replacements) {
  if (typeof text !== 'string' || !replacements.size) return text;
  return text.replace(/<(?:Picture|Video|Audio) [1-9][0-9]*>/g, (tag) => replacements.get(tag) || tag);
}
