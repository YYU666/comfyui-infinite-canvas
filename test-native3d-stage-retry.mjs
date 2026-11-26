import assert from 'node:assert/strict';
import {nativeRerunTarget,nativeLODStageRetryPlan,nextNativeLODSeed,nativeAutomaticLODStages,nativeProcessorRunLabel} from './src/native3d-rerun.js';
import {registerCanvasMcp} from './src/canvas-mcp.js';
const anchor='n3d_'+'1'.repeat(32),retryJob='n3d_'+'2'.repeat(32),projectId='prj_test';
const fileHash='a'.repeat(64),meshHash='b'.repeat(64),highHash='c'.repeat(64);
const geometry={status:'accepted',intersectionComplete:true,intersection_pairs_count:0,triangles:5000,vertices:2500};
const parentRecord={stage:'lod2',filename:'lod2.glb',mesh_hash:meshHash,status:'accepted',eligibleForDownstream:true,receipt:{geometry}};
const processor={id:'processor',type:'native3d',position:{x:0,y:0},data:{operation:'source_lod',nativeJobId:anchor,status:'completed'}};
const result={id:'lod3',type:'native3d',position:{x:700,y:0},data:{operation:'analyze',nativeStage:'lod3',sourceJobId:anchor,sourceNodeId:'processor',status:'completed',metadata:{operation:'source_lod',geometry:{status:'blocked'}}}};
const parent={id:'lod2',type:'native3d',position:{x:400,y:0},data:{operation:'analyze',nativeStage:'lod2',sourceJobId:anchor,assetPath:`assets/${fileHash}.glb`,status:'completed',metadata:{geometry:{status:'accepted',selectedStage:'lod2',selectedMeshHash:meshHash}}}};
const high={id:'original',type:'native3d',position:{x:-400,y:0},data:{operation:'analyze',assetPath:`assets/${highHash}.glb`,status:'completed'}};
const nodes=[processor,result,parent,high];const snapshot=structuredClone(nodes);
const job={id:anchor,projectId,operation:'source_lod',status:'succeeded',parameters:{lod0KeepPercent:10,lod3KeepPercent:12.5},source:{highAssetPath:high.data.assetPath,highSha256:highHash},result:{metadata:{geometry:{stages:[parentRecord]}},files:[{name:'lod2.glb',role:'export',sha256:fileHash}]}};
const planned=nativeLODStageRetryPlan(result,nodes,job,projectId,123,'new-processor');
assert.deepEqual(nodes,snapshot);assert.equal(planned.node.data.operation,'source_lod');assert.equal(planned.node.data.nativeParameters.seed,123);
assert.equal(planned.node.data.nativeParameters.retryStage,'lod3');assert.equal(planned.node.data.nativeParameters.retryJobId,anchor);
assert.deepEqual(planned.edges.map(e=>[e.source,e.targetHandle]),[['lod2','model'],['original','high']]);
assert.match(planned.node.data.title,/LOD3/);assert.equal(planned.node.data.nativeParameters.lod3KeepPercent,12.5);
assert.throws(()=>nativeLODStageRetryPlan(result,nodes,{...job,id:retryJob},projectId,1,'x'),/身份/);
assert.throws(()=>nativeLODStageRetryPlan(result,nodes,job,'prj_other',1,'x'),/身份/);
assert.throws(()=>nativeLODStageRetryPlan(result,nodes.filter(n=>n.id!=='lod2'),job,projectId,1,'x'),/父模型/);
assert.throws(()=>nativeLODStageRetryPlan(result,nodes.map(n=>n.id==='lod2'?{...n,data:{...n.data,assetPath:'assets/wrong.glb'}}:n),job,projectId,1,'x'),/父模型/);
const wrongHash=structuredClone(job);wrongHash.result.files[0].sha256='d'.repeat(64);
assert.throws(()=>nativeLODStageRetryPlan(result,nodes,wrongHash,projectId,1,'x'),/父模型/);
const blockedParent=structuredClone(job);blockedParent.result.metadata.geometry.stages[0].eligibleForDownstream=false;
assert.throws(()=>nativeLODStageRetryPlan(result,nodes,blockedParent,projectId,1,'x'),/父LOD/);
assert.throws(()=>nativeLODStageRetryPlan(result,nodes,job,projectId,-1,'x'),/uint32/);
const zero={...result,data:{...result.data,nativeStage:'lod0'}};
assert.throws(()=>nativeRerunTarget(zero,nodes),/LOD0尚未支持/);
const prior={...planned.node,data:{...planned.node.data,status:'completed',nativeJobId:retryJob,nativeRun:{parameters:{seed:123}}}};
let values=[123,456];const cryptoImpl={getRandomValues:a=>{a[0]=values.shift();return a;}};
assert.equal(nextNativeLODSeed([...nodes,prior],anchor,'lod3',cryptoImpl),456);
for(const status of ['blocked','accepted']) {
 const second={id:'second-result',type:'native3d',position:{x:1400,y:0},data:{operation:'analyze',sourceNodeId:prior.id,sourceJobId:retryJob,status:'completed',metadata:{operation:'source_lod',geometry:{status,...(status==='blocked'?{returnedDiagnosticStage:'lod3'}:{selectedStage:'lod3'}),retry:{retryJobId:anchor,retryStage:'lod3'}}}}};
 const next=nativeLODStageRetryPlan(second,[...nodes,prior,second],job,projectId,456,'second-processor');
 assert.equal(next.node.data.nativeParameters.retryJobId,anchor);assert.equal(next.edges[0].source,'lod2');
}
assert.throws(()=>nativeRerunTarget(result,[...nodes,{...prior,data:{...prior.data,status:'queued'}}]),/已有单档重试/);
assert.match(nativeProcessorRunLabel(prior.data),/LOD3/);
assert.deepEqual(nativeAutomaticLODStages({metadata:{operation:'source_lod',geometry:{status:'blocked',returnedDiagnosticStage:'lod3',retry:{retryStage:'lod3'},stages:[{stage:'lod3',status:'blocked',eligibleForDownstream:false,diagnosticFilename:'blocked_lod3.glb',diagnosticFileSha256:fileHash,receipt:{geometry:{status:'blocked'}}}]}}}),[]);
const tools=new Map();let calls=0;
const latest={current:{projectId,readOnly:false,nodesRef:{current:nodes},edgesRef:{current:[]},actions:{persistProject:async()=>{},native3dRetryStage:async id=>{calls++;assert.equal(id,'lod3');return {nodeId:'new-processor',seed:123,retryStage:'lod3',retryJobId:anchor};}}}};
const dispose=registerCanvasMcp(latest,{context:{registerTool:t=>tools.set(t.name,t)},startPage:()=>()=>{}});
try {
 const tool=tools.get('canvas_native3d_retry_stage');assert.deepEqual(Object.keys(tool.inputSchema.properties),['nodeId']);
 const okay=JSON.parse(await tool.execute({nodeId:'lod3'}));assert.equal(okay.seed,123);assert.equal(calls,1);
 for(const request of [{nodeId:'lod3',seed:7},{nodeId:'lod3',path:'bad'},{nodeId:'processor'}])assert.equal(JSON.parse(await tool.execute(request)).ok,false);
 assert.equal(calls,1);latest.current.readOnly=true;assert.equal(JSON.parse(await tool.execute({nodeId:'lod3'})).ok,false);assert.equal(calls,1);
}finally{dispose();}
console.log('NATIVE3D_STAGE_RETRY_OK exact accepted parent+high+hash,immutable originals,one new processor,new seed,failed/success retry anchor,busy guard,LOD0 explicit boundary,blocked result not duplicated,tool whitelist/read-only');

const changedProcessor={...processor,data:{...processor.data,nativeJobId:retryJob,status:'stale'}};
assert.equal(nativeRerunTarget(result,[changedProcessor,result]).retryJobId,anchor);
assert.throws(()=>nativeRerunTarget(result,[{...changedProcessor,data:{...changedProcessor.data,operation:'uv'}},result]),/切换任务/);
console.log('NATIVE3D_HISTORICAL_LOD_RETRY_OK immutable old anchor remains retryable; UV current-job guard retained');

const generic=structuredClone(parent);delete generic.data.nativeStage;delete generic.data.metadata.geometry.selectedStage;delete generic.data.metadata.geometry.selectedMeshHash;generic.data.nativeLODLevel=2;generic.data.metadata.geometry.selectedLodLevel=2;
const genericNodes=nodes.map(n=>n.id===parent.id?generic:n);
assert.equal(nativeLODStageRetryPlan(result,genericNodes,job,projectId,123,'generic-draft').edges[0].source,parent.id);
for(const patch of [{selectedMeshHash:'f'.repeat(64)},{selectedStage:'lod1'},{selectedLodLevel:1}]){const bad=structuredClone(generic);Object.assign(bad.data.metadata.geometry,patch);assert.throws(()=>nativeLODStageRetryPlan(result,nodes.map(n=>n.id===parent.id?bad:n),job,projectId,123,'bad'),/父模型/);}
assert.equal(nativeLODStageRetryPlan(result,[...genericNodes,{...generic,id:'duplicate-parent'}],job,projectId,123,'equivalent').edges[0].source,generic.id);
console.log('NATIVE3D_GENERIC_PARENT_OK exact registered asset+job+accepted record+known level; mismatched identity rejected; equivalent duplicate nodes keep first matching parent');
{const controlled={...job,parameters:{...job.parameters,localRepairJobId:'old',localRepairStage:'lod2',localRepairMaxPatches:2,localRepairDisplacementFraction:.003,localRepairCorrectionFraction:.5}};const clean=nativeLODStageRetryPlan(result,nodes,controlled,projectId,54321,'controlled-clean');assert.equal(Object.keys(clean.node.data.nativeParameters).some(k=>k.startsWith('localRepair')),false);}
console.log('RETRY_STRIPS_ALL_MANUAL_REPAIR_CONTROLS_OK');
