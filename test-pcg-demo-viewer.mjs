// Pure local fixtures and GPU API lifecycle doubles; real pixels are checked by browser integration.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGlb, LIMITS } from './pcg_demo_viewer/glb.js';
import { createViewer } from './pcg_demo_viewer/renderer.js';

const root=fileURLToPath(new URL('.',import.meta.url));
const generated=spawnSync(process.env.H3_TEST_PYTHON||process.env.PCG_TEST_PYTHON||'python',['-c',`
import base64,json,sys
sys.path.insert(0,sys.argv[1])
from pcg_geometry import evaluate
from pcg_export import export_glb
def op(name,p=None,**inputs):return evaluate(name,p or {},inputs)
box=op('primitive')['geometry']
rock=op('rock',{'seed':17,'subdivisions':3})['geometry']
points=op('scatter_points',{'count':100,'seed':7},geometry=box)['points']
instances=op('instance_on_points',{'scale':[.15,.15,.15]},points=points,prototype=box)['instances']
print(json.dumps({k:base64.b64encode(export_glb(v)).decode() for k,v in dict(box=box,rock=rock,points=points,instances=instances,densePoints={'contractVersion':1,'type':'PointSet','positions':[[0,0,0]]*10000}).items()}))
`,root],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
assert.equal(generated.status,0,generated.stderr);
const fixtures=Object.fromEntries(Object.entries(JSON.parse(generated.stdout)).map(([k,v])=>{const b=Buffer.from(v,'base64');return [k,b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)];}));
function chunks(buffer) {
  const h=new DataView(buffer),jsonSize=h.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,jsonSize)));
  const binOffset=20+jsonSize;const bin=binOffset<buffer.byteLength?new Uint8Array(buffer,binOffset+8,h.getUint32(binOffset,true)):null;
  return {json,bin};
}
function encode(json,bin) {
  const text=new TextEncoder().encode(JSON.stringify(json)),jsonSize=Math.ceil(text.length/4)*4,binSize=bin?Math.ceil(bin.length/4)*4:0;
  const result=new ArrayBuffer(20+jsonSize+(bin?8+binSize:0)),h=new DataView(result),bytes=new Uint8Array(result);
  h.setUint32(0,0x46546c67,true);h.setUint32(4,2,true);h.setUint32(8,result.byteLength,true);h.setUint32(12,jsonSize,true);h.setUint32(16,0x4e4f534a,true);
  bytes.fill(32,20,20+jsonSize);bytes.set(text,20);
  if(bin){h.setUint32(20+jsonSize,binSize,true);h.setUint32(24+jsonSize,0x004e4942,true);bytes.set(bin,28+jsonSize);}
  return result;
}
function mutate(name,fn) {const {json,bin}=chunks(fixtures[name]);const copy=bin?new Uint8Array(bin):null;fn(json,copy);return encode(json,copy);}
function bad(buffer,code) {assert.throws(()=>parseGlb(buffer),error=>error.code===code);}

class Events {
  listeners=new Map();
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
  removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
  fire(name,event={}){for(const fn of this.listeners.get(name)??[])fn(event);}
}
class FakeGL {
  NO_ERROR=0; ARRAY_BUFFER=34962; ELEMENT_ARRAY_BUFFER=34963; STATIC_DRAW=35044; FLOAT=5126; UNSIGNED_INT=5125;
  TRIANGLES=4; POINTS=0; VERTEX_SHADER=35633; FRAGMENT_SHADER=35632; COMPILE_STATUS=35713; LINK_STATUS=35714;
  COLOR_BUFFER_BIT=16384; DEPTH_BUFFER_BIT=256; DEPTH_TEST=2929; LEQUAL=515; CULL_FACE=2884; BLEND=3042;
  buffers=new Set();vaos=new Set();programs=new Set();shaders=new Set();draws=[];error=0;lost=false;failUpload=false;
  createProgram(){const p={};this.programs.add(p);return p;}deleteProgram(p){this.programs.delete(p);}
  createShader(){const s={};this.shaders.add(s);return s;}deleteShader(s){this.shaders.delete(s);}
  shaderSource(){}compileShader(){}getShaderParameter(){return true;}getShaderInfoLog(){return '';}
  attachShader(){}linkProgram(){}getProgramParameter(){return true;}getProgramInfoLog(){return '';}
  getUniformLocation(_p,name){return name;}useProgram(){}
  createBuffer(){const b={};this.buffers.add(b);return b;}deleteBuffer(b){this.buffers.delete(b);}
  bindBuffer(target,b){this[target]=b;}
  bufferData(target,data){if(this.throwUpload){this.throwUpload=false;throw new Error('injected buffer allocation failure');}if(this.failUpload){this.error=1285;this.failUpload=false;}this[target].data=new data.constructor(data);}
  createVertexArray(){const v={};this.vaos.add(v);return v;}deleteVertexArray(v){this.vaos.delete(v);}
  bindVertexArray(v){this.vao=v;}enableVertexAttribArray(){}disableVertexAttribArray(){}vertexAttribPointer(){}vertexAttribDivisor(){}vertexAttrib3f(){}
  getError(){const e=this.error;this.error=0;return e;}isContextLost(){return this.lost;}
  viewport(){}clearColor(){}clear(){}enable(){}disable(){}depthFunc(){}
  uniformMatrix4fv(_key,_transpose,data){this.matrix=new Float32Array(data);}uniformMatrix3fv(){}uniform1f(){}
  drawElementsInstanced(mode,count,_type,_offset,instances){if(this.failDraw){this.failDraw=false;this.error=1282;}this.draws.push({mode,count,instances});}
  drawArraysInstanced(mode,_start,count,instances){this.draws.push({mode,count,instances});}
}
function surface() {
  const gl=new FakeGL(),win=new Events(),doc=new Events(),canvas=new Events();
  let next=0;const callbacks=new Map();
  win.devicePixelRatio=1;win.requestAnimationFrame=fn=>{const id=++next;callbacks.set(id,fn);return id;};win.cancelAnimationFrame=id=>callbacks.delete(id);
  doc.hidden=false;doc.defaultView=win;canvas.ownerDocument=doc;canvas.clientWidth=640;canvas.clientHeight=480;canvas.width=640;canvas.height=480;canvas.getContext=()=>gl;
  return {gl,win,doc,canvas,callbacks,frame(time){const entries=[...callbacks];callbacks.clear();for(const [,fn] of entries)fn(time);}};
}

test('actual Python M2 outputs decode as real meshes, points and shared instances',()=>{
  const box=parseGlb(fixtures.box),rock=parseGlb(fixtures.rock),points=parseGlb(fixtures.points),instances=parseGlb(fixtures.instances);
  assert.equal(box.metrics.triangleCount,12);assert.equal(box.meshes[0].primitives[0].vertexCount,24);
  assert.equal(rock.metrics.triangleCount,512);assert.equal(points.metrics.pointCount,100);
  assert.equal(instances.meshes.length,1);assert.equal(instances.instances.length,100);assert.equal(instances.metrics.triangleCount,1200);assert.equal(instances.metrics.drawCalls,1);
  assert.equal(instances.instances[99].name,'point:99');assert.ok(instances.instances[0].worldMatrix instanceof Float64Array);
});
test('header, chunks, accessors, finite values and indices reject malformed inputs',()=>{
  bad(fixtures.box.slice(0,-4),'INVALID_GLB');
  bad(mutate('box',j=>{j.accessors[0].count=360001;}),'INVALID_GLB');
  bad(mutate('box',j=>{j.accessors[0].byteOffset=1;}),'INVALID_GLB');
  bad(mutate('box',(j,b)=>{const a=j.accessors[j.meshes[0].primitives[0].indices],v=j.bufferViews[a.bufferView];new DataView(b.buffer).setUint32(v.byteOffset,999999,true);}),'INVALID_GLB');
  bad(mutate('box',(j,b)=>{const a=j.accessors[j.meshes[0].primitives[0].attributes.POSITION],v=j.bufferViews[a.bufferView];new DataView(b.buffer).setFloat32(v.byteOffset,NaN,true);}),'INVALID_GLB');
  bad(mutate('box',j=>{j.nodes[0].rotation=[0,0,0,2];}),'INVALID_GLB');
});
test('external resources, materials, extensions and unsupported modes are closed',()=>{
  for(const mutateJson of [j=>j.buffers[0].uri='https://example.invalid/x.bin',j=>j.images=[{uri:'x.png'}],j=>j.materials=[{}],j=>j.extensionsUsed=['unknown'],j=>j.meshes[0].primitives[0].mode=1,j=>j.meshes[0].primitives[0].attributes.TANGENT=0])bad(mutate('box',mutateJson),'UNSUPPORTED_GLB');
});
test('nested scene transforms and conservative framing bounds use parent transforms',()=>{
  const parsed=parseGlb(mutate('box',j=>{j.nodes=[{translation:[10,0,0],children:[1]},{mesh:0,translation:[0,2,0],scale:[2,1,1]}];j.scenes[0].nodes=[0];}));
  assert.deepEqual(parsed.bounds,{min:[9,1.5,-.5],max:[11,2.5,.5]});
  assert.equal(parsed.instances[0].worldMatrix[12],10);assert.equal(parsed.instances[0].worldMatrix[13],2);
  bad(mutate('box',j=>{j.nodes=[{children:[1]},{children:[0],mesh:0}];}),'INVALID_GLB');
  bad(mutate('box',j=>{j.nodes=[{children:[2]},{children:[2]},{mesh:0}];j.scenes[0].nodes=[0,1];}),'INVALID_GLB');
  bad(mutate('box',j=>{j.nodes=Array.from({length:66},(_,i)=>i?{children:[i-1]}:{mesh:0});j.scenes[0].nodes=[65];}),'BUDGET_EXCEEDED');
});
test('rendered geometry and node budgets reject complete assets, never sample silently',()=>{
  bad(mutate('rock',j=>{j.nodes=Array.from({length:4000},()=>({mesh:0}));j.scenes[0].nodes=j.nodes.map((_,i)=>i);}),'BUDGET_EXCEEDED');
  bad(mutate('box',j=>{j.nodes=Array.from({length:LIMITS.nodes+1},()=>({mesh:0}));j.scenes[0].nodes=j.nodes.map((_,i)=>i);}),'BUDGET_EXCEEDED');
  bad(mutate('densePoints',j=>{j.nodes=Array.from({length:101},()=>({mesh:0}));j.scenes[0].nodes=j.nodes.map((_,i)=>i);}),'BUDGET_EXCEEDED');
  const empty=parseGlb(encode({asset:{version:'2.0'},scene:0,scenes:[{}]},null));assert.equal(empty.metrics.instanceCount,0);
});
test('GPU API double shares prototype buffers and retains all hundred instance transforms',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);const state=await viewer.load(fixtures.instances,{assetId:'instances',runId:'r1'});
  assert.equal(state.cameraFramed,true);assert.equal(state.instanceCount,100);assert.equal(state.drawCalls,1);assert.equal(f.gl.draws.at(-1).instances,100);
  assert.equal(f.gl.buffers.size,5);assert.equal(f.gl.vaos.size,1);assert.equal(f.gl.shaders.size,0);
  assert.equal(state.gpuBytes,[...f.gl.buffers].reduce((sum,b)=>sum+b.data.byteLength,0));
  assert.ok(state.camera.distance>state.camera.radius);assert.ok(state.camera.far>state.camera.near);
  viewer.dispose();assert.equal(f.gl.buffers.size,0);assert.equal(f.gl.vaos.size,0);assert.equal(f.gl.programs.size,0);assert.equal(f.callbacks.size,0);
});
test('late concurrent loads cannot replace the newest identity or metrics',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);
  const old=viewer.load(fixtures.box,{assetId:'old'}),newest=viewer.load(fixtures.rock,{assetId:'new'});
  await assert.rejects(old,e=>e.code==='STALE_LOAD');await newest;
  assert.deepEqual(viewer.getState().loadedIdentity,{assetId:'new'});assert.equal(viewer.getState().triangleCount,512);assert.equal(f.gl.vaos.size,1);
  viewer.dispose();
});
test('parse or GPU upload failure retains the displayed scene, identity and GPU ownership',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);await viewer.load(fixtures.box,{assetId:'old'});
  const originalBuffers=new Set(f.gl.buffers),originalFrames=viewer.getState().frameCount;
  await assert.rejects(viewer.load(fixtures.box.slice(0,-1),{assetId:'bad'}));
  assert.deepEqual(viewer.getState().loadedIdentity,{assetId:'old'});assert.equal(viewer.getState().cameraFramed,true);
  f.gl.failUpload=true;await assert.rejects(viewer.load(fixtures.rock,{assetId:'oom'}),e=>e.code==='GPU_UPLOAD_FAILED');
  assert.deepEqual(f.gl.buffers,originalBuffers);assert.equal(viewer.getState().frameCount,originalFrames);assert.equal(viewer.getState().triangleCount,12);
  assert.equal(viewer.getState().error.code,'GPU_UPLOAD_FAILED');viewer.dispose();
});
test('turntable advances actual draws, pauses and stops animation when hidden',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);await viewer.load(fixtures.box,{assetId:'box'});
  f.frame(0);f.frame(500);const moving=viewer.getState();assert.ok(moving.yaw>0);assert.ok(moving.frameCount>=3);
  f.doc.hidden=true;f.doc.fire('visibilitychange');assert.equal(f.callbacks.size,0);const count=viewer.getState().frameCount;f.frame(1000);assert.equal(viewer.getState().frameCount,count);
  f.doc.hidden=false;f.doc.fire('visibilitychange');assert.equal(f.callbacks.size,1);
  viewer.setRotating(false);const paused=viewer.getState();assert.equal(f.callbacks.size,0);f.frame(2000);assert.equal(viewer.getState().yaw,paused.yaw);
  viewer.dispose();
});

test('turntable bounds redundant draws while a new model is drawn immediately',async()=>{
  const f=surface();let notifications=0;const viewer=createViewer(f.canvas,{onFrame:()=>notifications++});
  await viewer.load(fixtures.box,{assetId:'box'});assert.equal(viewer.getState().sceneFrameCount,1);
  f.frame(0);const before=viewer.getState().frameCount,beforeNotifications=notifications;
  f.frame(16);f.frame(33);assert.equal(viewer.getState().frameCount,before);assert.equal(notifications,beforeNotifications);
  f.frame(50);f.frame(66);f.frame(100);assert.equal(viewer.getState().frameCount,before+2);
  assert.ok(Math.abs(viewer.getState().yaw-.035)<1e-10);
  f.frame(116);const previous=viewer.getState().frameCount;
  await viewer.load(fixtures.rock,{assetId:'rock'});
  assert.equal(viewer.getState().frameCount,previous+1);assert.equal(viewer.getState().sceneFrameCount,1);
  assert.equal(viewer.getState().loadedIdentity.assetId,'rock');assert.equal(viewer.getState().cameraFramed,true);
  viewer.dispose();assert.equal(f.callbacks.size,0);
});
test('hidden upload reports unframed until actual draw, context loss and dispose invalidate loads',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);f.doc.hidden=true;f.doc.fire('visibilitychange');
  await viewer.load(fixtures.points,{assetId:'points'});assert.equal(viewer.getState().cameraFramed,false);assert.equal(f.callbacks.size,0);
  f.doc.hidden=false;f.doc.fire('visibilitychange');assert.equal(viewer.getState().cameraFramed,true);assert.equal(f.gl.draws.at(-1).mode,f.gl.POINTS);
  f.gl.lost=true;let prevented=false;f.canvas.fire('webglcontextlost',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
  assert.equal(viewer.getState().error.code,'CONTEXT_LOST');assert.equal(viewer.getState().loadedIdentity,null);assert.equal(f.gl.buffers.size,0);assert.equal(f.callbacks.size,0);
  await assert.rejects(viewer.load(fixtures.box,{assetId:'lost'}),e=>e.code==='CONTEXT_LOST');
  f.gl.lost=false;f.canvas.fire('webglcontextrestored');assert.equal(viewer.getState().status,'ready');
  const loading=viewer.load(fixtures.box,{assetId:'late'});viewer.dispose();await assert.rejects(loading,e=>e.code==='STALE_LOAD');
  assert.equal(f.gl.programs.size,0);assert.equal(viewer.getState().status,'disposed');
});
test('identity is finite bounded JSON and caller state cannot mutate loaded identity',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);await assert.rejects(viewer.load(fixtures.box,{bad:NaN}),e=>e.code==='INVALID_IDENTITY');
  const identity={assetId:'stable'};await viewer.load(fixtures.box,identity);identity.assetId='changed';const state=viewer.getState();state.loadedIdentity.assetId='also-changed';assert.equal(viewer.getState().loadedIdentity.assetId,'stable');viewer.dispose();
});


test('camera fit preserves the viewport aspect when GPU resolution is capped',async()=>{
  const f=surface();f.canvas.clientWidth=5000;f.canvas.clientHeight=1000;
  const viewer=createViewer(f.canvas);await viewer.load(fixtures.box,{assetId:'wide'});
  assert.equal(f.canvas.width,2048);assert.ok(Math.abs(viewer.getState().camera.aspect-5)<.01);
  viewer.dispose();
});

function meshDelta(){return mutate('box',(j,b)=>{
  const a=j.accessors[j.meshes[0].primitives[0].attributes.POSITION],v=j.bufferViews[a.bufferView],data=new DataView(b.buffer);
  for(let i=0;i<a.count*3;i++)data.setFloat32(v.byteOffset+i*4,data.getFloat32(v.byteOffset+i*4,true)*1.1,true);
});}
function instanceDelta(){return mutate('instances',j=>{j.nodes[0].translation[0]+=.25;});}

test('same-topology mesh delta retains index GPU buffer and replaces finite positions',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);await viewer.load(fixtures.box,{assetId:'base'});
  const index=f.gl[f.gl.ELEMENT_ARRAY_BUFFER],oldBuffers=new Set(f.gl.buffers),before=viewer.getState().resources;
  const state=await viewer.update(meshDelta(),{assetId:'mesh-update'},'mesh-delta');
  assert.equal(f.gl[f.gl.ELEMENT_ARRAY_BUFFER],index);assert.ok(f.gl.buffers.has(index));
  assert.equal([...oldBuffers].filter(b=>f.gl.buffers.has(b)).length,1);
  assert.equal(state.resources.reusedBuffers-before.reusedBuffers,1);assert.equal(state.resources.bufferAllocations-before.bufferAllocations,4);
  assert.equal(state.updateKind,'mesh-delta');assert.equal(state.triangleCount,12);
  assert.equal(state.resources.liveBytes,state.gpuBytes);assert.equal(state.resources.liveBuffers,5);
  viewer.dispose();assert.equal(viewer.getState().resources.liveBytes,0);
  assert.equal(viewer.getState().resources.bufferAllocations,viewer.getState().resources.bufferDeletions);
});
test('instance-only delta reuses every prototype GPU buffer and changes all retained transforms',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);await viewer.load(fixtures.instances,{assetId:'base'});
  const before=viewer.getState().resources,original=new Set(f.gl.buffers);
  const state=await viewer.update(instanceDelta(),{assetId:'transforms'},'instance-delta');
  assert.equal([...original].filter(b=>f.gl.buffers.has(b)).length,3);
  assert.equal(state.resources.reusedBuffers-before.reusedBuffers,3);assert.equal(state.resources.bufferAllocations-before.bufferAllocations,2);
  assert.equal(state.instanceCount,100);assert.equal(state.drawCalls,1);assert.equal(state.resources.liveBytes,state.gpuBytes);
  viewer.dispose();assert.equal(viewer.getState().resources.liveBuffers,0);assert.equal(viewer.getState().resources.liveVaos,0);assert.equal(f.callbacks.size,0);
});
test('claimed delta kind cannot bypass actual topology and prototype validators',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);await viewer.load(fixtures.box,{assetId:'base'});const original=new Set(f.gl.buffers);
  const changedIndices=mutate('box',(j,b)=>{const v=j.bufferViews[j.accessors[j.meshes[0].primitives[0].indices].bufferView],d=new DataView(b.buffer);const a=d.getUint32(v.byteOffset,true);d.setUint32(v.byteOffset,d.getUint32(v.byteOffset+4,true),true);d.setUint32(v.byteOffset+4,a,true);});
  for(const [buffer,kind] of [[changedIndices,'mesh-delta'],[meshDelta(),'instance-delta'],[fixtures.rock,'mesh-delta']])await assert.rejects(viewer.update(buffer,{assetId:'bad'},kind),e=>e.code==='DELTA_MISMATCH');
  assert.deepEqual(f.gl.buffers,original);assert.deepEqual(viewer.getState().loadedIdentity,{assetId:'base'});
  viewer.dispose();
});
test('candidate delta GPU allocation or draw failures preserve shared buffers and base identity',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);await viewer.load(fixtures.instances,{assetId:'base'});const original=new Set(f.gl.buffers);
  for(const failure of ['failUpload','throwUpload','failDraw']){
    f.gl[failure]=true;await assert.rejects(viewer.update(instanceDelta(),{assetId:'rejected'},'instance-delta'));
    assert.deepEqual(f.gl.buffers,original);assert.deepEqual(viewer.getState().loadedIdentity,{assetId:'base'});
    assert.equal(viewer.getState().resources.liveBuffers,5);assert.equal(viewer.getState().resources.liveVaos,1);
  }
  await viewer.update(instanceDelta(),{assetId:'accepted'},'instance-delta');viewer.dispose();assert.equal(f.gl.buffers.size,0);
});
test('overlapping delta publication and close reject stale candidates without deleting shared base',async()=>{
  const f=surface(),viewer=createViewer(f.canvas);await viewer.load(fixtures.instances,{assetId:'base'});
  const old=viewer.update(instanceDelta(),{assetId:'late'},'instance-delta');
  await Promise.resolve(); // Old candidate has retained the shared geometry but has not published.
  const newest=viewer.update(instanceDelta(),{assetId:'latest'},'instance-delta');
  await assert.rejects(old,e=>e.code==='STALE_LOAD');await newest;
  assert.deepEqual(viewer.getState().loadedIdentity,{assetId:'latest'});assert.equal(f.gl.buffers.size,5);
  const closing=viewer.update(instanceDelta(),{assetId:'closed'},'instance-delta');await Promise.resolve();viewer.dispose();
  await assert.rejects(closing,e=>e.code==='STALE_LOAD');assert.equal(f.gl.buffers.size,0);assert.equal(f.callbacks.size,0);
  const r=viewer.getState().resources;assert.equal(r.liveBytes,0);assert.equal(r.bufferAllocations,r.bufferDeletions);assert.equal(r.vaoAllocations,r.vaoDeletions);
});
