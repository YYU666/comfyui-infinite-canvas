import {nativeOutputForEdge,nativeOutputNode} from './native3d-output.js';
export const PLAN_FACE_LIMIT=100000;
export const PLAN_BYTE_LIMIT=64*1024*1024;
const hash=/^[a-f0-9]{64}$/;
export const isPlanNode=node=>Boolean(node?.data?.nativeUVPlan);
export const PLAN_EDGE_LAYERS=[
  {key:'ai',label:'AI分区边',color:'#63b3ff',reasons:['high_surface_region_boundary']},
  {key:'convex',label:'凸角结构',color:'#ffcf57',reasons:['convex_structural']},
  {key:'concave',label:'凹角结构',color:'#ff805e',reasons:['concave_structural']},
  {key:'ao',label:'AO补缝',color:'#ff67bb',reasons:['ao_supported_signed_concave']},
  {key:'auxiliary',label:'辅助约束',color:'#b7bdcc',reasons:['high_surface_uncertain_group_guard','coherent_constrained_group_boundary','manual_locked']},
  {key:'unknown',label:'未识别理由',color:'#ba91ff',reasons:[]},
  {key:'legacy',label:'旧版候选边',color:'#ffad51',reasons:[]},
];
export function planEdgeLayers(data,reasonNames) {
  const categorized=Boolean(data.edgeReason && Array.isArray(reasonNames) && reasonNames.length);
  const lists=Object.fromEntries(PLAN_EDGE_LAYERS.map(layer=>[layer.key,[]]));
  for(let i=0;i<data.edges.length/2;i++) {
    const reason=categorized ? reasonNames[data.edgeReason[i]] : undefined;
    const key=categorized ? PLAN_EDGE_LAYERS.find(layer=>layer.reasons.includes(reason))?.key || 'unknown' : 'legacy';
    lists[key].push(data.edges[i*2],data.edges[i*2+1]);
  }
  return {categorized,layers:PLAN_EDGE_LAYERS.map(layer=>({...layer,edges:new Uint32Array(lists[layer.key]),count:lists[layer.key].length/2}))};
}
export function planEdgeLayerVisible(key,mode) {
  if(mode==='seams')return true;
  if(!['regions','convex','details'].includes(mode))return false;
  if(key==='legacy')return mode==='regions';
  return key==='ai' || (key==='convex' && mode!=='regions') || (['concave','ao'].includes(key) && mode==='details');
}
export function nativeInputs(node,nodes,edges) {
  const find=handle=>{const edge=edges.find(e=>e.target===node?.id && e.targetHandle===handle);return nativeOutputForEdge(nodes.find(n=>n.id===edge?.source),edge);};
  return {model:find('model'),high:find('high'),plan:find('plan'),image:find('image')};
}
export function planRecord(job,saved,run,producerNodeId) {
  const plan=job.result?.metadata?.uvPlan;
  if (!plan || !hash.test(plan.planSha256 || '') || plan.version!==1 || !saved['plan:uv-plan-overlay.bin'] || !saved['plan:uv-plan.json']) throw Error('切缝方案缺少已保存的真实数据。');
  const {candidateEdges,...small}=plan;
  return {...small,jobId:job.id,producerNodeId,overlayAssetPath:saved['plan:uv-plan-overlay.bin'].path,planAssetPath:saved['plan:uv-plan.json'].path,
    lowAssetPath:run.sourceAssetPath,highAssetPath:run.highAssetPath,runIdentity:run.identity};
}
export function planConfirmationKey(plan) {
  if (!plan || !hash.test(plan.planSha256 || '') || !hash.test(plan.source?.lowSha256 || '') || !hash.test(plan.source?.highSha256 || '')) throw Error('方案身份无效。');
  return JSON.stringify([plan.jobId,plan.planSha256,plan.lowAssetPath,plan.highAssetPath,plan.source,plan.settings]);
}
export function assertPlanCurrent(plan,nodes,edges,identityOf) {
  planConfirmationKey(plan);
  const producer=nodes.find(n=>n.id===plan.producerNodeId);
  const historical=producer?.data.nativeOutputRecords?.find(r=>r.jobId===plan.jobId&&r.data.nativeUVPlan?.planSha256===plan.planSha256);
  if(historical&&producer.data.nativeJobId!==plan.jobId) {
    if(historical.producerRun?.identity!==plan.runIdentity||planConfirmationKey(historical.data.nativeUVPlan)!==planConfirmationKey(plan))throw Error('历史切缝方案凭据已改变。');
    return plan;
  }
  if (!producer || producer.data.nativeJobId!==plan.jobId || producer.data.nativeRun?.identity!==plan.runIdentity) throw Error('切缝方案来源已改变，请重新预览。');
  const inputs=nativeInputs(producer,nodes,edges);
  if (identityOf(producer,inputs.model,inputs)!==plan.runIdentity) throw Error('模型或方案参数已改变，请重新预览并确认。');
  return plan;
}
export function assertConfirmedPlan(planNode,low,high) {
  planNode=nativeOutputNode(planNode);low=nativeOutputNode(low);high=nativeOutputNode(high);
  const plan=planNode?.data.nativeUVPlan;
  if (!plan || low?.data.assetPath!==plan.lowAssetPath || high?.data.assetPath!==plan.highAssetPath) throw Error('请连接与方案相同的低模和高模参考。');
  const key=planConfirmationKey(plan);
  if (planNode.data.nativeUVPlanConfirmation!==key) throw Error('请先打开3D切缝方案并确认当前方案。');
  return plan;
}
export function planUVParameters(plan,draft,schema) {
  const parameters={};
  for (const key of Object.keys(plan.settings || {})) if (schema.properties?.[key]) {
    if (draft[key]!==undefined && draft[key]!==plan.settings[key]) throw Error('展开设置与已确认方案不同，请回到切缝方案调整并重新确认。');
    parameters[key]=plan.settings[key];
  }
  return {...parameters,planJobId:plan.jobId,planSha256:plan.planSha256};
}
export async function decodePlanOverlay(buffer,overlay,cryptoImpl=globalThis.crypto) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength>PLAN_BYTE_LIMIT || buffer.byteLength!==overlay?.byteLength) throw Error('方案数据大小无效或超出64 MiB。');
  const digest=Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',buffer)),v=>v.toString(16).padStart(2,'0')).join('');
  if (digest!==overlay.sha256) throw Error('方案数据哈希不匹配。');
  const output={}; const types={float32:Float32Array,uint32:Uint32Array,int32:Int32Array,uint8:Uint8Array};
  const expected={positions:['float32',3],faces:['uint32',3],regions:['int32',1],darkness:['float32',1],confidence:['float32',1],supported:['uint8',1],edges:['uint32',2],edgeReason:['uint8',1],highPoints:['float32',3],highRegions:['int32',1],highDarkness:['float32',1]};
  const ranges=[];
  for (const [name,rule] of Object.entries(overlay.arrays || {})) {
    const Type=types[rule.dtype];
    if (!expected[name] || rule.dtype!==expected[name][0] || rule.itemSize!==expected[name][1]) throw Error('方案数组类型无效。');
    if (!Type || !Number.isInteger(rule.offset) || rule.offset<0 || rule.offset%4 || !Number.isInteger(rule.count) || rule.count<0 || !Number.isInteger(rule.itemSize) || rule.itemSize<1 || rule.itemSize>4 || rule.byteLength!==rule.count*rule.itemSize*Type.BYTES_PER_ELEMENT || rule.offset+rule.byteLength>buffer.byteLength) throw Error('方案数组布局无效。');
    output[name]=new Type(buffer,rule.offset,rule.count*rule.itemSize);
    if(rule.byteLength){if(ranges.some(([start,end])=>rule.offset<end&&rule.offset+rule.byteLength>start))throw Error('方案数组重叠。');ranges.push([rule.offset,rule.offset+rule.byteLength]);}
    if (!output[name].every(Number.isFinite)) throw Error('方案数据包含非有限数值。');
  }
  const a=overlay.arrays;
  if (!output.positions || a.positions.count<1 || !output.faces || a.faces.count<1 || a.faces.count>PLAN_FACE_LIMIT || !output.regions || output.regions.length!==a.faces.count || !output.darkness || output.darkness.length!==a.faces.count || !output.edges) throw Error('方案缺少真实几何、分区或AO数据，或超过10万面。');
  if (output.faces.some(v=>v>=a.positions.count) || output.edges.some(v=>v>=a.positions.count) || a.edges.count>600000) throw Error('方案索引超界。');
  for(const name of ['confidence','supported'])if(output[name]&&output[name].length!==a.faces.count)throw Error('方案逐面数据长度不一致。');
  if(output.edgeReason&&output.edgeReason.length!==a.edges.count)throw Error('候选边理由数量不一致。');
  return output;
}
