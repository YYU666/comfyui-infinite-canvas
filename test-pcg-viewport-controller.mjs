import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPcgViewportController,pcgGraphSignature} from './src/pcg-viewport-controller.js';
import {pcgNodeData} from './src/pcg-registry.js';
const tick=ms=>new Promise(r=>setTimeout(r,ms));
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:(v)=>resolve(v)};};
function fixture(){
 const context={projectId:'prj_a',revision:2,readOnly:false,switching:false},graph={nodes:[{id:'shape',type:'pcg',data:pcgNodeData('refmuse.pcg.primitive'),position:{x:0,y:0}}],edges:[]},disk=new Map(),calls=[];
 let task=null,controller,waiter=defer();
 const make=(overrides={})=>({projectId:context.projectId,nodeId:'shape',revision:context.revision,descriptorVersion:1,operationVersion:1,runId:'run-1',jobId:'pcg_'+'1'.repeat(32),inputHash:'a'.repeat(64),status:'running',stale:false,...overrides});
 const done=t=>({...t,status:'succeeded',result:{assets:[{projectId:t.projectId,revision:t.revision,jobId:t.jobId,runId:t.runId,inputHash:t.inputHash,producerNodeId:t.nodeId,artifactId:'pcga_'+'b'.repeat(64),sha256:'c'.repeat(64),bytes:120,role:'model',format:'glb',url:'/native'}],report:{computedNodes:['shape'],cacheHits:[]}}});
 const runtime={getState:()=>({task}),listTasks:async()=>{controller.sync();return {tasks:task?[task]:[]};},invoke:async(action,args)=>{calls.push({action,args});if(action==='preflight')return {executionOrder:['shape']};return waiter.promise;},runNode:async(_id,args)=>{calls.push({action:'run',args});task=make({runId:args.runId});controller.sync();return {task};},cancelObsolete:async t=>{calls.push({action:'cancel',task:t});task={...t,status:'cancelled'};waiter.resolve({task});return {task};}};
 controller=createPcgViewportController({getContext:()=>context,getNode:id=>graph.nodes.find(n=>n.id===id),getGraph:()=>graph,runtime,persistProject:async()=>calls.push({action:'save'}),storage:{getItem:k=>disk.get(k),setItem:(k,v)=>disk.set(k,v)},debounceMs:5});
 return {context,graph,calls,controller,disk,make,done,setTask:t=>{task=t;},resolve:t=>waiter.resolve({task:t})};
}
test('visible graph signature ignores layout/selection and preserves actual typed edges and parameters',()=>{
 const f=fixture(),before=pcgGraphSignature(f.graph);f.graph.nodes[0].position.x=400;f.graph.nodes[0].selected=true;assert.equal(pcgGraphSignature(f.graph),before);f.graph.nodes[0].data.parameters.size=[2,2,2];assert.notEqual(pcgGraphSignature(f.graph),before);f.controller.dispose();
});
test('manual run follows same project/revision and only real matching rendered identity publishes',async()=>{
 const f=fixture();f.controller.open();f.controller.bind('shape',false);let t=f.make();f.setTask(t);f.controller.sync();const generation=f.controller.snapshot().generation;f.resolve(f.done(t));await tick(5);let s=f.controller.snapshot();assert.equal(s.desired.handle.runId,t.runId);assert.equal(s.displayed,null);
 f.controller.rendered({identity:{...t,artifactId:s.desired.artifactId,generation:generation-1},rendered:true});assert.equal(f.controller.snapshot().displayed,null);
 f.controller.rendered({identity:{...t,artifactId:s.desired.artifactId,generation},rendered:true,resources:{liveBytes:40}});assert.equal(f.controller.snapshot().displayed.handle.runId,t.runId);
 f.context.projectId='prj_b';assert.throws(()=>f.controller.open(),e=>e.code==='PROJECT_MISMATCH');f.controller.dispose();
});
test('rapid actual graph changes coalesce, save and preflight before real run, own run callback keeps epoch',async()=>{
 const f=fixture();f.controller.open();f.controller.bind('shape',true);f.graph.nodes[0].data.parameters.size=[2,2,2];f.controller.observeGraph();f.graph.nodes[0].data.parameters.size=[3,3,3];f.controller.observeGraph();await tick(20);
 assert.equal(f.calls.filter(c=>c.action==='run').length,1);assert.ok(f.calls.findIndex(c=>c.action==='save')<f.calls.findIndex(c=>c.action==='preflight'));const run=f.calls.find(c=>c.action==='run'),generation=f.controller.snapshot().generation;f.resolve(f.done(f.make({runId:run.args.runId})));await tick(5);assert.equal(f.controller.snapshot().desired.generation,generation);f.controller.dispose();
});
test('close cancels exact old task and no late result reopens or publishes, layout persists per project',async()=>{
 const f=fixture();f.controller.open();f.controller.bind('shape',false);const t=f.make();f.setTask(t);f.controller.sync();f.controller.layout({x:10,y:20,width:400,height:300});f.controller.close();await tick(5);assert.equal(f.calls.filter(c=>c.action==='cancel').length,1);assert.equal(f.controller.snapshot().open,false);assert.equal(f.controller.snapshot().displayed,null);assert.equal(JSON.parse([...f.disk.values()][0]).layout.width,400);f.resolve(f.done(t));await tick(5);assert.equal(f.controller.snapshot().desired,null);f.controller.dispose();
});

test('switching to explicit-only binding invalidates a queued auto run',async()=>{
 const f=fixture();f.graph.nodes.push({...structuredClone(f.graph.nodes[0]),id:'second'});f.controller.open();f.controller.bind('shape',true);f.controller.bind('second',false);await tick(25);assert.equal(f.calls.filter(c=>c.action==='run').length,0);assert.equal(f.controller.snapshot().autoRun,false);f.controller.dispose();
});
test('context loss clears actual identity independently of retained desired',async()=>{
 const f=fixture();f.controller.open();f.controller.bind('shape',false);const t=f.make({status:'succeeded'});f.setTask(f.done(t));f.controller.sync();const s=f.controller.snapshot(),identity={...t,artifactId:s.desired.artifactId,generation:s.generation};f.controller.rendered({identity,rendered:true});assert.ok(f.controller.snapshot().displayed);f.controller.rendered({identity,status:'context-lost',rendered:false,resources:{liveBytes:0}});assert.equal(f.controller.snapshot().displayed,null);assert.equal(f.controller.snapshot().desired.artifactId,s.desired.artifactId);f.controller.dispose();
});

test('graph invalidation cancels obsolete explicit-mode work without auto resubmission',async()=>{
 const f=fixture();f.controller.open();f.controller.bind('shape',false);f.setTask(f.make());f.controller.sync();f.context.revision++;f.graph.nodes[0].data.parameters.size=[4,4,4];f.controller.observeGraph();await tick(20);assert.equal(f.calls.filter(c=>c.action==='cancel').length,1);assert.equal(f.calls.filter(c=>c.action==='run').length,0);assert.equal(f.controller.snapshot().desired,null);f.controller.dispose();
});
