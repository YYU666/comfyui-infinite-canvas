import {nativeLODStageRetryPlan} from './native3d-rerun.js';
export function boundaryFailure(value='') {
 const text=String(value);
 const match=text.match(/Original boundary distance exceeds independent shape budget:\s*([\d.eE+-]+)\s*>\s*([\d.eE+-]+)/);
 if(match){const measured=Number(match[1]),limit=Number(match[2]);if(Number.isFinite(measured)&&Number.isFinite(limit)&&measured>limit&&limit>0)return {kind:'distance_exceeded',confirmed:true,measuredMeters:measured,limitMeters:limit,message:`检查确认外轮廓偏差 ${(measured*1000).toFixed(3)} mm，超过允许的 ${(limit*1000).toFixed(3)} mm；尚未修复。`};}
 if(/Original boundary perimeter changed by more than5percent/.test(text))return {kind:'perimeter_exceeded',confirmed:true,message:'检查确认外轮廓周长变化超过5%；尚未修复。'};
 if(/Boundary proof changed connected-component count/.test(text))return {kind:'topology',confirmed:true,message:'检查确认模型连通块数量改变；尚未修复。'};
 if(/Original boundary component Euler characteristic or loop count changed/.test(text))return {kind:'topology',confirmed:true,message:'检查确认外轮廓拓扑或环数量改变；尚未修复。'};
 if(/boundary.*(?:budget|certif)/i.test(text))return {kind:'certificate_incomplete',confirmed:false,message:'外轮廓检查预算不足，尚未确认是否达标；不是已完成修复。'};
 return null;
}
export function lodResolution(data) {
 const geometry=data?.metadata?.geometry;
 if(geometry?.status!=='blocked'||!(data.operation==='source_lod'||data.metadata?.operation==='source_lod'))return null;
 const stage=geometry.retry?.retryStage||geometry.returnedDiagnosticStage||geometry.selectedStage||data.nativeParameters?.retryStage;
 if(geometry.localRepair||data.nativeLocalRepair||data.nativeParameters?.localRepairJobId)return {kind:'local_repair_blocked',stage,repairAttempt:true,available:false,message:`局部修复未通过：${geometry.blocker||'质量检查未通过'}。原候选保持不变。`,reason:'返回原候选后可保留更多面。'};
 const failure=boundaryFailure(geometry.blocker);
 if(!failure||!/^lod[1-4]$/.test(stage||''))return null;
 const policy=geometry.targetPolicy||{},base=policy.percentageBaseTriangles,parent=policy.parentTriangleLimit,current=policy.requestedKeepPercent;
 if(policy.percentageReference!=='lod0'||!Number.isInteger(base)||base<4||!Number.isInteger(parent)||parent<4||!Number.isFinite(current)||current<=0)return {...failure,stage,available:false,reason:'缺少本档比例和父模型预算证据，请查看报告。'};
 const cap=Number.isInteger(policy.frozenFaceCap)&&policy.frozenFaceCap>0?policy.frozenFaceCap:parent;
 const maxFaces=Math.min(parent-1,cap),maxPercent=Math.min(100,maxFaces/base*100),suggested=Math.min(Number((current*1.2).toPrecision(12)),maxPercent);
 const currentFaces=policy.effectiveTargetTriangles??Math.floor(base*current/100),suggestedFaces=Math.min(maxFaces,Math.floor(base*suggested/100));
 return {...failure,stage,baseTriangles:base,currentPercent:current,currentFaces,maxPercent,maxFaces,suggestedPercent:suggested,suggestedFaces,available:suggestedFaces>currentFaces,reason:suggestedFaces>currentFaces?'':'原硬面数上限不允许增加目标面数。'};
}
export function currentLODTitle(data) {
 if(!/^LOD[0-4] · 待生成(?: · (?:未通过诊断|结果))?$/.test(data?.title||'')||!(data.nativeJobId||data.sourceJobId))return data?.title;
 const stage=data.nativeParameters?.retryStage?.toUpperCase()||data.title.split(' · ')[0];
 const state=data.metadata?.geometry?.status==='blocked'?'检查未通过':['queued','running','finishing'].includes(data.status)?'处理中':data.metadata?.geometry?.status==='accepted'?'几何检查通过':data.status==='error'||data.status==='failed'?'失败':'已执行';
 return `${stage} · ${state}`;
}
export function nextDraftNotice(data,inputs={}) {
 if(data?.nativeJobId||data?.nativeRun||data?.status!=='idle')return '';
 if(data?.operation==='bake'&&inputs.high)return '输入已连接；检查设置后手动生成。';
 return data?.nativeNextStepNotice||'';
}

export function resolutionDraft({result,nodes,edges,failureJob,parentJob,projectId,percent,seed,id}) {
 if(failureJob.id!==result?.data.sourceJobId||failureJob.projectId!==projectId||failureJob.operation!=='source_lod'||failureJob.status!=='succeeded')throw Error('失败任务来源不匹配。');
 const geometry=failureJob.result?.metadata?.geometry;
 const resolution=lodResolution({operation:'source_lod',metadata:{geometry}});
 if(!resolution?.available||!Number.isFinite(percent)||percent<=resolution.currentPercent||percent>resolution.maxPercent||Math.floor(resolution.baseTriangles*percent/100)<=resolution.currentFaces)throw Error('新比例必须在原父模型和硬上限内，并实际保留更多面。');
 if(failureJob.parameters?.retryJobId!==parentJob.id||geometry.retry?.retryJobId!==parentJob.id||failureJob.parameters?.retryStage!==resolution.stage||geometry.retry?.retryStage!==resolution.stage||seed===failureJob.parameters.seed||seed===parentJob.parameters?.seed)throw Error('当前档父任务或新种子不匹配。');
 const diagnostics=(failureJob.result?.files||[]).filter(f=>f.name===`blocked_${resolution.stage}.glb`&&f.role==='export');
 if(diagnostics.length!==1||result.data.assetPath!==`assets/${diagnostics[0].sha256}.glb`||result.data.sourceNodeId!==failureJob.nodeId)throw Error('当前诊断模型与失败任务不一致。');
 const key=JSON.stringify([projectId,failureJob.id,resolution.stage]);
 const planned=nativeLODStageRetryPlan(result,nodes.filter(n=>n.id!==id),parentJob,projectId,seed,id);
 if(planned.node.data.nativeLODStageRetry.parentAssetPath!==failureJob.source?.assetPath||planned.node.data.nativeLODStageRetry.parentMeshHash!==geometry.retry?.parentMeshHash||parentJob.id!==planned.target.retryJobId||planned.target.retryStage!==resolution.stage)throw Error('失败任务的确切父模型不一致。');
 const existing=nodes.filter(n=>n.data?.nativeResolution?.key===key);
 if(existing.length>1)throw Error('已有多个调整草稿，请先核对。');
 if(existing.length){
  const node=existing[0],saved=node.data.nativeResolution;
  const links=edges.filter(e=>e.target===node.id&&['model','high'].includes(e.targetHandle)).map(e=>[e.targetHandle,e.source]).sort();
  if(node.data.status!=='idle'||node.data.nativeJobId||node.data.nativeRun||saved.percent!==percent||JSON.stringify(node.data.nativeParameters)!==saved.parametersSnapshot||JSON.stringify(links)!==saved.inputsSnapshot)throw Error('已有调整节点已编辑或启动，请在该节点继续；不会覆盖或重复创建。');
  const expected=JSON.stringify(planned.edges.map(e=>[e.targetHandle,e.source]).sort());
  if(expected!==saved.inputsSnapshot)throw Error('父模型或高模来源已改变。');
  return {node,edges:[],reused:true,resolution};
 }
 const params={...planned.node.data.nativeParameters,retryKeepPercent:percent};
 planned.node.data={...planned.node.data,title:`${resolution.stage.toUpperCase()} · 调整减面比例`,nativeParameters:params,nativeResolution:{key,percent,maxPercent:resolution.maxPercent,failureJobId:failureJob.id,parametersSnapshot:JSON.stringify(params),inputsSnapshot:JSON.stringify(planned.edges.map(e=>[e.targetHandle,e.source]).sort())},nativeNextStepNotice:'从已验收父模型重新减面本档；不是局部修复。检查比例后手动生成，质量阈值不变。'};
 return {...planned,reused:false,resolution};
}
