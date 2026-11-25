import {nativeOutputNode,nativeOutputBinding,nativeOutputCandidates} from './native3d-output.js';
import {findFreePosition} from './canvas-layout.js';
const BUSY=new Set(['uploading','queued','running','finishing']);
export function nativeRerunTarget(result,nodes) {
  result=nativeOutputNode(result);
  const data=result?.data;
  if(result?.type!=='native3d'||data?.operation!=='analyze'||!data.sourceJobId||!data.sourceNodeId)throw new Error('这个节点没有可重试的原处理任务。');
  const processor=nodes.find(node=>node.id===data.sourceNodeId&&node.type==='native3d');
  if(!processor||!['source_lod','uv'].includes(processor.data?.operation))throw new Error('原LOD或UV处理节点已不存在。');
  const activeJob=processor.data.nativeJobId||processor.data.nativeDeliveredJobId;
  if(processor.data.operation==='uv'&&activeJob!==data.sourceJobId)throw new Error('原处理节点已切换任务，请在该处理节点查看当前结果与设置。');
  if(data.status==='stale'||(processor.data.operation==='uv'&&processor.data.status==='stale'))throw new Error('输入已改变，请先在原处理节点核对连接和设置。');
  if(BUSY.has(processor.data.status)||processor.data.nativeSubmissionUncertain)throw new Error('原处理节点正在排队或运行，请等待当前任务结束。');
  if((processor.data.operation==='uv'||activeJob===data.sourceJobId)&&processor.data.nativeDeliveryErrorJobId===activeJob)throw new Error('原处理节点尚待交付，请先在原节点重新交付，避免重复计算。');
  const geometry=data.metadata?.geometry||{};
  const retryStage=data.nativeStage||geometry.returnedDiagnosticStage||geometry.selectedStage||geometry.retry?.retryStage;
  if(processor.data.operation==='source_lod'&&!/^lod[1-4]$/.test(retryStage||''))throw new Error('当前仅支持LOD1至LOD4单档重试；LOD0尚未支持，请从原高模重建LOD0；此按钮不会重跑整链。');
  const retryJobId=geometry.retry?.retryJobId||data.sourceJobId;
  if(processor.data.operation==='source_lod'&&nodes.some(n=>n.data?.operation==='source_lod'&&n.data.nativeParameters?.retryJobId===retryJobId&&n.data.nativeParameters?.retryStage===retryStage&&(BUSY.has(n.data.status)||n.data.nativeSubmissionUncertain)))throw new Error('该LOD已有单档重试排队或运行，请等待完成。');
  return {retryStage,retryJobId,processorId:processor.id,processorTitle:processor.data.title||processor.id,operation:processor.data.operation,
    label:processor.data.operation==='source_lod'?`重新生成${retryStage.toUpperCase()}（新种子）`:'重新分UV',
    scope:processor.data.operation==='source_lod'?'仅重试本档，沿用原设置并更换种子；已完成LOD与旧结果保留。':'使用原处理节点当前连接、参数和已确认切缝方案。'};
}
export function nativeProcessorRunLabel(data,retry=false) {
  if(retry)return '重新交付';
  if(data.operation==='image_to_3d')return '生成模型';
  if(data.operation==='material_wear')return '应用曲率磨损';
  if(data.operation==='uv_plan')return '预览切缝';
  if(data.operation==='uv')return ['failed','error'].includes(data.status)?'重新分UV':'展开确认方案';
  if(data.operation==='source_lod'&&data.nativeParameters?.localRepairStage)return `重新生成${data.nativeParameters.localRepairStage.toUpperCase()}（新种子）`;
  if(data.operation==='source_lod'&&data.nativeParameters?.retryStage)return `重新生成${data.nativeParameters.retryStage.toUpperCase()}（新种子）`;
  if(data.operation==='source_lod'&&(data.nativeDeliveredJobId||data.resultAssetPath||data.metadata?.geometry))return '重新生成LOD链';
  return '生成';
}
export async function withNativeRerunLock(locks,key,action) {
  if(locks.has(key))throw new Error('已提交重试，请勿重复点击。');
  locks.add(key);
  try{return await action();}finally{locks.delete(key);}
}
export function nativeAutomaticLODStages(data) {
  if(data?.metadata?.operation!=='source_lod')return [];
  return (data.metadata.geometry?.stages||[]).filter(record=>record.visible!==false&&/^lod[0-4]$/.test(record.stage||'')&&record.stage!==(data.metadata.geometry.returnedDiagnosticStage||data.metadata.geometry.selectedStage||data.metadata.geometry.retry?.retryStage||`lod${data.metadata.geometry.selectedLodLevel}`)).flatMap(record=>{
    const metrics=record.receipt?.geometry||record.receipt?.after||record.geometry;
    if(record.status==='accepted'&&record.eligibleForDownstream===true&&metrics?.status==='accepted'&&metrics.intersectionComplete===true&&metrics.intersection_pairs_count===0)
      return [{stage:record.stage,diagnostic:false}];
    if(record.status==='blocked'&&record.eligibleForDownstream===false&&metrics?.status==='blocked'&&record.diagnosticFilename===`blocked_${record.stage}.glb`&&/^[a-f0-9]{64}$/i.test(record.diagnosticFileSha256||''))
      return [{stage:record.stage,diagnostic:true}];
    return [];
  });
}

// Called synchronously at delivery commit, after asynchronous posters finish.
export function layoutNativeResultDelivery(nodes,result,plans) {
  const existing=nodes.find(n=>n.id===result.id);
  if(existing&&existing.data?.sourceJobId!==result.data.sourceJobId)throw new Error('结果节点来源已改变，拒绝覆盖。');
  const processor=nodes.find(n=>n.id===result.data.sourceNodeId);
  const desired=processor?{x:processor.position.x+390,y:processor.position.y}:result.position;
  const placed={...result,position:existing?.position||findFreePosition(nodes,desired,'native3d')};
  let occupied=nodes.filter(n=>n.id!==placed.id).concat(placed);
  const stages=plans.map(plan=>{
    const live=occupied.find(n=>n.id===plan.node.id);
    if(live&&(live.data?.sourceJobId!==plan.node.data.sourceJobId||live.data?.assetPath!==plan.node.data.assetPath))throw new Error('阶段素材来源已改变，拒绝覆盖。');
    const node={...plan.node,position:live?.position||findFreePosition(occupied,{x:placed.position.x+420,y:placed.position.y},'native3d')};
    occupied=occupied.filter(n=>n.id!==node.id).concat(node);
    return {...plan,node,existing:Boolean(live)};
  });
  return {result:placed,plans:stages};
}

export function nextNativeLODSeed(nodes,retryJobId,retryStage,cryptoImpl=globalThis.crypto) {
  const used=new Set(nodes.filter(n=>n.data?.nativeParameters?.retryJobId===retryJobId&&n.data.nativeParameters.retryStage===retryStage)
    .flatMap(n=>[n.data.nativeParameters.seed,n.data.nativeRun?.parameters?.seed,n.data.nativeLODLastSubmittedSeed]).filter(Number.isInteger));
  for(let i=0;i<16;i++){const seed=cryptoImpl.getRandomValues(new Uint32Array(1))[0];if(!used.has(seed))return seed;}
  throw new Error('未取得新的随机seed，请稍后重试。');
}
export function nativeLODStageRetryPlan(result,nodes,job,projectId,seed,id) {
  const target=nativeRerunTarget(result,nodes);
  if(target.operation!=='source_lod'||job.id!==target.retryJobId||job.projectId!==projectId||job.operation!=='source_lod'||job.status!=='succeeded')throw new Error('单档重试的原任务身份不匹配。');
  if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw new Error('seed必须为uint32。');
  const parentStage=`lod${Number(target.retryStage.slice(3))-1}`;
  const records=(job.result?.metadata?.geometry?.stages||[]).filter(s=>s.stage===parentStage);
  const parent=records[0],metrics=parent?.receipt?.geometry||parent?.receipt?.after||parent?.geometry;
  if(records.length!==1||parent.status!=='accepted'||parent.eligibleForDownstream!==true||metrics?.status!=='accepted'||metrics.intersectionComplete!==true||metrics.intersection_pairs_count!==0)throw new Error('原任务缺少通过完整检查的直接父LOD。');
  const files=(job.result?.files||[]).filter(f=>f.name===parent.filename&&f.role==='export');
  if(files.length!==1||!/^[a-f0-9]{64}$/.test(files[0].sha256||'')||!/^[a-f0-9]{64}$/.test(parent.mesh_hash||''))throw new Error('父LOD文件或几何哈希缺失。');
  const parentAsset=`assets/${files[0].sha256}.glb`;
  const parents=nativeOutputCandidates(nodes).filter(n=>{
    const d=n.data,g=d?.metadata?.geometry;
    if(n.type!=='native3d'||d?.operation!=='analyze'||d.sourceJobId!==job.id||d.assetPath!==parentAsset||g?.status!=='accepted'||d.status==='stale'||d.nativeStageDiagnostic)return false;
    const stages=[d.nativeStage,g.selectedStage].filter(v=>v!=null),levels=[d.nativeLODLevel,g.selectedLodLevel].filter(v=>v!=null);
    const level=Number(parentStage.slice(3));
    if(stages.some(v=>v!==parentStage)||levels.some(v=>v!==level)||(!stages.length&&!levels.length))return false;
    return g.selectedMeshHash==null||g.selectedMeshHash===parent.mesh_hash;
  });
  if(!parents.length)throw new Error(`请先在画布确认原任务的${parentStage.toUpperCase()}父模型，不能替换为其他模型。`);
  const highAsset=job.source?.highAssetPath,highSha=job.source?.highSha256;
  if(!highAsset||!/^[a-f0-9]{64}$/.test(highSha||'')||!highAsset.startsWith(`assets/${highSha}.`))throw new Error('原高模来源哈希缺失或改变。');
  const high=nodes.find(n=>n.type==='native3d'&&n.data?.operation==='analyze'&&n.data.assetPath===highAsset&&!n.data.sourceJobId&&n.data.status!=='stale');
  if(!high)throw new Error('原高模参考节点缺失，请恢复原高模后重试。');
  if(nodes.some(n=>n.id===id))throw new Error('新重试节点ID冲突。');
  const parameters={...(job.parameters||{})};delete parameters.localRepairMaxPatches;delete parameters.localRepairDisplacementFraction;delete parameters.localRepairCorrectionFraction;delete parameters.localRepairJobId;delete parameters.localRepairStage;delete parameters.retryJobId;delete parameters.retryStage;delete parameters.seed;
  Object.assign(parameters,{retryJobId:job.id,retryStage:target.retryStage,seed});
  const node={id,type:'native3d',position:findFreePosition(nodes,{x:result.position.x+390,y:result.position.y},'native3d'),data:{title:`${target.retryStage.toUpperCase()} · 单档重试`,operation:'source_lod',status:'idle',nativeParameters:parameters,
    nativeLODStageRetry:{retryJobId:job.id,retryStage:target.retryStage,parentStage,parentAssetPath:parentAsset,parentMeshHash:parent.mesh_hash,highAssetPath:highAsset,seed,originResultId:result.id}}};
  return {node,edges:[{id:`${id}-parent`,source:parents[0].id,sourceHandle:'model',target:id,targetHandle:'model',data:nativeOutputBinding(parents[0])},{id:`${id}-high`,source:high.id,sourceHandle:'model',target:id,targetHandle:'high'}],target};
}
