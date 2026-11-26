import {nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges} from './src/native3d-output.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolutionDraft} from './src/native3d-lod-resolution.js';
import {nextStepOrigin} from './src/native3d-next-step.js';
import {withNativeRerunLock,nextNativeLODSeed} from './src/native3d-rerun.js';
const text=await readFile('./src/native3d-runtime.js','utf8');const code=text.slice(text.indexOf('  async function createResolution('),text.indexOf('  async function nextStep('));
const actual=JSON.parse(await readFile('.cache/native3d/quarry-and-first-v1/lod4-resolution-v1/user-job.json','utf8'));
function fixture(){
 const failureJob=structuredClone(actual),g=failureJob.result.metadata.geometry,pid=failureJob.parameters.retryJobId,hash=g.retry.parentMeshHash,path=failureJob.source.assetPath,highHash=g.retry.originalSourceSha256;
 const parent={id:'parent',type:'native3d',position:{x:0,y:0},data:{operation:'analyze',status:'completed',sourceJobId:pid,assetPath:path,nativeStage:'lod3',metadata:{geometry:{status:'accepted',selectedMeshHash:hash}}}};
 const high={id:'high',type:'native3d',position:{x:-400,y:0},data:{operation:'analyze',status:'completed',assetPath:`assets/${highHash}.glb`}};
 const result={id:'result',type:'native3d',position:{x:400,y:0},data:{operation:'analyze',status:'completed',sourceJobId:failureJob.id,sourceNodeId:failureJob.nodeId,assetPath:`assets/${failureJob.result.files.find(f=>f.name==='blocked_lod4.glb').sha256}.glb`,metadata:failureJob.result.metadata}};
 const processor={id:failureJob.nodeId,type:'native3d',position:{x:0,y:500},data:{operation:'source_lod',status:'completed',nativeJobId:failureJob.id}};
 const parentJob={id:pid,projectId:failureJob.projectId,operation:'source_lod',status:'succeeded',parameters:{seed:5},source:{highAssetPath:high.data.assetPath,highSha256:highHash},result:{files:[{name:'lod3.glb',role:'export',sha256:g.retry.parentFileSha256}],metadata:{geometry:{stages:[{stage:'lod3',filename:'lod3.glb',status:'accepted',eligibleForDownstream:true,mesh_hash:hash,receipt:{geometry:{status:'accepted',intersectionComplete:true,intersection_pairs_count:0}}}]}}}};
 const calls=[],o={projectId:failureJob.projectId,readOnly:false,switchingRef:{current:false},nodesRef:{current:[result,processor,parent,high]},edgesRef:{current:[]},setNodes(){},setEdges(){},focusNode(id){calls.push(['focus',id]);},persistProject:async retry=>calls.push(['persist',retry]),updateNode(id,patch){o.nodesRef.current=o.nodesRef.current.map(n=>n.id===id?{...n,data:{...n.data,...patch}}:n);}};
 const latest={current:o},hooks={request:async url=>url.endsWith(failureJob.id)?failureJob:parentJob};
 const deps={nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges,current:()=>{if(latest.current.readOnly||latest.current.switchingRef.current)throw Error('readonly');return latest.current;},latest,nextStepOrigin,resolutionDraft,withNativeRerunLock,rerunLocks:{current:new Set()},nextNativeLODSeed,nativeRequest:async url=>{calls.push(['GET',url]);return hooks.request(url);}};
 return {o,latest,hooks,calls,failureJob,parentJob,result,run:new Function(...Object.keys(deps),code+';return createResolution;')(...Object.values(deps))};
}
{const f=fixture();const a=await f.run(f.failureJob.nodeId,1.5);assert.equal(a.generated,false);assert.equal(f.o.nodesRef.current.length,5);const draft=f.o.nodesRef.current[4];assert.equal(draft.data.nativeParameters.retryKeepPercent,1.5);assert.notEqual(draft.data.nativeParameters.seed,f.failureJob.parameters.seed);assert.equal(draft.data.nativeParameters.retryJobId,f.parentJob.id);const b=await f.run('result',1.5);assert.equal(b.reused,true);assert.equal(b.nodeId,a.nodeId);assert.ok(f.calls.every(c=>['GET','persist','focus'].includes(c[0])));}
{const f=fixture();let resolve;f.hooks.request=()=>new Promise(r=>resolve=r);const pending=f.run('result',1.5);await assert.rejects(f.run('result',1.5),/重复/);f.o.projectId='other';resolve(f.failureJob);await assert.rejects(pending,/项目/);assert.equal(f.o.nodesRef.current.length,4);}
{const f=fixture();f.o.persistProject=async()=>{throw Error('network');};await assert.rejects(f.run('result',1.5),/network/);assert.equal(f.o.nodesRef.current[4].data.nativeResolutionSaveFailed,true);let retry;f.o.persistProject=async v=>{retry=v;};assert.equal((await f.run('result',1.5)).reused,true);assert.equal(retry,true);}
{const f=fixture();f.o.persistProject=async()=>{f.o.edgesRef.current[0].source='other';};await assert.rejects(f.run('result',1.5),/编辑|启动/);}
{const f=fixture();await f.run('result',1.5);f.o.nodesRef.current.find(n=>n.id==='high').data.status='stale';await assert.rejects(f.run('result',1.5),/高模/);}
{const f=fixture();f.o.readOnly=true;await assert.rejects(f.run('result',1.5),/readonly/);assert.equal(f.calls.length,0);}
{const f=fixture();f.result.data.assetPath='assets/other.glb';await assert.rejects(f.run('result',1.5),/诊断模型/);assert.equal(f.o.nodesRef.current.length,4);}
{const f=fixture();f.failureJob.result.metadata.geometry.targetPolicy.frozenFaceCap=1249;await assert.rejects(f.run('result',1.5),/原父模型和硬上限/);assert.equal(f.o.nodesRef.current.length,4);}
{const f=fixture();f.o.persistProject=async()=>{f.o.readOnly=true;throw Error('lost');};await assert.rejects(f.run('result',1.5));assert.equal(f.o.nodesRef.current[4].data.nativeResolutionSaveFailed,undefined);}
console.log('LOD_RESOLUTION_RUNTIME_OK actual failed job/create-only/reuse/exact-parent/save-recovery/switch/readonly/hardcap');
{const f=fixture();f.o.nodesRef.current=f.o.nodesRef.current.filter(n=>n.id!=='result');const made=await f.run(f.failureJob.nodeId,1.5);assert.equal(made.generated,false);assert.equal(f.o.nodesRef.current.at(-1).data.nativeParameters.retryKeepPercent,1.5);}
console.log('RESOLUTION_PROCESSOR_WITHOUT_RESULT_OK exact job diagnostic virtual binding; no canvas source invention');
