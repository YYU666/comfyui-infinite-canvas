import { ART_PORTS } from './art-director.js';
import {nativeOutputNode} from './native3d-output.js';
import { nativeModelConnection } from './native3d.js';
import { isMaskNode } from './canvas-mask.js';
import { qwenCanvasReferences } from './qwen-references.js';
import { isImageProcess, acceptsImageProcessConnection } from './image-process-graph.js';
import { planPaintBaseConnection, planPaintGeneratorConnection } from './paint-document.js';
import { isVideoRhythm, planVideoRhythmConnection } from './video-rhythm-document.js';
import { isVideoChroma, planVideoChromaConnection } from './video-chroma-document.js';
import { isVideoRepair, planVideoRepairConnection } from './video-repair-document.js';
import { isVideoPlate, planVideoPlateConnection } from './video-plate-document.js';
import { isVideoEdit, planVideoEditConnection } from './video-edit-document.js';

const busy = (node) => ['uploading', 'submitting', 'queued', 'running', 'finishing'].includes(node?.data?.status);
const fail = (error) => ({ error });

export function resolvePlateAsset(source, nodes) {
  if (source?.type !== 'videoWhitePlate') return { source };
  const media = nodes.find((node) => node.id === source.data?.plateResultNodeId
    && node.type === 'media' && node.data?.kind === 'video'
    && node.data.assetPath && node.data.assetPath === source.data.plateResultAssetPath);
  if (!media) return fail('请先导出绿幕白模。成片会登记为旁边的「绿幕白模成片」视频素材，把该素材连到角色替换上方的源视频端口，身份图连到下方端口。');
  return { source: media, resolvedFrom: source.id };
}

// A generator socket means the visible, already-saved result, never a future run.
// Resolve to its media node so changing/re-running the generator cannot silently
// replace an existing reference. Ambiguous custom outputs require explicit choice.
export function resolveConnectionSource(source, handle, nodes, edges) {
  if(source?.type==='native3d'&&source.data.nativeCurrentOutputId){if(busy(source))return fail('3D节点正在处理，请完成并保存结果后再连接。');try{return {source:nativeOutputNode(source)};}catch(error){return fail(error.message);}}
  if (source?.type==='native3d' && source.data.operation==='analyze' && source.data.nativeUVPlan && handle==='plan' && source.data.status==='completed') return {source};
  if (source?.type==='native3d' && source.data.operation==='uv_plan' && handle==='plan') {
    const outputs=nodes.filter(n=>n.data?.nativeUVPlan?.jobId===source.data.nativeJobId && n.id!==source.id && n.data.status==='completed');
    if (busy(source) || outputs.length!==1) return fail('切缝方案尚未完成或结果不唯一。');
    return {source:outputs[0],resolvedFrom:source.id};
  }
  if (source?.type === 'native3d' && source.data.operation !== 'analyze') {
    if (busy(source)) return fail('3D节点正在处理，请完成并保存结果后再连接。');
    if (source.data.status !== 'completed' || !source.data.nativeJobId || !source.data.resultAssetPath || (handle && handle !== 'model')) return fail('此3D节点还没有当前已保存的模型结果，请先完成生成。');
    const outputs = nodes.filter(node => node.type === 'native3d'
      && node.data.operation === 'analyze' && node.data.status === 'completed'
      && node.data.sourceJobId === source.data.nativeJobId
      && (!node.data.sourceNodeId || node.data.sourceNodeId === source.id)
      && node.data.assetPath === source.data.resultAssetPath);
    if (outputs.length !== 1) return fail('找不到唯一的当前3D模型成品，请直接从要使用的模型结果节点连线。');
    return { source: outputs[0], resolvedFrom: source.id };
  }
  if (source?.type !== 'generator') return { source };
  if (!source.data.resultUrl) return fail('此节点还没有生成结果，请先生成，再连接成品素材。');
  const outputs = nodes.filter((node) => node.type === 'media' && node.data.output && !isMaskNode(node)
    && ['image', 'video'].includes(node.data.kind)
    && (!handle || handle === 'ref' || node.data.kind === handle)
    && (node.data.sourceGeneratorId === source.id || edges.some((edge) => edge.source === source.id && edge.target === node.id && edge.targetHandle === 'preview'))
    && node.data.url === source.data.resultUrl);
  if (outputs.length !== 1) return fail('找不到唯一的当前成品，请直接从要使用的成品图片或视频节点连线。');
  return { source: outputs[0], resolvedFrom: source.id };
}

export function planCanvasConnection(connection, nodes, edges, { readOnly = false, switching = false } = {}) {
  if (readOnly || switching) return fail('当前画布不可编辑。');
  const requestedSource = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!requestedSource || !target) return fail('连接的节点已不存在。');
  if (requestedSource.id === target.id) return fail('不能连接节点自身。');
  const resolved = requestedSource.type === 'videoWhitePlate' && target.type === 'generator' ? resolvePlateAsset(requestedSource, nodes) : resolveConnectionSource(requestedSource, connection.sourceHandle, nodes, edges);
  if (resolved.error) return resolved;
  const source = resolved.source;
  if (source.id === target.id) return fail('不能连接当前成品自身。');
  if (busy(target)) return fail('目标节点正在生成，请完成后再修改连接。');
  if (target.type === 'native3d' && target.data?.operation === 'image_to_3d' && source.type === 'paint') {
    if (connection.targetHandle !== 'image') return fail('图生模型的参考图端口只接普通图片。');
    const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: 'image' };
    return { connection: normalized, source, target, multiple: false, existing: edges.find((edge) => Object.entries(normalized).every(([key, value]) => edge[key] === value)), resolvedFrom: resolved.resolvedFrom };
  }
  const nativePlan = nativeModelConnection(connection, source, target, edges);
  if (nativePlan) return { ...nativePlan, resolvedFrom: resolved.resolvedFrom };
  if (target.type === 'paint') {
    const plan = planPaintBaseConnection(connection, source, target, edges);
    return plan.error ? plan : { ...plan, resolvedFrom: resolved.resolvedFrom };
  }
  if (target.type === 'artDirector') {
    const artwork = (source.type === 'media' && source.data.kind === 'image' && !isMaskNode(source)) || source.type === 'paint';
    if (!artwork || !ART_PORTS.includes(connection.targetHandle)) return fail('电子主美只接受作品与可选参考图片。');
    const queue = [target.id], seen = new Set();
    while (queue.length) { const id = queue.pop(); if (id === source.id) return fail('电子主美连线不能形成循环。'); if (seen.has(id)) continue; seen.add(id); edges.filter(e => e.source === id).forEach(e => queue.push(e.target)); }
    const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: connection.targetHandle };
    return { connection: normalized, source, target, multiple: false, existing: edges.find(e => Object.entries(normalized).every(([k,v]) => e[k] === v)), resolvedFrom: resolved.resolvedFrom };
  }
  if (isImageProcess(target)) {
    const normalized = { source: source.id, sourceHandle: 'ref', target: target.id, targetHandle: connection.targetHandle };
    if (!acceptsImageProcessConnection(normalized, nodes, edges)) return fail('图片处理只接受图片输入和对应通道，且连线不能形成循环。');
    const existing = edges.find((edge) => Object.entries(normalized).every(([key, value]) => edge[key] === value));
    return { connection: normalized, source, target, multiple: false, existing, resolvedFrom: resolved.resolvedFrom };
  }
  if (isVideoRhythm(target)) { const plan = planVideoRhythmConnection(connection, source, target, nodes, edges); return plan.error ? plan : { ...plan, resolvedFrom: resolved.resolvedFrom }; }
  if (isVideoChroma(target)) { const plan = planVideoChromaConnection(connection, source, target, nodes, edges); return plan.error ? plan : { ...plan, resolvedFrom: resolved.resolvedFrom }; }
  if (isVideoRepair(target)) { const plan = planVideoRepairConnection(connection, source, target, nodes, edges); return plan.error ? plan : { ...plan, resolvedFrom: resolved.resolvedFrom }; }
  if (isVideoPlate(target)) { const plan = planVideoPlateConnection(connection, source, target, nodes, edges); return plan.error ? plan : { ...plan, resolvedFrom: resolved.resolvedFrom }; }
  if (isVideoEdit(target)) {
    const plan = planVideoEditConnection(connection, source, target, nodes, edges);
    return plan.error ? plan : { ...plan, resolvedFrom: resolved.resolvedFrom };
  }
  let targetHandle = connection.targetHandle;
  let sourceHandle = isMaskNode(source) ? 'mask' : source.type === 'prompt' ? 'prompt' : 'ref';
  let multiple = false;
  const mode = target.data?.mode || 'reference';
  if (source.type === 'prompt') {
    if (target.type !== 'generator' || !['reference', 'frames', 'text', 'swap', 'upscale'].includes(mode) || targetHandle !== 'prompt') return fail('提示词只连接视频生成的提示词端口。');
  } else if (isMaskNode(target)) {
    if (source.type !== 'media' || source.data.kind !== 'image' || isMaskNode(source) || targetHandle !== 'guide') return fail('遮罩底图只接受图片。');
    if (edges.some((edge) => edge.source === target.id && edge.targetHandle === 'mask' && busy(nodes.find((node) => node.id === edge.target)))) return fail('生成期间不能更改遮罩底图。');
  } else if (source.type === 'paint') {
    const plan = planPaintGeneratorConnection(connection, source, target, nodes, edges);
    return plan.error ? plan : { ...plan, resolvedFrom: resolved.resolvedFrom };
  } else {
    if (source.type !== 'media' || target.type !== 'generator') return fail('请把图片、视频或音频输出连接到生成节点的输入端口。');
    if (isMaskNode(source) && !(mode === 'qwenEdit' && targetHandle === 'mask')) return fail('局部遮罩修改只连接图生图的遮罩端口。');
    if (mode === 'qwenEdit' && targetHandle === 'mask') {
      if (target.data.qwenModel === 'h3_image') return fail('H3-Image 不支持局部遮罩，请切回 Qwen。');
      if (!isMaskNode(source)) return fail('请连接「局部遮罩修改」节点。');
    } else if (mode === 'qwenEdit' && ['references', 'guide', 'identity'].includes(targetHandle)) {
      if (source.data.kind !== 'image') return fail('图生图只支持图片参考。');
      targetHandle = 'references'; multiple = true;
      const refs = qwenCanvasReferences(target, nodes, edges);
      if (refs.some((ref) => ref.id === source.id)) return fail('这张图片已连接。');
      if (refs.length >= 10) return fail('图生图最多连接10张参考图片。');
    } else if (mode === 'reference' && targetHandle === 'references') {
      const limit = { image: 9, video: 3, audio: 3 }[source.data.kind];
      if (!limit) return fail('全能参考只接受图片、视频和音频。');
      multiple = true;
      const refs = edges.filter((edge) => edge.target === target.id && edge.targetHandle === targetHandle);
      if (refs.some((edge) => edge.source === source.id)) return fail('此素材已连接。');
      if (refs.filter((edge) => nodes.find((node) => node.id === edge.source)?.data.kind === source.data.kind).length >= limit) return fail(`此类参考最多连接 ${limit} 个素材。`);
    } else if (mode === 'customWorkflow' && source.data.kind === 'image' && target.data.workflowDefinition?.inputs?.some((port) => port.id === targetHandle && port.type === 'image' && !port.list)) {
      // Explicit single-image custom input.
    } else if (mode === 'mossPose' && ['guide', 'identity'].includes(targetHandle) && source.data.kind === 'image' && !isMaskNode(source)) {
      // One pose reference and one optional character sheet.
    } else if (mode === 'frames' && ['first', 'last'].includes(targetHandle) && source.data.kind === 'image') {
      // Keyframe inputs replace one existing source.
    } else if (mode === 'videoSuperResolution' && targetHandle === 'guide' && source.data.kind === 'video') {
      // Video super-resolution accepts only one source video.
    } else if (['swap', 'upscale'].includes(mode) && ((targetHandle === 'guide' && source.data.kind === 'video') || (targetHandle === 'identity' && source.data.kind === 'image'))) {
      // Video source / optional identity.
    } else if (mode === 'characterSheet' && ['body_reference', 'back_reference'].includes(targetHandle) && source.data.kind === 'image') {
      // Explicit optional body/back image reference; replaces only its own role.
    } else if (['imageUpscale', 'identityEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode) && targetHandle === 'guide' && source.data.kind === 'image') {
      // Single-image edit.
    } else if (['outfitEdit', 'localRealism'].includes(mode) && targetHandle === 'identity' && source.data.kind === 'image') {
      // Secondary image input.
    } else return fail('素材类型与输入端口不匹配，请连接对应的图片、视频或遮罩端口。');
  }
  const normalized = { source: source.id, sourceHandle, target: target.id, targetHandle };
  const existing = edges.find((edge) => Object.entries(normalized).every(([key, value]) => edge[key] === value));
  return { connection: normalized, source, target, multiple, existing, resolvedFrom: resolved.resolvedFrom };
}
