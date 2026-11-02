export const QWEN_REFERENCE_LIMIT = 10;
const TOKEN = /\[\[qref:([^\]]+)\]\]/g;
const NUMBER = /<(?:image|Picture\s+)([1-9]\d*)>|\b(?:Image|Picture)\s*([1-9]\d*)\b|图\s*([1-9]\d*)/gi;
const decodeId = (encoded) => { try { return decodeURIComponent(encoded); } catch { return null; } };
export const qwenReferenceToken = (id) => `[[qref:${encodeURIComponent(id)}]]`;
export const referenceId = (ref) => ref.id || ref.sourceId;
const slot = (ref) => ref.data?.slot ?? ref.slot;

// Legacy inputs have semantic order regardless of the order their wires were added.
export function orderQwenReferences(refs, order = []) {
  order = Array.isArray(order) ? order : [];
  const rank = { guide: 0, identity: 1, references: 2 };
  const legacy = refs.map((ref, index) => ({ ref, index })).sort((a, b) =>
    (rank[slot(a.ref)] ?? 3) - (rank[slot(b.ref)] ?? 3) || a.index - b.index).map(({ ref }) => ref);
  return [...legacy].sort((a, b) => {
    const ai = order.indexOf(referenceId(a)), bi = order.indexOf(referenceId(b));
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
  });
}
export function qwenCanvasReferences(node, nodes, edges) {
  const refs = edges.filter((edge) => edge.target === node.id && ['guide', 'identity', 'references'].includes(edge.targetHandle))
    .map((edge) => { const source = nodes.find((item) => item.id === edge.source); return source?.type === 'media' && source.data.kind === 'image' ? { ...source, data: { ...source.data, slot: edge.targetHandle } } : null; }).filter(Boolean);
  return orderQwenReferences(refs, node.data.qwenReferenceOrder);
}
export function bindQwenPrompt(text = '', refs = []) {
  // Already-bound IDs are opaque: never reinterpret numbers inside them.
  return text.split(/(\[\[qref:[^\]]*\]\])/g).map((part) => part.startsWith('[[qref:') ? part : part.replace(NUMBER, (match, a, b, c) => {
    const ref = refs[Number(a || b || c) - 1];
    return ref && referenceId(ref) ? qwenReferenceToken(referenceId(ref)) : match;
  })).join('');
}
export function displayQwenPrompt(text = '', refs = []) {
  return text.replace(TOKEN, (_, encoded) => {
    const id = decodeId(encoded);
    if (id === null) return '【无效的图片引用】';
    const index = refs.findIndex((ref) => referenceId(ref) === id);
    return index < 0 ? '【已断开的图片引用】' : `图${index + 1}`;
  });
}
export function compileQwenPrompt(text = '', refs = []) {
  if (text.includes('【无效的图片引用】')) throw new Error('图片引用格式无效，请重新插入引用。');
  if (text.includes('【已断开的图片引用】')) throw new Error('提示词引用的图片已断开，请重新连接或删除该引用。');
  const result = text.replace(TOKEN, (_, encoded) => {
    const id = decodeId(encoded);
    if (id === null) throw new Error('图片引用格式无效，请重新插入引用。');
    const index = refs.findIndex((ref) => referenceId(ref) === id);
    if (index < 0) throw new Error('提示词引用的图片已断开，请重新连接或删除该引用。');
    return `<image${index + 1}>`;
  }).replace(NUMBER, (_, a, b, c) => {
    const index = Number(a || b || c);
    if (index > refs.length) throw new Error(`提示词中的图${index}未连接，请检查参考图片。`);
    return `<image${index}>`;
  });
  if (result.includes('[[qref:')) throw new Error('图片引用格式无效，请重新插入引用。');
  return result;
}
export function remapQwenReferences(data, idMap) {
  if (data.mode !== 'qwenEdit') return data;
  return { ...data, ...(Array.isArray(data.qwenReferenceOrder) ? { qwenReferenceOrder: data.qwenReferenceOrder.map((id) => idMap.get(id) || id) } : {}),
    prompt: (data.prompt || '').replace(TOKEN, (token, encoded) => { const id = decodeId(encoded); return id === null ? token : qwenReferenceToken(idMap.get(id) || id); }) };
}
export function validateQwenReferences(refs) {
  if (!refs.length) throw new Error('图生图至少需要一张参考图片。');
  if (refs.length > QWEN_REFERENCE_LIMIT) throw new Error('图生图最多连接 10 张参考图片。');
  if (refs.some((ref) => (ref.kind || ref.data?.kind) !== 'image')) throw new Error('图生图只支持图片参考。');
  const ids = refs.map((ref) => referenceId(ref) || ref.name);
  if (new Set(ids).size !== ids.length) throw new Error('参考图片重复，请移除重复连线。');
}
