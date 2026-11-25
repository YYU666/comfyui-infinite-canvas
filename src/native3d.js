import {nativeOutputNode,nativeLogicalNodeId,nativeOutputBinding} from './native3d-output.js';
export const AI_LOWPOLY_PRESET = Object.freeze({
  id: 'meshanything-v2-demo-v1', label: '标准减面 v1', version: 1,
  sourceJobId: 'n3d_c5585a492d454bf0a87ed641f64e7b9d',
  checkpointSha256: 'c7cb232f2dcede0e03921f373e659a1415bb2fb852faf1ad271803450d878ad0',
  parameters: Object.freeze({ conditioningProfile: 'legacy_world_fp16', inputSeed: 0, seed: 0, sampling: false }),
});
export function nativeLowpolyPresetLabel(data) {
  if (data.operation !== 'ai_lowpoly') return null;
  return Object.entries(AI_LOWPOLY_PRESET.parameters).every(([key,value]) => data.nativeParameters?.[key] === value)
    ? AI_LOWPOLY_PRESET.label : '自定义 / 已有配方';
}
export const NATIVE3D_PRESETS = {
  model_asset: ['native3d', { title: '3D模型', operation: 'analyze' }],
  model_lowpoly: ['native3d', { title: 'AI低模', operation: 'ai_lowpoly', nativePresetId: AI_LOWPOLY_PRESET.id, get nativeParameters() { return { ...AI_LOWPOLY_PRESET.parameters }; } }],
  model_lod: ['native3d', { title: '原高模 · 百分比LOD', operation: 'source_lod' }],
  model_lod_legacy: ['native3d', { title: 'AI低模 · 修复减面（兼容）', operation: 'repair_lod' }],
  model_uv_plan: ['native3d', { title: 'UV切缝方案', operation: 'uv_plan' }],
  model_uv: ['native3d', { title: 'UV展开', operation: 'uv' }],
  model_bake: ['native3d', { title: '材质烘焙', operation: 'bake' }],
  model_image_to_3d: ['native3d', { title: '图生模型 · 本地 TripoSR', operation: 'image_to_3d' }],
  model_material_wear: ['native3d', { title: '曲率磨损', operation: 'material_wear' }],
};
export const isNative3D = (node) => node?.type === 'native3d';
export function isGeneratedGLB(node) {
  const data = node?.data;
  if (node?.type !== 'media' || data?.kind !== 'model' || data.output !== true) return false;
  if (/^assets\/[a-f0-9]{64}\.glb$/i.test(data.assetPath || '')) return true;
  return typeof data.url === 'string' && data.url.startsWith('/api/comfy/view?')
    && data.type === 'output' && /\.glb$/i.test(data.filename || data.name || '');
}
export const nativeAssetUrl = (projectId, path) => /^assets\/[a-zA-Z0-9_.-]+$/.test(path || '') ? `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(path.slice(7))}` : null;
export function nativeAdapterSchema(adapter) { return adapter?.parameters || adapter?.parameterSchema || adapter?.schema || { properties: {} }; }
export function nativeParameterValue(adapter, draft, key, rule) {
  const oldDefault = adapter?.operation === 'ai_lowpoly' ? ({ conditioningProfile: 'canonical_safe', inputSeed: 42 })[key] : undefined;
  return draft?.[key] ?? oldDefault ?? rule.default;
}
export function nativeParameters(adapter, draft = {}) {
  const schema = nativeAdapterSchema(adapter); const result = {};
  for (const key of Object.keys(draft)) if (!Object.hasOwn(schema.properties || {}, key)) throw new Error(`不支持的参数：${key}`);
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    if(key.startsWith('localRepair')&&!draft.localRepairJobId)continue;
    const value = nativeParameterValue(adapter, draft, key, rule);
    if (value === undefined) { if (schema.required?.includes(key)) throw new Error(`缺少参数：${key}`); continue; }
    if (!['string', 'number', 'integer', 'boolean'].includes(rule.type)) throw new Error(`不支持的参数类型：${key}`);
    if ((rule.type === 'integer' && !Number.isInteger(value)) || (rule.type === 'number' && !Number.isFinite(value)) || (rule.type === 'string' && typeof value !== 'string') || (rule.type === 'boolean' && typeof value !== 'boolean')) throw new Error(`参数类型错误：${key}`);
    if ((rule.minimum != null && value < rule.minimum) || (rule.maximum != null && value > rule.maximum) || (rule.enum && !rule.enum.includes(value))) throw new Error(`参数超出范围：${key}`);
    if (rule.pattern && !(new RegExp(rule.pattern)).test(value)) throw new Error(`参数格式错误：${key}`);
    result[key] = value;
  }
  return result;
}
export function nativeBoundaryReviewParameters(source) {
  const d=source?.data,review=d?.metadata?.geometryReview;
  if(review?.status==='experimental_reviewed' && /^n3d_[a-f0-9]{32}$/.test(review.reviewedBoundaryJobId||'') && /^lod[0-4]$/.test(review.reviewedBoundaryStage||''))
    return {reviewedBoundaryJobId:review.reviewedBoundaryJobId,reviewedBoundaryStage:review.reviewedBoundaryStage};
  const g=d?.metadata?.geometry,stage=d?.nativeStage||g?.returnedDiagnosticStage;
  if(g?.status!=='blocked'||!/^lod[0-4]$/.test(stage||'')||!/^n3d_[a-f0-9]{32}$/.test(d?.sourceJobId||'')||!/^Original boundary distance exceeds independent shape budget:/.test(g.blocker||''))return null;
  const records=(g.stages||[]).filter(r=>r.stage===stage),r=records[0],audit=r?.receipt?.geometry;
  if(records.length!==1||r.status!=='blocked'||r.eligibleForDownstream!==false||audit?.status!=='accepted'||audit.intersectionComplete!==true||audit.intersection_pairs_count!==0||audit.mesh_hash!==r.mesh_hash||!r.diagnosticFileSha256||d.assetPath!==`assets/${r.diagnosticFileSha256}.glb`)return null;
  return {reviewedBoundaryJobId:d.sourceJobId,reviewedBoundaryStage:stage};
}
export function nativeGeometryInputError(source, operation, parameters={}) {
  const geometry=source?.data.metadata?.geometry;
  const rawAI=source?.data.metadata?.operation==='ai_lowpoly';
  const review=nativeBoundaryReviewParameters(source);
  if(review && parameters.reviewedBoundaryJobId===review.reviewedBoundaryJobId && parameters.reviewedBoundaryStage===review.reviewedBoundaryStage)return null;
  return ['uv','uv_plan','bake'].includes(operation) && (rawAI || ((source?.data.nativeGeometryProvenance || geometry) && geometry?.status !== 'accepted'))
    ? '修复与减面结果未通过几何检查，仅可查看诊断，不能继续UV或烘焙。' : null;
}
export function nativeModelIdentity(node) {
  node=nativeOutputNode(node);
  const data=node?.data || {},geometry=data.metadata?.geometry || {},provenance=data.nativeStageProvenance || {};
  // Stable source/approval evidence only: progress, display labels and reports
  // are intentionally excluded. Same-path lineage or acceptance edits matter.
  return [nativeLogicalNodeId(node),data.assetPath,data.originalAssetPath,data.sourceJobId,data.sourceNodeId,
    data.nativeDeliveredJobId || data.nativeJobId,data.nativeStage,data.nativeLODLevel,
    Boolean(data.nativeGeometryProvenance),data.status==='completed',data.metadata?.operation,geometry.status,
    typeof data.quality==='string'?data.quality:data.quality?.status,
    data.metadata?.sourceSha256,data.metadata?.highSourceSha256,geometry.source_mesh_hash,geometry.selectedStage,geometry.selectedMeshHash,
    ...['processorNodeId','referenceNodeId','parentStage','parentMeshHash','parentTriangles','stageIndex','lodLevel','sourceMode'].map(key=>provenance[key]),...(data.metadata?.geometryReview?[data.metadata.geometryReview]:[])];
}
export function nativeRunIdentity(node, source, inputs) { source=nativeOutputNode(source);return JSON.stringify([nativeLogicalNodeId(source), source?.data.assetPath, source?.data.originalAssetPath || source?.data.assetPath, node.data.operation, node.data.adapterId || '', node.data.nativeParameters || {},...(inputs ? [nativeModelIdentity(source),nativeModelIdentity(inputs.high),nativeLogicalNodeId(inputs.plan),inputs.plan?.data.nativeUVPlan?.planSha256,inputs.plan?.data.nativeUVPlanConfirmation] : [])]); }
export function nativeModelConnection(connection, source, target, edges) {
  source=nativeOutputNode(source);
  if (!isNative3D(source) && !isNative3D(target)) return null;
  if (isNative3D(target) && target.data.operation === 'image_to_3d') {
    if (connection.targetHandle !== 'image' || connection.sourceHandle !== 'ref' || source?.type !== 'media'
      || source.data.kind !== 'image' || source.data.mediaRole === 'mask') {
      return { error: '图生模型的参考图端口只接普通图片。' };
    }
    const normalized = { source:source.id, target:target.id, sourceHandle:'ref', targetHandle:'image' };
    return { connection:normalized, source, target, multiple:false,
      existing:edges.find(edge => Object.entries(normalized).every(([key,value]) => edge[key] === value)) };
  }
  if (isNative3D(source) && isNative3D(target) && connection.targetHandle==='plan') {
    if (target.data.operation!=='uv' || connection.sourceHandle!=='plan' || !source.data.nativeUVPlan || source.data.status!=='completed') return {error:'切缝方案输出仅连接UV展开的方案输入。'};
    return {connection:{source:source.id,target:target.id,sourceHandle:'plan',targetHandle:'plan',data:nativeOutputBinding(source)},source,target,multiple:false};
  }
  if (isNative3D(source) && isNative3D(target) && connection.targetHandle==='high') {
    if (!(['uv_plan','uv','bake'].includes(target.data.operation) || (target.data.operation==='source_lod' && /^lod[1-4]$/.test(target.data.nativeParameters?.retryStage || target.data.nativeParameters?.localRepairStage || ''))) || connection.sourceHandle!=='model' || !source.data.assetPath || source.data.nativeUVPlan) return {error:'请将已保存的高模模型连接到高模参考输入。'};
    return {connection:{source:source.id,target:target.id,sourceHandle:'model',targetHandle:'high',data:nativeOutputBinding(source)},source,target,multiple:false};
  }
  if (isGeneratedGLB(source) && isNative3D(target) && ['source_lod','repair_lod'].includes(target.data.operation)
      && connection.sourceHandle === 'model' && connection.targetHandle === 'model') {
    const normalized = { source: source.id, target: target.id, sourceHandle: 'model', targetHandle: 'model' };
    return { connection: normalized, source, target, multiple: false,
      existing: edges.find(edge => Object.entries(normalized).every(([key,value]) => edge[key] === value)) };
  }
  if (source?.data.nativeUVPlan) return {error:'切缝方案不是模型，请连接方案端口。'};
  if (!isNative3D(source) || !isNative3D(target) || !source.data.assetPath || target.data.operation === 'analyze' || connection.targetHandle !== 'model' || connection.sourceHandle !== 'model') return { error: '请将已保存的3D模型输出连接到处理节点的模型输入。' };
  if (target.data.operation === 'material_wear' && source.data.metadata?.operation !== 'bake') {
    return { error: '曲率磨损输入应连接已完成的材质烘焙。' };
  }
  const geometryError=nativeGeometryInputError(source,target.data.operation,target.data.nativeParameters);
  if (geometryError) return {error:geometryError};
  const normalized = { source: source.id, target: target.id, sourceHandle: 'model', targetHandle: 'model',...(source.nativeOutputRecordId?{data:nativeOutputBinding(source)}:{}) };
  return { connection: normalized, source, target, multiple: false, existing: edges.find(e => Object.entries(normalized).every(([k,v]) => k==='data'?e.data?.outputRecordId===v.outputRecordId:e[k] === v)) };
}
export async function nativeRequest(path, body, headers = {}) {
  const response = await fetch(`/api/native3d${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.ok === false) {
    const error = new Error(typeof value.error === 'string' ? value.error : value.error?.message || value.message || `3D服务不可用（HTTP ${response.status}）`);
    error.status = response.status;
    error.code = value.code;
    error.details = value.details;
    throw error;
  }
  return value;
}
export function nativeDeliveryState(node, source, job, inputs) {
  if (!node || node.data.nativeJobId !== job.id || node.data.nativeDeliveredJobId === job.id) return 'skip';
  if (node.data.nativeRun?.identity !== nativeRunIdentity(node,source,inputs)) return 'stale';
  return 'current';
}
