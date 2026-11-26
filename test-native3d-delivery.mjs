import assert from 'node:assert/strict';
import {transferNativeArtifacts,nativeRunIsCurrent,commitNativeDelivery,nativeDeliveryError} from './src/native3d-delivery.js';
import { readFile } from 'node:fs/promises';
import {nativeRunIdentity} from './src/native3d.js';
const artifacts=['model.glb','proxy.glb','report.json'].map((name,i)=>({name,role:['model','proxy','report'][i],url:`/api/native3d/jobs/job/files/${name}`}));
const events=[];let active=0,peak=0;
const saved=await transferNativeArtifacts(artifacts,'job',{
  assertCurrent:()=>{},
  fetchFile:async url=>{events.push(`fetch:${url.split('/').at(-1)}`);active++;peak=Math.max(peak,active);return{ok:true,blob:async()=>({})};},
  makeFile:(_,artifact)=>({name:artifact.name}),
  saveFile:async file=>{events.push(`save:${file.name}`);active--;return `assets/${file.name}`;},
});
assert.equal(peak,1);assert.equal(active,0);
assert.deepEqual(events,['fetch:model.glb','save:model.glb','fetch:proxy.glb','save:proxy.glb','fetch:report.json','save:report.json']);
assert.equal(saved.model.path,'assets/model.glb');assert.equal(saved.model.file,undefined);
const stages=['raw_ai.glb','repair.glb','lod_800.glb','comparison.png'].map(name=>({name,role:'export',url:`/api/native3d/jobs/job/files/${name}`}));
const stageSaved=await transferNativeArtifacts(stages,'job',{
 assertCurrent:()=>{},fetchFile:async()=>({ok:true,blob:async()=>({})}),
 makeFile:(_,artifact)=>({name:artifact.name}),saveFile:async file=>`assets/${file.name}`,
});
assert.equal(Object.keys(stageSaved).length,4);
assert.equal(stageSaved['export:lod_800.glb'].path,'assets/lod_800.glb');
assert.equal(stageSaved['export:comparison.png'].path,'assets/comparison.png');
let fbxUpload;
await transferNativeArtifacts([{name:'asset.fbx',role:'export',mime:'model/vnd.autodesk.fbx',url:'/api/native3d/jobs/job/files/asset.fbx'}],'job',{
 assertCurrent:()=>{},fetchFile:async()=>({ok:true,blob:async()=>new Blob(['FBX fixture'])}),
 saveFile:async file=>{fbxUpload=file;return 'assets/result.fbx';},
});
assert.equal(fbxUpload.name,'asset.fbx');
assert.equal(fbxUpload.type,'application/octet-stream');
for (const role of ['model','proxy']) await assert.rejects(()=>transferNativeArtifacts([{name:'asset.fbx',role,url:'/api/native3d/jobs/job/files/asset.fbx'}],'job',{assertCurrent:()=>{},saveFile:async()=>{throw Error('unreachable');}}),/格式/);
// Use the production File constructor, including the MIME advertised by the engine.
// The existing asset uploader copies file.type into the PUT Content-Type header.
let reportPut;
await transferNativeArtifacts([{name:'report.json',role:'report',mime:'application/json',url:'/api/native3d/jobs/job/files/report.json'}],'job',{
  assertCurrent:()=>{},
  fetchFile:async()=>({ok:true,blob:async()=>new Blob(['{"metadata":{},"quality":{},"warnings":[]}'],{type:'application/json'})}),
  saveFile:async file=>{
    assert.ok(file instanceof File);
    assert.equal(file.type,'application/octet-stream');
    reportPut=new Request('http://fixture/api/projects/prj_test/assets/report.json',{method:'PUT',headers:{'Content-Type':file.type,'If-Match':'1'},body:file});
    assert.equal(reportPut.headers.get('Content-Type'),'application/octet-stream');
    assert.deepEqual(await reportPut.json(),{metadata:{},quality:{},warnings:[]});
    return 'assets/report-hash.json';
  },
});
assert.equal(reportPut.method,'PUT');
let unchanged=true;let fetches=0;let writes=0;
await assert.rejects(()=>transferNativeArtifacts(artifacts,'job',{
 assertCurrent:()=>{if(!unchanged)throw Error('superseded');},
 fetchFile:async()=>{fetches++;unchanged=false;return{ok:true,blob:async()=>({})};},
 saveFile:async()=>{writes++;},
}),/superseded/);
assert.equal(fetches,1);assert.equal(writes,0);
await assert.rejects(()=>transferNativeArtifacts([{name:'evil.exe',role:'export',url:'/api/native3d/jobs/job/files/evil.exe'}],'job',{assertCurrent:()=>{},saveFile:async()=>{throw Error('unreachable');}}),/格式/);
await assert.rejects(()=>transferNativeArtifacts([{...artifacts[0],url:'https://external/model.glb'}],'job',{assertCurrent:()=>{},saveFile:async()=>{}}),/地址/);
const source={id:'s',data:{assetPath:'assets/old.glb'}};
const node={id:'n',data:{operation:'uv',nativeJobId:'job',nativeParameters:{}}};
const identity=nativeRunIdentity(node,source);node.data.nativeRun={opId:'run-a',identity};
const snapshot={opId:'run-a',identity,jobId:'job'};
assert.equal(nativeRunIsCurrent(node,source,snapshot,nativeRunIdentity),true);
assert.equal(nativeRunIsCurrent({...node,data:{...node.data,nativeRun:{opId:'run-b',identity}}},source,snapshot,nativeRunIdentity),false);
assert.equal(nativeRunIsCurrent(node,{...source,data:{assetPath:'assets/new.glb'}},snapshot,nativeRunIdentity),false);
let marker=null;let failure=null;
await assert.rejects(()=>commitNativeDelivery({assertCurrent:()=>{},apply:()=>{marker='job';},persist:async()=>{throw Error('disk full');},rollback:error=>{marker=null;failure=error.message;}}),/disk full/);
assert.equal(marker,null);assert.match(failure,/disk full/);
await commitNativeDelivery({assertCurrent:()=>{},apply:()=>{marker='job';},persist:async()=>{},rollback:()=>{throw Error('unreachable');}});
assert.equal(marker,'job');
let own=true;let newRunMarked=false;
await assert.rejects(()=>commitNativeDelivery({assertCurrent:()=>{if(!own)throw Error('superseded');},apply:()=>{},persist:async()=>{own=false;throw Error('late failure');},rollback:()=>{newRunMarked=true;}}),/late failure/);
assert.equal(newRunMarked,false);
for (const phase of ['download', 'read', 'upload']) {
  const original = Object.assign(new TypeError('Failed to fetch'), { code: 'TEST', status: 503 });
  let downloads = 0, uploads = 0;
  await assert.rejects(transferNativeArtifacts([artifacts[0]], 'job', {
    assertCurrent: () => {}, makeFile: () => ({ name: 'model.glb' }),
    fetchFile: async () => { downloads++; if (phase === 'download') throw original; return { ok: true, blob: async () => { if (phase === 'read') throw original; return {}; } }; },
    saveFile: async () => { uploads++; throw original; },
  }), error => error.deliveryPhase === phase && error.artifactName === 'model.glb' && error.jobId === 'job' && error.cause === original && error.status === 503 && error.code === 'TEST');
  assert.equal(downloads, 1); assert.equal(uploads, phase === 'upload' ? 1 : 0);
}
const conflict = Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT', status: 409 });
let persistenceAttempts = 0;
await assert.rejects(commitNativeDelivery({ assertCurrent: () => {}, apply: () => {}, rollback: error => { assert.equal(error.deliveryPhase, 'final_save'); },
  persist: async () => { persistenceAttempts++; throw conflict; },
}), error => error.cause === conflict && error.status === 409 && error.code === 'REVISION_CONFLICT');
assert.equal(persistenceAttempts, 1);

// Execute the actual component-local uploader with isolated refs: no React or live page.
const component = await readFile(new URL('./src/CanvasWorkbench.jsx', import.meta.url), 'utf8');
const uploaderSource = component.slice(component.indexOf('  const saveNativeFile = async'), component.indexOf('  const nativePatch ='))
  .replace('const saveNativeFile =', 'return');
for (const phase of ['wait_save', 'upload']) {
  let uploads = 0;
  const original = phase === 'wait_save' ? new TypeError('latched previous save failure') : conflict;
  const controller = { suspend() {}, waitForIdle: () => phase === 'wait_save' ? Promise.reject(original) : Promise.resolve(), observe() {} };
  const revisionRef = { current: 17 };
  const localProject = { id: 'fixture', readOnly: false, canvas: {} };
  const deps = { switchingRef: { current: false }, project: localProject, autoSaveRef: { current: controller }, projectRef: { current: localProject },
    uid: () => 'upload-id', mediaUploadTailRef: { current: Promise.resolve() }, revisionRef, mediaWritesRef: { current: new Map() },
    nameRef: { current: 'fixture' }, nodesRef: { current: [] }, edgesRef: { current: [] }, interactionRef: { current: false }, nativeDeliveryError,
    saveProjectFile: async (id, storageId, file, revision) => { uploads++; assert.equal(revision, 17); throw original; } };
  const uploader = new Function(...Object.keys(deps), uploaderSource)(...Object.values(deps));
  await assert.rejects(uploader({ name: 'report.json' }), error => error.deliveryPhase === phase && error.artifactName === 'report.json' && error.cause === original);
  assert.equal(uploads, phase === 'upload' ? 1 : 0); assert.equal(revisionRef.current, 17);
  assert.equal(deps.mediaWritesRef.current.size, 0);
}
console.log('NATIVE3D_DELIVERY_OK sequential bodies, strict artifacts, stale await guards, failed-save rollback/retry, replaced-run isolation');
