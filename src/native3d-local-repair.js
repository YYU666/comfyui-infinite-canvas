import {nativeOutputNode,nativeOutputForEdge,nativeOutputBinding} from './native3d-output.js';
import {boundaryFailure} from './native3d-lod-resolution.js';
import {findFreePosition} from './canvas-layout.js';
export function localRepairDraft({bound,nodes,edges,job,projectId,id,settings={}}) {
 bound=nativeOutputNode(bound);
 const d=bound?.data,g=job.result?.metadata?.geometry,stage=g?.returnedDiagnosticStage||g?.retry?.retryStage||g?.selectedStage;
 if(job.id!==(d?.sourceJobId||d?.nativeJobId)||job.projectId!==projectId||job.operation!=='source_lod'||job.status!=='succeeded'||g?.status!=='blocked'||!boundaryFailure(g.blocker)||!/^lod[1-4]$/.test(stage||''))throw Error('当前候选不是可修复的未通过LOD。');
 const files=(job.result.files||[]).filter(f=>f.name===`blocked_${stage}.glb`&&f.role==='export');
 if(files.length!==1||!/^[a-f0-9]{64}$/.test(files[0].sha256))throw Error('缺少唯一的当前候选证据。');
 const candidatePath=`assets/${files[0].sha256}.glb`,highPath=job.source?.highAssetPath,highHash=job.source?.highSha256;
 if(!/^[a-f0-9]{64}$/.test(highHash||'')||!highPath?.startsWith(`assets/${highHash}.`))throw Error('缺少原高模绑定。');
 const high=nodes.find(n=>n.type==='native3d'&&n.data.operation==='analyze'&&n.data.status==='completed'&&n.data.assetPath===highPath&&!n.data.nativeStageDiagnostic);
 if(!high)throw Error('原高模缺失或状态已改变。');
 if(d.operation==='analyze'&&(d.assetPath!==candidatePath||d.sourceNodeId!==job.nodeId))throw Error('诊断候选来源已改变。');
 const source=d.operation==='analyze'?bound:high;
 const rules={localRepairMaxPatches:[1,4,4],localRepairDisplacementFraction:[.0001,.01,.002],localRepairCorrectionFraction:[.1,1,.375]},custom={};
 for(const name of Object.keys(settings))if(!Object.hasOwn(rules,name))throw Error('未知局部修复设置。');
 for(const [name,[min,max,defaultValue]]of Object.entries(rules)){const value=settings[name]??defaultValue;if(!Number.isFinite(value)||value<min||value>max||(name==='localRepairMaxPatches'&&!Number.isInteger(value)))throw Error('局部修复设置超出允许范围。');if(value!==defaultValue)custom[name]=value;}
 const parameters={localRepairJobId:job.id,localRepairStage:stage,...custom};
 const key=JSON.stringify([projectId,job.id,stage,files[0].sha256,...(Object.keys(custom).length?[custom]:[])]);
 const links=[['high',high.id],['model',source.id]],snapshot=JSON.stringify(links);
 const existing=nodes.filter(n=>n.data?.nativeLocalRepair?.key===key);
 if(existing.length>1)throw Error('已有多个修复节点，请核对。');
 if(existing.length){const node=existing[0],actual=edges.filter(e=>e.target===node.id&&['model','high'].includes(e.targetHandle)).map(e=>[e.targetHandle,e.source]).sort();
 const modelId=actual.find(([port])=>port==='model')?.[1],model=nativeOutputForEdge(nodes.find(n=>n.id===modelId),edges.find(e=>e.target===node.id&&e.targetHandle==='model')),validModel=modelId===high.id||(model?.data.assetPath===candidatePath&&model?.data.sourceJobId===job.id&&model?.data.sourceNodeId===job.nodeId);
 if(node.data.nativeLocalRepair.candidatePath!==candidatePath||JSON.stringify(node.data.nativeParameters)!==JSON.stringify(parameters)||actual.length!==2||actual[0][0]!=='high'||actual[0][1]!==high.id||actual[1][0]!=='model'||!validModel)throw Error('已有修复节点来源或参数已改变。');
 return {node,edges:[],reused:true};}
 return {node:{id,type:'native3d',position:findFreePosition(nodes,{x:bound.position.x+390,y:bound.position.y},'native3d'),data:{title:`${stage.toUpperCase()} · 局部修复`,operation:'source_lod',status:'idle',nativeParameters:parameters,nativeLocalRepair:{key,candidatePath,sourceJobId:job.id,stage,highPath},nativeNextStepNotice:'只修复当前候选，保留原结果；质量门不变。'}},edges:links.map(([targetHandle,source])=>({id:`${id}-${targetHandle}`,source,sourceHandle:'model',target:id,targetHandle,data:nativeOutputBinding(targetHandle==='model'?bound:high)})),reused:false};
}
