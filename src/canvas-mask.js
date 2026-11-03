import { qwenCanvasReferences } from './qwen-references.js';

export const isMaskNode = (node) => node?.type === 'media' && node.data?.mediaRole === 'mask';
export const maskSourceKey = (node) => node?.data?.assetPath || node?.data?.sourcePromptId || node?.data?.remoteName || node?.data?.url || '';

export function canvasMaskGuide(id, nodes, edges) {
  const node = nodes.find((item) => item.id === id);
  if (isMaskNode(node)) {
    const edge = edges.find((item) => item.target === id && item.targetHandle === 'guide');
    return nodes.find((item) => item.id === edge?.source && item.type === 'media' && item.data.kind === 'image' && !isMaskNode(item) && item.data.url) || null;
  }
  // Existing skin-repair canvases retain their original mask connection.
  const edge = edges.find((item) => item.source === id && item.targetHandle === 'identity');
  const target = nodes.find((item) => item.id === edge?.target);
  if (target?.data.mode !== 'localRealism') return null;
  const guideEdge = edges.find((item) => item.target === target.id && item.targetHandle === 'guide');
  return nodes.find((item) => item.id === guideEdge?.source && item.data.kind === 'image' && item.data.url) || null;
}

export function qwenCanvasMask(id, nodes, edges) {
  const edge = edges.find((item) => item.target === id && item.targetHandle === 'mask');
  return nodes.find((item) => item.id === edge?.source) || null;
}

export function validateCanvasMask(node, nodes, edges) {
  const connections = edges.filter((item) => item.target === node.id && item.targetHandle === 'mask');
  if (!connections.length) return null;
  const mask = qwenCanvasMask(node.id, nodes, edges);
  if (connections.length !== 1 || !isMaskNode(mask)) throw new Error('遮罩端口只接受一个「局部遮罩修改」节点。');
  if (!mask.data.url) throw new Error('请先在「局部遮罩修改」节点绘制或导入遮罩。');
  const source = qwenCanvasReferences(node, nodes, edges)[0];
  const guide = canvasMaskGuide(mask.id, nodes, edges);
  if (!source || guide?.id !== source.id) throw new Error('遮罩底图必须与图生图的图1相同，请检查底图连接。');
  if (mask.data.maskSourceId !== source.id || mask.data.maskSourceKey !== maskSourceKey(source)) throw new Error('遮罩的底图已变化，请重新绘制或导入遮罩。');
  return { ...mask, data: { ...mask.data, slot: 'mask' } };
}
