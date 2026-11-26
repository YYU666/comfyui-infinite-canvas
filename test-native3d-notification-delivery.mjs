import {nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges} from './src/native3d-output.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeLODStageRetryPlan,nativeRerunTarget,nextNativeLODSeed,withNativeRerunLock,nativeAutomaticLODStages,layoutNativeResultDelivery} from './src/native3d-rerun.js';
import {nextStepOrigin} from './src/native3d-next-step.js';
import {nativeRunIsCurrent,commitNativeDelivery} from './src/native3d-delivery.js';
import {findFreePosition} from './src/canvas-layout.js';
const text=await readFile('src/native3d-runtime.js','utf8');
const root='.cache/native3d/quarry-and-first-v1/retry-recovery-v1/';
const doc=JSON.parse(await readFile(root+'baseline.json','utf8')),jobs=JSON.parse(await readFile(root+'jobs.json','utf8'));
const latestJob=jobs.find(j=>j.id==='n3d_e14cd90011394861a6dfbf8d51e0c66e');
const code=name=>text.slice(text.indexOf(`  async function ${name}(`),text.indexOf('  async function ',text.indexOf(`  async function ${name}(`)+10));
function fixture(){
 const nodes=structuredClone(doc.canvas.nodes.filter(n=>n.type==='native3d'));
 const calls=[],o={projectId:doc.id,readOnly:false,switchingRef:{current:false},nodesRef:{current:nodes},edgesRef:{current:structuredClone(doc.canvas.edges)},setNodes(){},setEdges(){},focusNode(id){calls.push(['focus',id]);},persistProject:async retry=>calls.push(['save',retry]),saveNativeFile:async()=> 'assets/file.glb',updateNode(id,p){const n=o.nodesRef.current.find(n=>n.id===id);Object.assign(n.data,p);}};
 const latest={current:o},hooks={request:async(url,payload)=>{if(payload){calls.push(['POST',payload]);return {id:'n3d_'+'f'.repeat(32)};}if(url.includes('?'))return {jobs};return jobs.find(j=>url.endsWith(j.id));}};
 const sourceFor=(_o,n)=>o.nodesRef.current.find(x=>x.id===o.edgesRef.current.find(e=>e.target===n?.id&&e.targetHandle==='model')?.source);
 const inputsFor=(_o,n)=>({high:o.nodesRef.current.find(x=>x.id===o.edgesRef.current.find(e=>e.target===n?.id&&e.targetHandle==='high')?.source)});
 const identityFor=(n,s)=>JSON.stringify([s?.data.assetPath,n?.data.nativeParameters,inputsFor(o,n).high?.data.assetPath]);
 for(const n of nodes)if(n.data.nativeRun)n.data.nativeRun.identity=identityFor(n,sourceFor(o,n));
 const current=()=>{if(o.readOnly||o.switchingRef.current)throw Error('readonly');return o;};
 const assertRun=(pid,id,snapshot)=>{current();const n=o.nodesRef.current.find(n=>n.id===id);if(pid!==o.projectId||!nativeRunIsCurrent(n,sourceFor(o,n),snapshot,identityFor))throw Error('identity changed');return {o,node:n};};
 const notices=[]; const native3DNotifications={observe(){},arm(){},discard(id){notices.push(['discard',id]);},delivered(id,status){notices.push(['delivered',id,status]);calls.push(['notification',id,status]);}};
 const deps={nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges,native3DNotifications,latest,current,sourceFor,inputsFor,identityFor,assertRun,patch:(id,p)=>current().updateNode(id,p),nativeRequest:(...a)=>hooks.request(...a),nativeGeometryInputError:()=>null,capabilities:{operations:{source_lod:{ready:true}}},nativeParameters:(_a,p)=>p,nextNativeLODSeed,withNativeRerunLock,rerunLocks:{current:new Set()},nextStepOrigin,nativeLODStageRetryPlan,pollNow:{current:null},retryDelivery:async()=>{},nativeRunIsCurrent,delivering:{current:new Set()},transferNativeArtifacts:async()=>({model:{name:'model.glb',role:'model',path:'assets/test.glb'}}),commitNativeDelivery,nativeAutomaticLODStages,layoutNativeResultDelivery,findFreePosition,setCapabilityError:e=>calls.push(['pollError',e]),stopped:false,setTimeout:()=>0};
 deps.run=new Function(...Object.keys(deps),code('run')+';return run;')(...Object.values(deps));
 deps.retryLOD=new Function(...Object.keys(deps),code('retryLOD')+';return retryLOD;')(...Object.values(deps));
 deps.syncTask=new Function(...Object.keys(deps),code('syncTask')+';return syncTask;')(...Object.values(deps));
 const pollCode=text.slice(text.indexOf('    async function poll(schedule=true)'),text.indexOf('    pollNow.current=poll;'));
 deps.pollNow.current=new Function(...Object.keys(deps),pollCode+';return poll;')(...Object.values(deps));
 return {o,calls,hooks,notices,...deps};
}

function scenario({diagnostic=false,failSave=false}={}) {
 const f=fixture(), n=f.o.nodesRef.current.find(n=>n.id===latestJob.nodeId);
 for(const other of f.o.nodesRef.current)if(other!==n&&other.data.nativeJobId)other.data.nativeDeliveredJobId=other.data.nativeJobId;
 Object.assign(n.data,{operation:diagnostic?'source_lod':'ai_lowpoly',status:'running',nativeBackendStatus:'running',nativeDeliveredJobId:null,nativeDeliveryErrorJobId:null});
 const job=structuredClone(latestJob);job.status='succeeded';job.result.metadata.geometry.status=diagnostic?'blocked':'accepted';
 f.hooks.request=async()=>job;
 f.o.persistProject=async()=>{f.calls.push(['persist-start']);assert.equal(f.notices.filter(x=>x[0]==='delivered').length,0);if(failSave)throw Error('simulated save failure');f.calls.push(['persist-end']);};
 return {...f,n,job};
}
{
 const f=scenario({failSave:true});await f.pollNow.current(false);
 assert.equal(f.n.data.status,'error');assert.equal(f.notices.filter(x=>x[0]==='delivered').length,0);
}
{
 const f=scenario();await f.pollNow.current(false);
 assert.equal(f.n.data.status,'completed');assert.deepEqual(f.notices,[['delivered',latestJob.id,'succeeded']]);
 assert.ok(f.calls.findIndex(x=>x[0]==='notification')>f.calls.findIndex(x=>x[0]==='persist-end'));
 await f.pollNow.current(false);await f.pollNow.current(false);
 assert.equal(f.notices.filter(x=>x[0]==='delivered').length,1);
}
{
 const f=scenario({diagnostic:true});await f.pollNow.current(false);
 assert.equal(f.n.data.status,'completed');assert.deepEqual(f.notices,[['delivered',latestJob.id,'diagnostic']]);
 await f.pollNow.current(false);assert.equal(f.notices.length,1);
}
{
 const f=scenario();f.o.persistProject=async()=>{f.n.data.nativeRun.opId='replaced';};await f.pollNow.current(false);
 assert.equal(f.notices.filter(x=>x[0]==='delivered').length,0);
}
{
 const f=scenario();f.n.data.nativeDeliveredJobId=f.n.data.nativeJobId;f.n.data.status='completed';await f.pollNow.current(false);assert.equal(f.notices.length,0);
}
console.log('NOTIFICATION_DELIVERY_OK actual poll: failed save and superseded save silent; success after persist once; diagnostic classified; repeated poll/history silent');


{
 const f=scenario({failSave:true});const resultId='native3d-result-'+latestJob.id;f.o.nodesRef.current=f.o.nodesRef.current.filter(n=>n.id!==resultId);const unrelated={id:'unrelated-edit',type:'note',data:{text:'keep'}};f.o.persistProject=async()=>{f.o.nodesRef.current=[...f.o.nodesRef.current,unrelated];throw Error('save busy');};await f.pollNow.current(false);assert.ok(f.o.nodesRef.current.includes(unrelated));assert.equal(f.o.nodesRef.current.some(n=>n.id===resultId),false);assert.equal(f.n.data.nativeCurrentOutputId,null);assert.equal(f.notices.length,0);
}
console.log('INLINE_SAVE_ROLLBACK_OK no duplicate result, failed output removed, unrelated edit preserved, no completion chime');
