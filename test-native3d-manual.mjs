import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {NATIVE3D_PRESETS,nativeRunIdentity,nativeParameters} from './src/native3d.js';
import {nativeInputs,planConfirmationKey,assertPlanCurrent,assertConfirmedPlan,decodePlanOverlay,planUVParameters} from './src/native3d-plan.js';
import {planCanvasConnection} from './src/canvas-connections.js';
import {nativeStagePlan,nativeVisibleStages} from './src/native3d-stage.js';
import {createDemandRender} from './src/native3d-demand-render.js';
import {registerCanvasMcp} from './src/canvas-mcp.js';
import {transferNativeArtifacts} from './src/native3d-delivery.js';
const hash='a'.repeat(64),jobId=`n3d_${'1'.repeat(32)}`;
const model=(id,path)=>({id,type:'native3d',data:{operation:'analyze',assetPath:path,status:'completed'}});
const low=model('low',`assets/${hash}.glb`),high=model('high',`assets/${'b'.repeat(64)}.glb`);
const producer={id:'planner',type:'native3d',data:{operation:'uv_plan',status:'completed',nativeJobId:jobId,nativeParameters:{partitionCount:8}}};
const edges=[{source:low.id,target:producer.id,targetHandle:'model'},{source:high.id,target:producer.id,targetHandle:'high'}];
const nodes=[low,high,producer];
producer.data.nativeRun={identity:nativeRunIdentity(producer,low,nativeInputs(producer,nodes,edges))};
const plan={version:1,planSha256:hash,jobId,producerNodeId:'planner',lowAssetPath:low.data.assetPath,highAssetPath:high.data.assetPath,source:{lowSha256:hash,highSha256:'b'.repeat(64)},settings:{resolution:4096,padding:16},runIdentity:producer.data.nativeRun.identity};
const result={id:'plan-result',type:'native3d',data:{operation:'analyze',status:'completed',nativeUVPlan:plan}};nodes.push(result);
const uv={id:'uv',type:'native3d',data:{operation:'uv',nativeParameters:{}}};nodes.push(uv);
const connect=(source,targetHandle,sourceHandle='model')=>planCanvasConnection({source:source.id,target:uv.id,targetHandle,sourceHandle},nodes,edges);
assert.equal(connect(high,'high').connection.targetHandle,'high');
assert.equal(connect(result,'plan','plan').connection.targetHandle,'plan');
assert.ok(connect(result,'model','model').error);assert.ok(connect(low,'plan').error);
assert.equal(planCanvasConnection({source:producer.id,target:uv.id,targetHandle:'plan',sourceHandle:'plan'},nodes,edges).connection.source,result.id);
assert.throws(()=>assertConfirmedPlan(result,low,high),/确认/);
result.data.nativeUVPlanConfirmation=planConfirmationKey(plan);
assert.equal(assertConfirmedPlan(result,low,high),plan);assert.equal(assertPlanCurrent(plan,nodes,edges,nativeRunIdentity),plan);
assert.throws(()=>assertConfirmedPlan(result,low,{...high,data:{assetPath:'assets/changed.glb'}}),/相同/);
producer.data.nativeParameters.partitionCount=4;assert.throws(()=>assertPlanCurrent(plan,nodes,edges,nativeRunIdentity),/改变/);producer.data.nativeParameters.partitionCount=8;
const old=high.data.assetPath;high.data.assetPath='assets/replaced.glb';assert.throws(()=>assertPlanCurrent(plan,nodes,edges,nativeRunIdentity));high.data.assetPath=old;
for(const target of [low,high]) {
  for(const change of [{sourceJobId:'new-source-job'},{nativeStageProvenance:{parentMeshHash:'c'.repeat(64)}},{metadata:{geometry:{status:'blocked'}}},{quality:{status:'blocked'}},{status:'error'}]) {
    const original=target.data;target.data={...original,...change};
    assert.throws(()=>assertPlanCurrent(plan,nodes,edges,nativeRunIdentity),/改变/,'same asset path cannot conceal changed source lineage/approval');
    target.data=original;
  }
  const original=target.data;target.data={...original,progress:77,stage:'display-only',title:'Renamed'};
  assert.equal(assertPlanCurrent(plan,nodes,edges,nativeRunIdentity),plan,'display progress does not invalidate stable inputs');target.data=original;
}
assert.throws(()=>planUVParameters(plan,{padding:8},{properties:{padding:{}}}),/不同/);
assert.deepEqual(planUVParameters(plan,{}, {properties:{resolution:{},padding:{}}}),{resolution:4096,padding:16,planJobId:jobId,planSha256:hash});
assert.equal(NATIVE3D_PRESETS.model_lod[1].operation,'source_lod');assert.equal(NATIVE3D_PRESETS.model_lod_legacy[1].operation,'repair_lod');assert.equal(NATIVE3D_PRESETS.model_uv_plan[1].operation,'uv_plan');
const lodSchema={parameters:{properties:{lod0KeepPercent:{type:'number',minimum:.01,maximum:100,default:10},lod1KeepPercent:{type:'number',minimum:.01,maximum:100,default:50},lod0FaceCap:{type:'integer',minimum:0,maximum:100000,default:100000}}}};
assert.equal(nativeParameters(lodSchema,{lod0KeepPercent:100,lod1KeepPercent:3}).lod1KeepPercent,3);assert.throws(()=>nativeParameters(lodSchema,{lod0KeepPercent:101}));
const legacy={id:'old',data:{operation:'repair_lod',nativeParameters:{lod1:1200}}};assert.equal(nativeRunIdentity(legacy,low),JSON.stringify([low.id,low.data.assetPath,low.data.assetPath,'repair_lod','',{lod1:1200}]));
const stageProcessor={id:'lod',type:'native3d',data:{operation:'source_lod',nativeJobId:jobId}};
const acceptedAudit={status:'accepted',intersectionComplete:true,intersection_pairs_count:0,vertices:3,triangles:1,mesh_hash:hash};
const acceptedStage=(stage,lodLevel,extra={})=>({stage,lodLevel,visible:true,status:'accepted',eligibleForDownstream:true,filename:'lod0.glb',mesh_hash:hash,parent_mesh_hash:hash,receipt:{geometry:{...acceptedAudit},fidelity:{accepted:true}},...extra});
const stageSource={...low,data:{...low.data,sourceJobId:jobId,sourceNodeId:stageProcessor.id,originalAssetPath:high.data.assetPath,metadata:{operation:'source_lod',geometry:{status:'accepted',selectedLodLevel:0,chainStatus:'blocked',chainComplete:false,stages:[acceptedStage('lod0',0),acceptedStage('lod1',1,{aliasOfStage:'lod0'}),acceptedStage('lod2',2,{filename:'lod2.glb',status:'blocked',eligibleForDownstream:false,receipt:{geometry:{...acceptedAudit,status:'blocked',intersection_pairs_count:1}}})]}},nativeArtifacts:[{name:'lod0.glb',role:'export',assetPath:low.data.assetPath}]}};
assert.deepEqual(nativeVisibleStages(stageSource.data).map(s=>s.stage),['lod0','lod1']);
assert.throws(()=>nativeStagePlan(stageSource,'lod2',[stageSource,stageProcessor,high]),/完整检查/);
const lod0=nativeStagePlan(stageSource,'lod0',[stageSource,stageProcessor,high]);assert.equal(lod0.node.data.nativeNaniteCandidate,true);assert.equal(lod0.node.data.assetPath,low.data.assetPath);
const alias=nativeStagePlan(stageSource,'lod1',[stageSource,stageProcessor,high]);assert.equal(alias.node.data.assetPath,lod0.node.data.assetPath);assert.equal(alias.node.data.nativeNaniteCandidate,false);assert.equal(alias.node.data.nativeLODLevel,1);
assert.equal(alias.node.data.metadata.geometry.selectedLodLevel,1);
assert.deepEqual(alias.node.data.metadata.geometry.stages[0].receipt.fidelity,{accepted:true});
assert.equal(alias.node.data.metadata.geometry.stages[0].eligibleForDownstream,true);
assert.equal(alias.node.data.metadata.geometry.stages[0].status,'accepted');
assert.equal(nativeStagePlan(alias.node,'lod0',[alias.node,stageProcessor,high]).node.data.metadata.geometry.selectedLodLevel,0);
assert.deepEqual(nativeVisibleStages({...stageSource.data,metadata:{...stageSource.data.metadata,operation:'repair_lod'}}).map(s=>s.stage),['lod0','lod1','lod2'],'legacy visibility remains unchanged');
// On-demand viewers schedule only controls changes/damping; close cancels work.
const frames=new Map();let next=0,renders=0,updates=0;
const demand=createDemandRender({request:callback=>{frames.set(++next,callback);return next;},cancel:id=>frames.delete(id),update:()=>++updates===1,render:()=>renders++});
demand.invalidate();demand.invalidate();assert.equal(frames.size,1);
let callback=frames.values().next().value;frames.clear();callback();assert.equal(renders,1);assert.equal(frames.size,1);
callback=frames.values().next().value;frames.clear();callback();assert.equal(renders,2);assert.equal(frames.size,0,'idle has no continuous render loop');
demand.invalidate();callback=frames.values().next().value;demand.dispose();assert.equal(frames.size,0);callback();assert.equal(renders,2,'late callback cannot render disposed viewer');
// Exact typed binary triangle; hashed before typed-array construction.
const buffer=new ArrayBuffer(80);new Float32Array(buffer,0,9).set([0,0,0,1,0,0,0,1,0]);new Uint32Array(buffer,36,3).set([0,1,2]);new Int32Array(buffer,48,1).set([3]);new Float32Array(buffer,52,1).set([.4]);new Uint32Array(buffer,56,2).set([0,1]);
const arrays={positions:{offset:0,byteLength:36,dtype:'float32',count:3,itemSize:3},faces:{offset:36,byteLength:12,dtype:'uint32',count:1,itemSize:3},regions:{offset:48,byteLength:4,dtype:'int32',count:1,itemSize:1},darkness:{offset:52,byteLength:4,dtype:'float32',count:1,itemSize:1},edges:{offset:56,byteLength:8,dtype:'uint32',count:1,itemSize:2}};
const sha=Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',buffer)),v=>v.toString(16).padStart(2,'0')).join('');
const decoded=await decodePlanOverlay(buffer,{byteLength:80,sha256:sha,arrays},webcrypto);assert.deepEqual([...decoded.edges],[0,1]);
await assert.rejects(decodePlanOverlay(buffer,{byteLength:80,sha256:hash,arrays},webcrypto),/哈希/);
await assert.rejects(decodePlanOverlay(buffer,{byteLength:80,sha256:sha,arrays:{...arrays,faces:{...arrays.faces,count:100001}}},webcrypto));
// All planner artifacts travel through current-page saving with distinct keys.
const artifacts=[['uv-plan.json','plan'],['uv-plan-overlay.bin','plan'],['uv-plan-evidence.npz','evidence']].map(([name,role])=>({name,role,url:`/api/native3d/jobs/${jobId}/files/${name}`}));
const saved=await transferNativeArtifacts(artifacts,jobId,{assertCurrent(){},fetchFile:async()=>({ok:true,blob:async()=>new Blob(['fixture'])}),makeFile:(_,artifact)=>artifact,saveFile:async artifact=>`assets/${hash}.${artifact.name.split('.').at(-1)}`});
assert.equal(Object.keys(saved).length,3);assert.ok(saved['plan:uv-plan.json']);assert.ok(saved['plan:uv-plan-overlay.bin']);
const tools=new Map();let persisted=0,reviewed=0,confirmed=0;
const latest={current:{projectId:'project',readOnly:false,nodesRef:{current:nodes},edgesRef:{current:edges},actions:{native3dPlanReview:async id=>{reviewed++;return{nodeId:id,planSha256:hash};},native3dPlanConfirm:async(id,sha)=>{assert.equal(sha,hash);confirmed++;return{nodeId:id,confirmed:true};},persistProject:async()=>persisted++}}};
const unregister=registerCanvasMcp(latest,{context:{registerTool:tool=>tools.set(tool.name,tool)},startPage:()=>()=>{}});
try {
  assert.equal(JSON.parse(await tools.get('canvas_native3d_plan_review').execute({nodeId:result.id})).ok,true);
  assert.equal(JSON.parse(await tools.get('canvas_native3d_plan_confirm').execute({nodeId:result.id,planSha256:hash})).ok,true);
  assert.equal(reviewed,1);assert.equal(confirmed,1);assert.equal(persisted,2);
  latest.current.readOnly=true;
  assert.equal(JSON.parse(await tools.get('canvas_native3d_plan_confirm').execute({nodeId:result.id,planSha256:hash})).ok,false);assert.equal(confirmed,1);
} finally {unregister();}
console.log('NATIVE3D_MANUAL_OK typed high/plan ports, immutable output, hash confirmation, source/settings invalidation, exact binary limits, editable percent schema, legacy identity');
