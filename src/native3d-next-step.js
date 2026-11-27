import {nativeOutputNode,nativeOutputBinding,nativeLogicalNodeId,nativeOutputCandidates,nativeOutputForEdge} from './native3d-output.js';
import {nativeModelIdentity,nativeGeometryInputError,nativeBoundaryReviewParameters} from './native3d.js';
import {planConfirmationKey,assertConfirmedPlan} from './native3d-plan.js';
import {findFreePosition} from './canvas-layout.js';
const hash=/^[a-f0-9]{64}$/;
const jobPattern=/^n3d_[a-f0-9]{32}$/;
export function nextStepOrigin(node) {node=nativeOutputNode(node);return JSON.stringify([nativeLogicalNodeId(node),node?.data?.sourceJobId,node?.data?.assetPath,nativeModelIdentity(node),node?.data?.nativeUVPlan?planConfirmationKey(node.data.nativeUVPlan):null,node?.data?.nativeUVPlanConfirmation]);}
export function needsCanonicalLODStage(data) {
 if(data?.metadata?.operation!=='source_lod'||data.metadata.geometry?.status!=='accepted')return false;
 const selected=data.nativeStage||data.metadata.geometry.selectedStage||`lod${data.nativeLODLevel??data.metadata.geometry.selectedLodLevel}`;
 const records=(data.metadata.geometry.stages||[]).filter(r=>r.stage===selected&&r.status==='accepted'&&r.eligibleForDownstream===true);
 if(records.length!==1)return false;
 const assets=(data.nativeArtifacts||[]).filter(a=>a.name===records[0].filename&&a.role==='export');
 return assets.length===1&&/^assets\/[a-f0-9]{64}\.glb$/.test(assets[0].assetPath||'')&&data.assetPath!==assets[0].assetPath;
}
export function lodCountOf(data) {
 const stored = data?.nativeParameters?.lodCount ?? data?.metadata?.geometry?.settings?.lodCount;
 return Number.isInteger(stored) && stored >= 1 && stored <= 5 ? stored : 5;
}
export function lodStageLabel(level, lodCount = 3) {
 const names = ['High（高模）', 'Medium（中模）', 'Low（低模）'];
 if (Number.isInteger(level) && level >= 0 && level < names.length) return names[level];
 return `LOD${level}`;
}
export function nextStepActions(node) {
 node=nativeOutputNode(node);
 const d=node?.data;if(node?.type!=='native3d'||d.operation!=='analyze'||d.status!=='completed')return [];
 if(d.nativeStageDiagnostic||d.metadata?.geometry?.status==='blocked'){
  if(nativeBoundaryReviewParameters(node)&&d.metadata?.operation==='source_lod')return [{action:'uv_plan_reviewed',label:'带轮廓警告继续UV'}];
  if(!nativeBoundaryReviewParameters(node)||!['uv_plan','uv'].includes(d.metadata?.operation))return [];
 }
 if(needsCanonicalLODStage(d))return [];
 if(d.nativeUVPlan){let confirmed=false;try{confirmed=d.nativeUVPlanConfirmation===planConfirmationKey(d.nativeUVPlan);}catch{}return [{action:'unwrap',label:'展开UV',disabled:!confirmed}];}
 if(d.metadata?.operation==='source_lod'&&d.metadata.geometry.status==='accepted'){
  const level=d.nativeLODLevel??d.metadata.geometry.selectedLodLevel;
  const lodCount=lodCountOf(d);
  return [...(Number.isInteger(level)&&level>=0&&level<Math.min(4,lodCount-1)?[{action:'next_lod',label:`继续${lodStageLabel(level+1,lodCount)}`}]:[]),{action:'uv_plan',label:'制作UV'}];
 }
 if(d.metadata?.operation==='uv'&&d.metadata?.uv)return [{action:'bake',label:'烘焙材质'}];
 return [];
}
function persistedGeneratedModel(node,path) {
 const data=node?.data;
 return node?.type==='media'&&data?.kind==='model'&&data.output===true&&data.assetPath===path&&/^assets\/[a-f0-9]{64}\.glb$/i.test(path||'');
}
function exactNode(nodes,path,preferredId,reviewParameters=null) {
 const values=nativeOutputCandidates(nodes).filter(n=>persistedGeneratedModel(n,path)||(n.type==='native3d'&&n.data.operation==='analyze'&&n.data.assetPath===path&&n.data.status==='completed'&&(!n.data.nativeStageDiagnostic||(reviewParameters&&!nativeGeometryInputError(n,'uv',reviewParameters)))));
 if(!values.length)throw Error('确切来源模型缺失，请先核对来源连接。');
 return values.find(n=>n.id===preferredId)||values.filter(n=>!n.data.sourceJobId).sort((a,b)=>a.id.localeCompare(b.id))[0]||values.sort((a,b)=>a.id.localeCompare(b.id))[0];
}
function highFor(job,nodes,edges,source) {
 const baseHigh=job.operation==='source_lod'&&!job.parameters?.retryJobId&&job.result?.metadata?.geometry?.sourceFileSha256===job.source?.sha256;
 const path=job.source?.highAssetPath||(baseHigh?job.source?.assetPath:null),sha=job.source?.highSha256||(baseHigh?job.source?.sha256:null);
 if(!hash.test(sha||'')||!path?.startsWith(`assets/${sha}.`))throw Error('任务缺少确切原高模来源，未猜测其他高模。');
 return exactNode(nodes,path,edges.find(e=>e.target===source.data.sourceNodeId&&e.targetHandle==='high')?.source);
}
export function nativeNextStepPlan({source,nodes,edges,job,projectId,action,seed,id}) {
 source=nativeOutputNode(source);
 const d=source?.data;
 const offered=nextStepActions(source).find(x=>x.action===action);
 if(!offered||offered.disabled)throw Error('当前结果尚不允许此下一步，请先检查或确认方案。');
 if(!jobPattern.test(d.sourceJobId||'')||job.id!==d.sourceJobId||job.projectId!==projectId||job.status!=='succeeded')throw Error('当前结果任务来源不匹配。');
 const review=nativeBoundaryReviewParameters(source);
 if(nativeGeometryInputError(source,action==='bake'?'bake':'uv_plan',review||{}))throw Error('当前几何未通过检查。');
 const selectedInputs={model:source};
 let operation,parameters={},inputs={model:source.id},notice='节点已创建；检查设置后点击生成。';
 if(action==='uv_plan_reviewed') {
  if(job.operation!=='source_lod'||!review||review.reviewedBoundaryJobId!==job.id)throw Error('缺少当前候选的明确轮廓复核来源。');
  const record=(job.result?.metadata?.geometry?.stages||[]).find(r=>r.stage===review.reviewedBoundaryStage);
  const bound={...source,data:{...d,metadata:job.result.metadata}};
  const authoritative=nativeBoundaryReviewParameters(bound);
  const files=(job.result?.files||[]).filter(f=>f.name===record?.diagnosticFilename&&f.role==='export');
  if(!authoritative||JSON.stringify(authoritative)!==JSON.stringify(review)||files.length!==1||files[0].sha256!==record.diagnosticFileSha256)throw Error('轮廓复核模型或完整几何检查证据不匹配。');
  selectedInputs.high=highFor(job,nodes,edges,source);inputs.high=selectedInputs.high.id;operation='uv_plan';parameters={resolution:4096,padding:16,orientationConfirmed:false,...review};
  notice='按当前外观继续UV测试；原轮廓偏差警告保留。先检查朝向，再预览切缝。';
 } else if(action==='next_lod'||action==='uv_plan') {
  if(job.operation!=='source_lod')throw Error('需要真实LOD来源任务。');
  const stage=d.nativeStage||d.metadata.geometry.selectedStage||`lod${d.nativeLODLevel??d.metadata.geometry.selectedLodLevel}`;
  const records=(job.result?.metadata?.geometry?.stages||[]).filter(r=>r.stage===stage);const record=records[0],g=record?.receipt?.geometry||record?.receipt?.after||record?.geometry;
  const files=(job.result?.files||[]).filter(f=>f.name===record?.filename&&f.role==='export');
  if(records.length!==1||record.status!=='accepted'||record.eligibleForDownstream!==true||g?.status!=='accepted'||g.intersectionComplete!==true||g.intersection_pairs_count!==0||files.length!==1||!hash.test(files[0].sha256||'')||d.assetPath!==`assets/${files[0].sha256}.glb`||g.mesh_hash!==record.mesh_hash||(d.metadata.geometry.selectedMeshHash&&d.metadata.geometry.selectedMeshHash!==record.mesh_hash)||(record.file_sha256&&record.file_sha256!==files[0].sha256))throw Error('当前LOD文件或完整质量证据不匹配。');
  selectedInputs.high=highFor(job,nodes,edges,source);inputs.high=selectedInputs.high.id;
  if(action==='next_lod') {
   const level=Number(stage.slice(3))+1;if(!/^lod[0-3]$/.test(stage)||!Number.isInteger(seed)||seed<0||seed>4294967295)throw Error('下一档或新种子无效。');
   const geometry=job.result.metadata.geometry,lod0=geometry.logicalLevels?.find(row=>row.lodLevel===0)?.triangles||geometry.retry?.lod0Triangles||geometry.localRepair?.lod0Triangles;
   if(record.file_sha256!==files[0].sha256||!Number.isInteger(lod0)||lod0<4||!geometry.settings||(geometry.retry?.originalSourceSha256||geometry.sourceFileSha256)!==(job.source?.highSha256||job.source?.sha256)||seed===job.parameters?.seed)throw Error('下一档缺少原始LOD0基数、设置、父文件证据或新的种子。');
   operation='source_lod';parameters={...job.parameters};for(const key of Object.keys(parameters))if(['retryJobId','retryStage','retryKeepPercent','seed'].includes(key)||key.startsWith('localRepair'))delete parameters[key];
   Object.assign(parameters,{retryJobId:job.id,retryStage:`lod${level}`,selectedLodLevel:level,seed});
  } else {operation='uv_plan';parameters={resolution:4096,padding:16,orientationConfirmed:false};notice='请先核对模型朝向与切缝设置，再预览方案。';}
 } else if(action==='unwrap') {
  if(job.operation!=='uv_plan')throw Error('切缝来源任务不匹配。');
  const plan=d.nativeUVPlan;
  if(plan.jobId!==job.id||plan.planSha256!==job.result?.metadata?.uvPlan?.planSha256||plan.source?.lowSha256!==job.source?.sha256||plan.source?.highSha256!==job.source?.highSha256||plan.lowAssetPath!==job.source?.assetPath||plan.highAssetPath!==job.source?.highAssetPath)throw Error('确认方案与真实任务来源不一致。');
  const low=exactNode(nodes,plan.lowAssetPath,edges.find(e=>e.target===plan.producerNodeId&&e.targetHandle==='model')?.source,plan.settings),high=exactNode(nodes,plan.highAssetPath,edges.find(e=>e.target===plan.producerNodeId&&e.targetHandle==='high')?.source);assertConfirmedPlan(source,low,high);
  Object.assign(selectedInputs,{model:low,high,plan:source});inputs={model:low.id,high:high.id,plan:source.id};operation='uv';parameters=review?{...review}:{};
 } else {
  if(job.operation!=='uv')throw Error('需要真实UV结果。');
  const model=(job.result?.files||[]).find(f=>f.role==='model'&&f.name==='model.glb');
  const flags=job.result?.metadata?.uv?.qualityFlags;
  if(!model||d.assetPath!==`assets/${model.sha256}.glb`||!['exactGeometry','rasterOverlapFree','nondegenerateUV','noMixedFlip','paddingPixelCenters','geometricOverlapFree','geometricPadding','geometricBounds'].every(key=>flags?.[key]===true))throw Error('UV结构检查或结果文件不匹配，不能继续烘焙。');
  operation='bake';parameters={resolution:4096,rayDistance:.02,padding:64,aoSamples:256,aoRadiusFraction:.1,aoAttenuation:'linear',...(review||{})};
  // Geometry identity alone is not proof of material-high identity. Keep this
  // input explicit until a verifiable, unique material source is available.
  notice='请连接带材质的原高模，再检查烘焙设置。';
 }
 const origin=nextStepOrigin(source),key=JSON.stringify([projectId,nativeLogicalNodeId(source),action,origin]);
 const inputSnapshot=JSON.stringify(Object.entries(selectedInputs).filter(([handle])=>Object.hasOwn(inputs,handle)).map(([handle,node])=>[handle,nativeLogicalNodeId(node)]).sort());
 const existing=nodes.filter(n=>n.data?.nativeNextStep?.key===key || (n.data?.nativeNextStep?.sourceJobId===d.sourceJobId&&n.data.nativeNextStep.action===action&&n.data.nativeNextStep.origin===origin));
 if(existing.length>1)throw Error('已有多个下一步节点，请先整理草稿。');
 if(existing.length){
  const node=existing[0];const expected=node.data.nativeNextStep;
  if(node.data.nativeJobId||node.data.nativeRun||node.data.status!=='idle')throw Error('此下一步节点已启动或已结束，请查看已有节点；不会重复创建。');
  const actualEdges=edges.filter(e=>e.target===node.id&&['model','high','plan'].includes(e.targetHandle)).map(e=>[e.targetHandle,nativeLogicalNodeId(nativeOutputForEdge(nodes.find(n=>n.id===e.source),e))]).sort();
  if(expected.inputsSnapshot!==inputSnapshot||node.data.operation!==operation||JSON.stringify(node.data.nativeParameters)!==expected.parametersSnapshot||JSON.stringify(actualEdges)!==expected.inputsSnapshot)throw Error('已创建的下一步节点已修改或改线，请继续使用该节点；不会覆盖或重复创建。');
  return {node,edges:[],reused:true,notice:node.data.nativeNextStepNotice,origin};
 }
 if(nodes.some(n=>n.id===id))throw Error('节点ID冲突。');
 const links=Object.entries(inputs).map(([targetHandle,source])=>({id:`${id}-${targetHandle}`,source,sourceHandle:targetHandle==='plan'?'plan':'model',target:id,targetHandle,data:nativeOutputBinding(selectedInputs[targetHandle])}));
 const title=action==='next_lod'?`${lodStageLabel(Number(parameters.retryStage.slice(3)),lodCountOf(d))} · 待生成`:({uv_plan:'UV切缝方案',uv_plan_reviewed:'UV切缝方案 · 轮廓待复核',unwrap:'UV展开',bake:'4K材质烘焙'})[action];
 const node={id,type:'native3d',position:findFreePosition(nodes,{x:source.position.x+390,y:source.position.y},'native3d'),data:{title,operation,status:'idle',nativeParameters:parameters,nativeNextStepNotice:notice,nativeNextStep:{key,sourceId:source.id,sourceJobId:job.id,action,origin,parametersSnapshot:JSON.stringify(parameters),inputsSnapshot:inputSnapshot}}};
 return {node,edges:links,reused:false,notice,origin};
}
