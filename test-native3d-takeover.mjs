import assert from 'node:assert/strict';
import { nativeTakeover } from './src/native3d-takeover.js';

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
console.log('NATIVE3D_TAKEOVER_OK model provenance, pending changes, verified receipt separation and fallback source');
