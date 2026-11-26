import {nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges} from './src/native3d-output.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeNextStepPlan,nextStepActions,nextStepOrigin} from './src/native3d-next-step.js';
import {withNativeRerunLock,nextNativeLODSeed} from './src/native3d-rerun.js';
const sourceText=await readFile('./src/native3d-runtime.js','utf8');const code=sourceText.slice(sourceText.indexOf('  function nextSource('),sourceText.indexOf('  async function rerunResult('));
const h='a'.repeat(64),hh='b'.repeat(64),mh='c'.repeat(64),jid='n3d_'+'1'.repeat(32);
function fixture(){
 const record={stage:'lod3',status:'accepted',eligibleForDownstream:true,filename:'lod3.glb',file_sha256:h,mesh_hash:mh,receipt:{geometry:{status:'accepted',mesh_hash:mh,intersectionComplete:true,intersection_pairs_count:0}}};
 const source={id:'source',type:'native3d',position:{x:0,y:0},data:{sourceJobId:jid,operation:'analyze',status:'completed',assetPath:`assets/${h}.glb`,metadata:{operation:'source_lod',geometry:{status:'accepted',selectedStage:'lod3',selectedLodLevel:3}}}};
 const high={id:'high',type:'native3d',position:{x:-400,y:0},data:{operation:'analyze',status:'completed',assetPath:`assets/${hh}.glb`}};
 const job={id:jid,projectId:'p',operation:'source_lod',status:'succeeded',source:{highAssetPath:high.data.assetPath,highSha256:hh},parameters:{seed:3},result:{files:[{name:'lod3.glb',role:'export',sha256:h}],metadata:{geometry:{stages:[record],settings:{},retry:{lod0Triangles:99999,originalSourceSha256:hh}}}}};
 const calls=[];const o={projectId:'p',readOnly:false,switchingRef:{current:false},nodesRef:{current:[source,high]},edgesRef:{current:[]},setNodes(){},setEdges(){},focusNode(){},persistProject:async retry=>{calls.push(['persist',retry]);},updateNode(id,patch){o.nodesRef.current=o.nodesRef.current.map(n=>n.id===id?{...n,data:{...n.data,...patch}}:n);}};
 const latest={current:o},hooks={request:async()=>job};const current=()=>{if(latest.current.readOnly||latest.current.switchingRef.current)throw Error('readonly');return latest.current;};
 const deps={nativeOutputNode,nativeAppendOutput,nativeBindOutputEdges,current,latest,nextStepOrigin,nextStepActions,withNativeRerunLock,rerunLocks:{current:new Set()},nativeRequest:async url=>{calls.push(['GET',url]);return hooks.request();},nextNativeLODSeed,nativeNextStepPlan,assertLivePlan:()=>{throw Error('not current');}};
 const run=new Function(...Object.keys(deps),code+';return nextStep;')(...Object.values(deps));return {o,latest,run,calls,hooks,job};
}
{
 const f=fixture();const a=await f.run('source','next_lod');assert.equal(a.generated,false);assert.equal(f.o.nodesRef.current.length,3);const b=await f.run('source','next_lod');assert.equal(b.reused,true);assert.equal(b.nodeId,a.nodeId);assert.equal(f.o.nodesRef.current.length,3);assert.ok(f.calls.every(c=>['GET','persist'].includes(c[0])));
}
{
 const f=fixture();let resolve;f.hooks.request=()=>new Promise(r=>resolve=r);const first=f.run('source','next_lod');await assert.rejects(f.run('source','next_lod'),/重复/);f.o.projectId='other';resolve(f.job);await assert.rejects(first,/项目/);assert.equal(f.o.nodesRef.current.length,2);
}
{
 const f=fixture();f.o.persistProject=async()=>{throw Error('network');};await assert.rejects(f.run('source','next_lod'),/network/);assert.equal(f.o.nodesRef.current.length,3);assert.equal(f.o.nodesRef.current[2].data.nativeNextStepSaveFailed,true);let retry;
 f.o.persistProject=async value=>{retry=value;};const result=await f.run('source','next_lod');assert.equal(result.reused,true);assert.equal(retry,true);assert.equal(f.o.nodesRef.current.length,3);
}
{
 const f=fixture();f.o.readOnly=true;await assert.rejects(f.run('source','next_lod'),/readonly/);assert.equal(f.calls.length,0);
}
{
 const f=fixture();f.o.persistProject=async()=>{f.o.edgesRef.current[0].source='changed';};await assert.rejects(f.run('source','next_lod'),/改线/);assert.equal(f.o.nodesRef.current.length,3);
}
{
 const f=fixture();f.o.persistProject=async()=>{f.o.readOnly=true;throw Error('lost');};await assert.rejects(f.run('source','next_lod'));assert.equal(f.o.nodesRef.current[2].data.nativeNextStepSaveFailed,undefined);
}
console.log('NEXT_STEP_RUNTIME_OK create-only/reuse/save-failure/project-switch/readonly/double-click/post-save-input-check');

