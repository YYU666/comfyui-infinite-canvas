import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeUVOrientationError,nativeEmptyPoster} from './src/native3d-uv-prerequisite.js';
const text=await readFile('src/native3d-runtime.js','utf8');
const code=text.slice(text.indexOf('  async function run(id)'),text.indexOf('  async function importModel'));
function fixture({confirmed=false,open=true,readOnly=false}={}) {
 const source={id:'low',data:{assetPath:'assets/low.glb',quality:{boundaryEdges:open?69:0,watertight:!open}}};
 const high={id:'high',data:{assetPath:'assets/high.glb'}};
 const node={id:'plan',data:{operation:'uv_plan',status:'error',nativeParameters:{orientationConfirmed:confirmed},nativeRun:{opId:'old',sourceId:'low',sourceAssetPath:source.data.assetPath,highAssetPath:high.data.assetPath},nativeJobId:'old-job',error:'old failure'}};
 const calls=[];const o={projectId:'fixture',readOnly,switchingRef:{current:false},nodesRef:{current:[node]},persistProject:async()=>calls.push('persist')};
 const inputs={model:source,high}; const hooks={afterPersist:()=>{}};
 o.persistProject=async()=>{calls.push('persist');hooks.afterPersist();};
 const current=()=>{if(o.readOnly||o.switchingRef.current)throw Error('readonly');return o;};
 const deps={current,latest:{current:o},sourceFor:()=>source,inputsFor:()=>inputs,identityFor:()=>source.data.assetPath,capabilities:{operations:{uv_plan:{ready:true}}},nativeParameters:(_,p)=>p,nativeGeometryInputError:()=>null,nativeUVOrientationError,patch:(_,p)=>{calls.push('patch');Object.assign(node.data,p);},assertRun:()=>{current();if(node.data.nativeRun.identity!==source.data.assetPath)throw Error('identity');},nativeRequest:async()=>{calls.push('POST');return {id:'new-job'};},crypto:{randomUUID:()=>{calls.push('uuid');return 'new';}}};
 const run=new Function(...Object.keys(deps),code+';return run;')(...Object.values(deps));return {run,node,source,inputs,calls,o,hooks};
}
{
 const f=fixture(),before=structuredClone(f.node);await assert.rejects(f.run('plan'),/开放网格/);assert.deepEqual(f.calls,[]);assert.deepEqual(f.node,before);
}
for(const settings of [{confirmed:true},{open:false}]) {const f=fixture(settings);await f.run('plan');assert.equal(f.calls.filter(c=>c==='POST').length,1);}
for(const flag of ['readOnly','switching']) {const f=fixture({confirmed:true});if(flag==='readOnly')f.o.readOnly=true;else f.o.switchingRef.current=true;await assert.rejects(f.run('plan'),/readonly/);assert.deepEqual(f.calls,[]);}
{const f=fixture({confirmed:true});f.hooks.afterPersist=()=>{f.source.data.assetPath='changed';};await assert.rejects(f.run('plan'),/identity/);assert.ok(!f.calls.includes('POST'));}
{const f=fixture({open:false});delete f.source.data.quality;f.source.data.metadata={source:{boundaryEdges:99,watertight:false}};assert.equal(nativeUVOrientationError(f.node,f.inputs),null);f.node.data.error='Open structural UV requires reference orientationConfirmed';assert.match(nativeUVOrientationError(f.node,f.inputs),/法线/);f.source.data.assetPath='new';assert.equal(nativeUVOrientationError(f.node,f.inputs),null);}
{const f=fixture();assert.match(nativeEmptyPoster(f.node.data,f.inputs),/已连接.*未展开UV/);assert.doesNotMatch(nativeEmptyPoster(f.node.data,f.inputs),/导入/);}
console.log('UV_ORIENTATION_OK no writes/job/opId on prerequisite; failed provenance retained; confirmation/closed allow; readonly/switch/identity guards; parent metadata ignored; stale failure ignored; input-aware poster');
