import assert from 'node:assert/strict';
import {nativeRerunTarget,nativeProcessorRunLabel,withNativeRerunLock,nativeAutomaticLODStages} from './src/native3d-rerun.js';
const job='n3d_'+'a'.repeat(32);
const processor={id:'p',type:'native3d',data:{operation:'source_lod',title:'原LOD处理',nativeJobId:job,nativeDeliveredJobId:job,status:'completed'}};
const result={id:'r',type:'native3d',data:{operation:'analyze',sourceNodeId:'p',sourceJobId:job,status:'completed',metadata:{operation:'source_lod'},nativeStage:'lod3',nativeStageDiagnostic:true}};
const snapshot=structuredClone([processor,result]);
assert.equal(nativeRerunTarget(result,[processor,result]).label,'重新生成LOD3（新种子）');
assert.match(nativeRerunTarget(result,[processor,result]).scope,/仅重试本档/);
assert.deepEqual([processor,result],snapshot);
assert.equal(nativeRerunTarget(result,[{...processor,data:{...processor.data,operation:'uv'}},result]).label,'重新分UV');
for(const change of [{status:'queued'},{status:'running'},{status:'finishing'},{nativeDeliveryErrorJobId:job},{operation:'analyze'}])
 assert.throws(()=>nativeRerunTarget(result,[{...processor,data:{...processor.data,...change}},result]));
assert.throws(()=>nativeRerunTarget(result,[result]));
assert.throws(()=>nativeRerunTarget({...result,data:{...result.data,status:'stale'}},[processor]));
assert.equal(nativeProcessorRunLabel({operation:'uv',status:'failed'}),'重新分UV');
assert.equal(nativeProcessorRunLabel({operation:'source_lod',metadata:{geometry:{}}}),'重新生成LOD链');
assert.equal(nativeProcessorRunLabel({operation:'uv'},true),'重新交付');
const locks=new Set();let release;let calls=0;
const first=withNativeRerunLock(locks,'p',async()=>{calls++;await new Promise(resolve=>release=resolve);});
await assert.rejects(withNativeRerunLock(locks,'p',async()=>calls++),/重复点击/);release();await first;assert.equal(calls,1);assert.equal(locks.size,0);
await assert.rejects(withNativeRerunLock(locks,'p',async()=>{throw Error('fixture');}),/fixture/);assert.equal(locks.size,0);
const accepted=n=>({stage:`lod${n}`,visible:true,status:'accepted',eligibleForDownstream:true,receipt:{geometry:{status:'accepted',intersectionComplete:true,intersection_pairs_count:0}}});
const blocked={stage:'lod3',visible:true,status:'blocked',eligibleForDownstream:false,diagnosticFilename:'blocked_lod3.glb',diagnosticFileSha256:'a'.repeat(64),receipt:{geometry:{status:'blocked'}}};
const data={metadata:{operation:'source_lod',geometry:{selectedStage:'lod0',selectedLodLevel:0,stages:[accepted(0),accepted(1),accepted(2),blocked]}}};
assert.deepEqual(nativeAutomaticLODStages(data),[{stage:'lod1',diagnostic:false},{stage:'lod2',diagnostic:false},{stage:'lod3',diagnostic:true}]);
assert.equal(nativeAutomaticLODStages({...data,metadata:{...data.metadata,operation:'uv'}}).length,0);
for(const change of [{diagnosticFilename:undefined},{eligibleForDownstream:true},{status:'accepted'},{visible:false}]) {
 const changed={metadata:{operation:'source_lod',geometry:{stages:[{...blocked,...change}]}}};assert.equal(nativeAutomaticLODStages(changed).length,0);
}
const incomplete=accepted(2);incomplete.receipt.geometry.intersectionComplete=false;
assert.deepEqual(nativeAutomaticLODStages({metadata:{operation:'source_lod',geometry:{stages:[incomplete]}}}),[]);
console.log('NATIVE3D_RERUN_OK honest chain label,UV retry,source identity,busy/stale/delivery guards,duplicate lock,original retained,registered-only automatic LOD stages,no selected duplication/no fabricated LOD4');

const {layoutNativeResultDelivery}=await import('./src/native3d-rerun.js');
const liveProcessor={...processor,position:{x:1000,y:700}};
const queuedResult={...result,position:{x:390,y:0}};
const plan={existing:false,node:{id:'s1',type:'native3d',position:{x:810,y:0},data:{sourceJobId:job,assetPath:'assets/fixture.glb'}}};
const obstacle={id:'user-added-during-preview',type:'native3d',position:{x:1390,y:700},data:{}};
const latest=[liveProcessor,obstacle];const unchanged=structuredClone(latest);
const layout=layoutNativeResultDelivery(latest,queuedResult,[plan]);
assert.deepEqual(latest,unchanged);
const boxes=[...latest,layout.result,...layout.plans.map(p=>p.node)];
for(const added of [layout.result,...layout.plans.map(p=>p.node)])for(const other of boxes.filter(n=>n.id!==added.id)) {
 const a=added.position,b=other.position;
 assert.equal(a.x<b.x+380&&a.x+380>b.x&&a.y<b.y+320&&a.y+320>b.y,false,'new nodes must avoid live obstacles');
}
const movedResult={...queuedResult,position:{x:3000,y:1600}};
const movedStage={...plan.node,position:{x:3800,y:1800}};
const existingLayout=layoutNativeResultDelivery([liveProcessor,movedResult,movedStage],queuedResult,[plan]);
assert.deepEqual(existingLayout.result.position,movedResult.position);assert.deepEqual(existingLayout.plans[0].node.position,movedStage.position);assert.equal(existingLayout.plans[0].existing,true);
assert.throws(()=>layoutNativeResultDelivery([{...movedStage,data:{...movedStage.data,assetPath:'changed'}}],queuedResult,[plan]),/来源已改变/);
console.log('NATIVE3D_DELIVERY_LAYOUT_OK commit-time live positions,new obstacles,existing positions preserved,no source override');
