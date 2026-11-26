import assert from 'node:assert/strict';
import {nativeUVDeliveredPreviews,native3DBusyFeedback} from './src/native3d-uv-preview.js';
const job='n3d_'+'1'.repeat(32),hash='a'.repeat(64),image='b'.repeat(64);
export const fixture=()=>({type:'native3d',id:'uv',data:{title:'UV展开结果',operation:'analyze',status:'completed',sourceJobId:job,nativeDeliveredJobId:job,assetPath:`assets/${hash}.glb`,metadata:{operation:'uv',uv:{islands:10}},nativeArtifacts:[{name:'uv-layout.png',role:'export',assetPath:`assets/${image}.png`},{name:'uv-checker.png',role:'export',assetPath:`assets/${'c'.repeat(64)}.png`}]}});
const n=fixture(),before=structuredClone(n);assert.equal(nativeUVDeliveredPreviews(n).layoutAssetPath,`assets/${image}.png`);assert.deepEqual(n,before);
const stale=fixture();stale.data.nativeDeliveredJobId='old';assert.equal(nativeUVDeliveredPreviews(stale),null);
const busy=fixture();busy.data.status='running';assert.equal(nativeUVDeliveredPreviews(busy),null);
const fallback=fixture();fallback.data.nativeArtifacts=[];assert.equal(nativeUVDeliveredPreviews(fallback).layoutJobUrl,`/api/native3d/jobs/${job}/files/uv-layout.png`);
const explicit=fixture();explicit.data.nativeUVPreviews={jobId:job,modelAssetPath:explicit.data.assetPath,seamsAssetPath:`assets/${image}.png`};assert.ok(nativeUVDeliveredPreviews(explicit).seamsAssetPath);explicit.data.nativeUVPreviews.jobId='old';assert.equal(nativeUVDeliveredPreviews(explicit).seamsAssetPath,undefined);
for(const [operation,label] of [['source_lod','正在减面'],['uv','正在展开UV'],['bake','正在烘焙材质']]){assert.equal(native3DBusyFeedback({operation,status:'running',progress:37}).title,label);assert.equal(native3DBusyFeedback({operation,status:'running'}).progress,null);}
assert.equal(native3DBusyFeedback({operation:'uv',status:'queued',progress:100}).progress,null);assert.equal(native3DBusyFeedback({operation:'uv',status:'running',posterAssetPath:'old'}).historical,true);assert.equal(native3DBusyFeedback({operation:'uv',status:'completed'}),null);
console.log('UV_FEEDBACK_OK authentic saved layout/checker, identity/stale guards, immutable derivation, job-file-only fallback, observed progress, historical rerun label');
