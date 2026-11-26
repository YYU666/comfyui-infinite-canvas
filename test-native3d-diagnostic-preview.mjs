import assert from 'node:assert/strict';
import {saveUVDiagnosticPreviews} from './src/native3d-runtime.js';
import {registerCanvasMcp} from './src/canvas-mcp.js';
const hash='a'.repeat(64),identity={jobId:`n3d_${'1'.repeat(32)}`,projectId:'prj_fixture',nodeId:'failed_uv',inputIdentity:'bound-input'};
const bytes=new Uint8Array(80);bytes.set([137,80,78,71,13,10,26,10]);
const png=new Blob([bytes],{type:'image/png'});let saves=0;const urls=[];
const saved=await saveUVDiagnosticPreviews(identity,{assertCurrent(){},saveFile:async()=>{saves++;return `assets/${hash}.png`;},fetchFile:async url=>{urls.push(url);return{ok:true,blob:async()=>png};}});
assert.equal(saves,2);assert.equal(saved.diagnosticOnly,true);assert.equal(saved.acceptedUV,false);assert.equal(saved.bakeAllowed,false);assert.ok(saved.layout);assert.ok(saved.checker);assert.equal(saved.inputIdentity,identity.inputIdentity);
assert.ok(urls.every(url=>url.includes('projectId=prj_fixture&nodeId=failed_uv')));assert.equal(saved.assetPath,undefined);assert.equal(saved.status,undefined);assert.equal(saved.resultAssetPath,undefined);
let active=true,writes=0;
await assert.rejects(saveUVDiagnosticPreviews(identity,{assertCurrent(){if(!active)throw Error('stale project/job');},fetchFile:async()=>{active=false;return{ok:true,blob:async()=>png};},saveFile:async()=>{writes++;}}),/stale/);assert.equal(writes,0);
const optional=await saveUVDiagnosticPreviews(identity,{assertCurrent(){},saveFile:async()=>`assets/${hash}.png`,fetchFile:async url=>url.includes('/checker?')?{ok:false,status:404}:{ok:true,blob:async()=>png}});assert.ok(optional.layout);assert.equal(optional.checker,undefined);
await assert.rejects(saveUVDiagnosticPreviews(identity,{assertCurrent(){},saveFile:async()=>`assets/${hash}.png`,fetchFile:async()=>({ok:true,blob:async()=>new Blob(['bad'],{type:'image/png'})})}),/PNG/);
const tools=new Map();let persist=0,called=0;const node={id:identity.nodeId,type:'native3d',data:{operation:'uv',status:'failed',nativeJobId:identity.jobId,error:'2940 overlaps'}};
const before=JSON.stringify(node);const latest={current:{projectId:identity.projectId,readOnly:false,nodesRef:{current:[node]},edgesRef:{current:[]},actions:{native3dDiagnosticPreview:async id=>{assert.equal(id,node.id);called++;return{diagnosticOnly:true,acceptedUV:false,bakeAllowed:false};},persistProject:async()=>persist++}}};
const dispose=registerCanvasMcp(latest,{context:{registerTool:t=>tools.set(t.name,t)},startPage:()=>()=>{}});
try{const tool=tools.get('canvas_native3d_diagnostic_preview');assert.equal(JSON.parse(await tool.execute({nodeId:node.id})).ok,true);assert.equal(called,1);assert.equal(persist,1);assert.equal(JSON.stringify(node),before);latest.current.readOnly=true;assert.equal(JSON.parse(await tool.execute({nodeId:node.id})).ok,false);assert.equal(called,1);}finally{dispose();}
console.log('NATIVE3D_DIAGNOSTIC_PREVIEW_OK fixed project/job PNG transport, stale rejection, optional checker, diagnostic-only fields, failed status preserved, registered tool and readonly');
