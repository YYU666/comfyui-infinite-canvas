import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeBakePreview} from './src/native3d-bake-preview.js';
import {nativeOutputNode,nativePatchOutputData} from './src/native3d-output.js';
export const current=JSON.parse(await readFile('.cache/native3d-bake-preview-fix/current-node.json','utf8'));
const original=structuredClone(current),p=nativeBakePreview(current);
assert.equal(p.mode,'basecolor');assert.deepEqual(p.channels.map(c=>c.key),['basecolor','normal','ao','roughness','metallic','grey']);assert.deepEqual(current,original);
const legacy=nativeOutputNode(current);legacy.nativeOutputRecordId=undefined;legacy.nativeLogicalId=undefined;assert.equal(nativeBakePreview(legacy).mode,'basecolor');
for(const status of ['queued','running','finishing','failed','error','stale','cancelled'])assert.equal(nativeBakePreview({...current,data:{...current.data,status}}),null);
for(const change of [d=>d.nativeDeliveredJobId='wrong',d=>d.nativeJobId='n3d_'+'f'.repeat(32),d=>d.resultAssetPath='assets/'+'a'.repeat(64)+'.glb',d=>d.nativeOutputRecords[0].jobId='wrong',d=>d.error='delivery failed']){const n=structuredClone(current);change(n.data);assert.equal(nativeBakePreview(n),null);}
const fallback=structuredClone(legacy);fallback.data.nativeArtifacts=fallback.data.nativeArtifacts.filter(a=>a.name!=='basecolor.png');assert.equal(nativeBakePreview(fallback).mode,'normal');fallback.data.nativeArtifacts=fallback.data.nativeArtifacts.filter(a=>a.name!=='normal.png');assert.equal(nativeBakePreview(fallback).mode,'ao');fallback.data.nativeArtifacts=[];assert.equal(nativeBakePreview(fallback),null);
const switched={...current,data:nativePatchOutputData(current.data,{nativeBakePreviewMode:'normal'})};assert.equal(nativeBakePreview(switched).mode,'normal');assert.equal(nativeOutputNode(switched).data.nativeBakePreviewMode,'normal');assert.deepEqual(switched.data.metadata.geometry,current.data.metadata.geometry);
const invalid=structuredClone(legacy);invalid.data.nativeArtifacts.find(a=>a.name==='basecolor.png').assetPath='http://external/image.png';assert.equal(nativeBakePreview(invalid).mode,'normal');
console.log('BAKE_PREVIEW_OK actual current+legacy images, exact delivered job/model/artifact binding, stale/failure suppression, fallback channels, immutable geometry and persisted embedded preference');
