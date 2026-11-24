import assert from 'node:assert/strict';
import { nativeReceiptError, nativeTakeover } from './src/native3d-takeover.js';

const id = 'n3d_' + '1'.repeat(32);
const newer = 'n3d_' + '2'.repeat(32);
const glb = 'assets/' + '1'.repeat(64) + '.glb';
const low = {id:'low', type:'native3d', data:{title:'低模',assetPath:glb}};
const baked = {status:'completed',operation:'analyze',sourceJobId:id,nativeDeliveredJobId:id,assetPath:glb};
const processor = {id:'plan',type:'native3d',data:{title:'接手 UV',operation:'uv_plan',nativeJobId:newer,
  nativeDeliveredJobId:id, status:'failed', nativeBackendStatus:'failed', nativeParameters:{padding:20},
  nativeCurrentOutputId:'r',nativeOutputRecords:[{schemaVersion:1,recordId:'r',jobId:id,producerRun:{parameters:{padding:16}},data:baked}]}};
const edges = [{source:'low',target:'plan',sourceHandle:'model',targetHandle:'model'}];
const capabilities = {operations:{uv_plan:{ready:true,parameters:{properties:{padding:{type:'integer',minimum:1,maximum:32,default:16}}}}}};
const state = nativeTakeover('plan',[processor,low],edges,capabilities);
assert.equal(state.preview.path,glb);
assert.equal(state.lastSuccess.jobId,id);
assert.equal(state.receipt.jobId,newer);
assert.equal(state.receipt.backendStatus,'failed');
assert.deepEqual(state.changed.map(field=>[field.key,field.baseline,field.value]),[['padding',16,20]]);
assert.equal(state.pending,true);

const reset = {...processor,data:{...processor.data,nativeParameters:{padding:16}}};
assert.equal(nativeTakeover('plan',[reset,low],edges,capabilities).pending,false);
const noPreviewOutput = {...processor,data:{...processor.data,nativeOutputRecords:[{...processor.data.nativeOutputRecords[0],data:{...baked,assetPath:null}}]}};
const inputView = nativeTakeover('plan',[noPreviewOutput,low],edges,capabilities);
assert.equal(inputView.preview.sourceLabel,'输入低模');
assert.equal(inputView.sources[0].title,'低模');
assert.equal(nativeTakeover('missing',[processor,low],edges,capabilities),null);
assert.equal(nativeReceiptError('旧版错误'), '旧版错误');
assert.equal(nativeReceiptError({code:'UV_FAILED',message:'探测失败'}), 'UV_FAILED · 探测失败');
assert.equal(nativeReceiptError({details:{message:'旧版细节'}}), '旧版细节');
assert.equal(nativeReceiptError({message:{detail:'unrenderable'}}), '任务返回了无法读取的错误。');
assert.equal(nativeReceiptError(null), null);
const legacy = {...processor,data:{...processor.data,error:{code:'UV_FAILED',details:{message:'旧版错误'}},
  nativeOutputRecords:[{...processor.data.nativeOutputRecords[0],producerRun:undefined}]}};
const legacyState = nativeTakeover('plan',[legacy,low],edges,capabilities);
assert.equal(legacyState.receipt.error,'UV_FAILED · 旧版错误');
assert.equal(legacyState.lastSuccess.jobId,id);
assert.equal(legacyState.basis,'missing');
assert.equal(legacyState.pending,false);

const uv = {id:'uv', type:'native3d', data:{title:'自然 UV',operation:'uv',status:'completed',
  nativeJobId:id,nativeDeliveredJobId:id}};
const output = {id:'uv-output', type:'native3d', data:{operation:'analyze',sourceNodeId:uv.id}};
const bake = {id:'bake', type:'native3d', data:{title:'烘焙',operation:'bake',status:'failed',
  nativeJobId:newer,nativeDeliveredJobId:id}};
const bystander = {id:'diagnostic-only', type:'native3d', data:{operation:'bake',status:'running'}};
const allNodes = [processor, low, uv, output, bake, bystander];
const allEdges = [...edges,
  {source:'plan',target:'uv',sourceHandle:'plan',targetHandle:'plan',data:{outputRecordId:'r'}},
  {source:'uv',target:'uv-output',sourceHandle:'model',targetHandle:'provenance'},
  {source:'uv-output',target:'bake',sourceHandle:'model',targetHandle:'model'},
  {source:'bake',target:'plan',sourceHandle:'model',targetHandle:'model'},
  {source:'plan',target:'diagnostic-only',sourceHandle:'model',targetHandle:'high',data:{nonExecuting:true}}];
const impact = nativeTakeover('plan',allNodes,allEdges,capabilities).downstream;
assert.deepEqual(impact.map(n=>[n.nodeId,n.direct,n.input,n.pinned,n.needsReview,n.taskStatus,n.lastSavedJobId]),[
  ['uv',true,'切缝方案',true,true,'结果已保存',id],
  ['bake',false,'模型输入',false,true,'任务失败',id],
]);
assert.equal(impact[1].jobId,newer);
assert.equal(bake.data.status,'failed');
assert.ok(nativeTakeover('plan',[reset,...allNodes.slice(1)],allEdges,capabilities).downstream.every(n=>!n.needsReview));

const planOutput = {id:'plan-output',type:'native3d',data:{operation:'analyze',sourceNodeId:'plan'}};
const multiPath = [...allEdges,
  {source:'plan',target:'plan-output',sourceHandle:'model',targetHandle:'provenance'},
  {source:'plan-output',target:'bake',sourceHandle:'model',targetHandle:'model'}];
assert.equal(nativeTakeover('plan',[...allNodes,planOutput],multiPath,capabilities).downstream.find(n=>n.nodeId==='bake').direct,true);

console.log('NATIVE3D_TAKEOVER_OK model provenance, pending changes, verified receipt separation and fallback source');
