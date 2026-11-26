import {nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges,nativeOutputCandidates} from './src/native3d-output.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {localRepairDraft} from './src/native3d-local-repair.js';
import {nextStepOrigin} from './src/native3d-next-step.js';
import {withNativeRerunLock} from './src/native3d-rerun.js';
const source=await readFile('src/native3d-runtime.js','utf8');
const code=source.slice(source.indexOf('  async function repairLOD('),source.indexOf('  async function createResolution('));
const actual=JSON.parse(await readFile('.cache/native3d/quarry-and-first-v1/lod4-resolution-v1/user-job.json','utf8'));
function fixture(){const job=structuredClone(actual),calls=[];
 const bound={id:job.nodeId,type:'native3d',position:{x:0,y:0},data:{operation:'source_lod',nativeJobId:job.id,metadata:job.result.metadata}};
 const high={id:'high',type:'native3d',position:{x:0,y:200},data:{operation:'analyze',status:'completed',assetPath:job.source.highAssetPath}};
 const o={projectId:job.projectId,readOnly:false,switchingRef:{current:false},nodesRef:{current:[bound,high]},edgesRef:{current:[]},setNodes(){},setEdges(){},focusNode(){},persistProject:async()=>calls.push('save'),updateNode(id,p){Object.assign(o.nodesRef.current.find(n=>n.id===id).data,p);}};
 const latest={current:o},hooks={request:async()=>job};
 const deps={nativeOutputCandidates,nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges,current:()=>{if(o.readOnly||o.switchingRef.current)throw Error('readonly');return o;},latest,nextStepOrigin,localRepairDraft,withNativeRerunLock,rerunLocks:{current:new Set()},localRepairPromises:{current:new Map()},nativeRequest:url=>hooks.request(url),run:async id=>{calls.push('run');o.updateNode(id,{nativeJobId:'repair-job',nativeRun:{opId:'submitted'},status:'queued'});}};
 return {job,o,bound,high,calls,hooks,repair:new Function(...Object.keys(deps),code+';return repairLOD;')(...Object.values(deps))};}
{const f=fixture(),r=await f.repair(f.bound.id);assert.deepEqual(f.calls,['save','run']);assert.equal(r.generated,true);assert.equal(f.o.nodesRef.current[2].data.nativeParameters.localRepairJobId,f.job.id);assert.equal(f.o.nodesRef.current[2].data.nativeParameters.retryJobId,undefined);const again=await f.repair(f.bound.id);assert.equal(again.nodeId,r.nodeId);assert.deepEqual(f.calls,['save','run']);}
{const f=fixture();f.o.persistProject=async()=>{throw Error('save failed');};await assert.rejects(f.repair(f.bound.id),/save failed/);assert.deepEqual(f.calls,[]);f.o.persistProject=async retry=>{assert.equal(retry,true);f.calls.push('save');};await f.repair(f.bound.id);assert.deepEqual(f.calls,['save','run']);}
{const f=fixture();let release;f.hooks.request=()=>new Promise(r=>release=r);const a=f.repair(f.bound.id),b=f.repair(f.bound.id);release(f.job);assert.deepEqual(await a,await b);assert.equal(f.calls.filter(x=>x==='run').length,1);}
{const f=fixture();f.hooks.request=async()=>{f.o.projectId='different';return f.job;};await assert.rejects(f.repair(f.bound.id),/项目/);assert.deepEqual(f.calls,[]);}
{const f=fixture();f.o.persistProject=async()=>{f.high.data.assetPath='assets/changed.glb';};await assert.rejects(f.repair(f.bound.id),/高模/);assert.deepEqual(f.calls,[]);}
{const f=fixture();f.o.readOnly=true;await assert.rejects(f.repair(f.bound.id),/readonly/);}
{const f=fixture();f.job.result.files=[];await assert.rejects(f.repair(f.bound.id),/候选证据/);}
console.log('LOCAL_REPAIR_RUNTIME_OK exact candidate / processor without result / save before submit / failed save / concurrent dedupe / project and high guards');
// Exercise the actual submission function, including its own save boundary.
{
 const f=fixture(),o=f.o,node={id:'repair',type:'native3d',data:{operation:'source_lod',status:'idle',nativeLocalRepair:{key:'k'},nativeParameters:{localRepairJobId:f.job.id,localRepairStage:'lod4'}}};o.nodesRef.current.push(node);
 let saveFails=true,posts=0;o.persistProject=async()=>{if(saveFails)throw Error('run-save failed');};
 const deps={nativeOutputCandidates,nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges,current:()=>o,latest:{current:o},sourceFor:()=>f.high,inputsFor:()=>({high:f.high}),identityFor:()=> 'stable',patch:(id,p)=>o.updateNode(id,p),nativeGeometryInputError:()=>null,capabilities:{operations:{source_lod:{ready:true}}},nativeParameters:(_a,p)=>p,assertRun:()=>({o,node}),nativeRequest:async()=>{posts++;return {id:'submitted'};},retryDelivery:async()=> 'delivered'};
 const runCode=source.slice(source.indexOf('  async function run('),source.indexOf('  async function importModel('));
 const run=new Function(...Object.keys(deps),runCode+';return run;')(...Object.values(deps));
 await assert.rejects(run('repair'),/run-save failed/);assert.equal(posts,0);assert.equal(node.data.nativeRun,null);
 saveFails=false;await run('repair');assert.equal(posts,1);await assert.rejects(run('repair'),/已有局部修复/);assert.equal(posts,1);
 node.data.nativeDeliveryErrorJobId='submitted';assert.equal(await run('repair'),'delivered');
}
console.log('LOCAL_REPAIR_ACTUAL_RUN_OK pre-submit save recovery / duplicate blocked / delivery retry');
{const {lodResolution}=await import('./src/native3d-lod-resolution.js');const value=lodResolution({operation:'source_lod',metadata:{geometry:{status:'blocked',localRepair:{localRepairJobId:'prior'},returnedDiagnosticStage:'lod4',blocker:'Local boundary repair blocked: Local deformation exceeds unchanged .002D displacement cap'}}});assert.equal(value.repairAttempt,true);assert.equal(value.available,false);assert.match(value.message,/\.002D/);}
console.log('ACTUAL_REPAIR_BLOCKER_FALLBACK_VISIBLE_OK');

{const f=fixture();const a=await f.repair(f.bound.id,{localRepairMaxPatches:2,localRepairDisplacementFraction:.003,localRepairCorrectionFraction:.5});assert.equal(f.o.nodesRef.current.at(-1).data.nativeParameters.localRepairMaxPatches,2);const b=await f.repair(f.bound.id,{localRepairMaxPatches:2,localRepairDisplacementFraction:.003,localRepairCorrectionFraction:.5});assert.equal(a.nodeId,b.nodeId);assert.equal(f.calls.filter(v=>v==='run').length,1);await assert.rejects(f.repair(f.bound.id,{localRepairMaxPatches:5}),/范围/);}
{const f=fixture();const originalJob=structuredClone(f.job),repairJob={...structuredClone(f.job),id:'n3d_'+'a'.repeat(32),nodeId:'repair-processor',parameters:{localRepairJobId:f.job.id,localRepairStage:'lod4'}};const repairNode={id:repairJob.nodeId,type:'native3d',position:{x:0,y:0},data:{operation:'source_lod',nativeJobId:repairJob.id}};f.o.nodesRef.current.push(repairNode);f.hooks.request=url=>url.endsWith(repairJob.id)?repairJob:originalJob;const r=await f.repair(repairNode.id,{localRepairMaxPatches:2});const draft=f.o.nodesRef.current.find(n=>n.id===r.nodeId);assert.equal(draft.data.nativeParameters.localRepairJobId,originalJob.id);assert.equal(draft.data.nativeParameters.localRepairMaxPatches,2);}
console.log('LOCAL_REPAIR_SETTINGS_OK validated ranges / changed recipe same original candidate / identical recipe dedupe');
