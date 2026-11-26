import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compactNative3DGraph as compact} from './src/native3d-inline-migration.js';
import {nativeOutputForEdge} from './src/native3d-output.js';
import {nativeModelIdentity,nativeRunIdentity} from './src/native3d.js';
import {nativeInputs} from './src/native3d-plan.js';
const job='n3d_'+'1'.repeat(32),asset=`assets/${'a'.repeat(64)}.glb`;
function fixture(){
 const producer={id:'producer',type:'native3d',position:{x:0,y:0},data:{operation:'uv',status:'completed',nativeJobId:job,nativeDeliveredJobId:job,resultAssetPath:asset,nativeRun:{identity:'frozen'}}};
 const result={id:'native3d-result-'+job,type:'native3d',position:{x:390,y:0},data:{operation:'analyze',status:'completed',sourceNodeId:'producer',sourceJobId:job,nativeDeliveredJobId:job,assetPath:asset,metadata:{operation:'uv'},nativeUVPreviews:{layout:'saved-layout'},nativeUVPreviewMode:'layout'}};
 const target={id:'target',type:'native3d',data:{operation:'bake',status:'idle'}};
 return {nodes:[producer,result,target,{id:'note',type:'note',data:{text:'untouched'}}],edges:[{id:'output',source:'producer',target:result.id,targetHandle:'provenance'},{id:'input',source:result.id,target:'target',targetHandle:'model',sourceHandle:'model'}]};
}
{
 const f=fixture(),before=structuredClone(f),r=compact(f.nodes,f.edges);
 assert.deepEqual(f,before);assert.equal(r.nodes.length,3);assert.equal(r.edges.length,1);assert.equal(r.edges[0].source,'producer');
 assert.equal(r.edges[0].data.outputRecordId,f.nodes[1].id);
 assert.deepEqual(r.nodes[0].data.nativeOutputRecords[0].data,f.nodes[1].data);
 assert.deepEqual(nativeModelIdentity(nativeOutputForEdge(r.nodes[0],r.edges[0])),nativeModelIdentity(f.nodes[1]));
 assert.equal(r.nodes.at(-1),f.nodes.at(-1));const again=compact(r.nodes,r.edges);assert.deepEqual(again.nodes,r.nodes);assert.deepEqual(again.edges,r.edges);assert.deepEqual(again.summary.collapsedNodeIds,[]);
 const self=fixture();self.edges.push({id:'self',source:self.nodes[1].id,target:'producer',targetHandle:'model'});assert.throws(()=>compact(self.nodes,self.edges),/自连接/);
 const stale=fixture();stale.nodes[0].data.nativeJobId='n3d_'+'2'.repeat(32);assert.equal(compact(stale.nodes,stale.edges).summary.collapsedNodeIds.length,0);
}
{
 const f=fixture(),failed={id:'failed',type:'native3d',data:{operation:'uv_plan',status:'failed',nativeJobId:'n3d_'+'3'.repeat(32)}};f.nodes.push(failed);
 assert.equal(compact(f.nodes,f.edges,{cleanupFailed:true,cleanupIds:['failed']}).summary.removedNodeIds[0],'failed');
 f.nodes[2].data.nativeParameters={retryJobId:failed.data.nativeJobId};assert.equal(compact(f.nodes,f.edges,{cleanupFailed:true,cleanupIds:['failed']}).summary.removedNodeIds.length,0);
 delete f.nodes[2].data.nativeParameters;f.edges.push({id:'dependent',source:'failed',target:'target'});assert.equal(compact(f.nodes,f.edges,{cleanupFailed:true,cleanupIds:['failed']}).summary.removedNodeIds.length,0);
 f.edges.pop();f.nodes[2].data.nativeLODStageRetry={originResultId:'failed'};f.nodes[2].data.nativeResolution={key:JSON.stringify(['p',failed.data.nativeJobId,'lod4']),failureJobId:failed.data.nativeJobId};
 const cleaned=compact(f.nodes,f.edges,{cleanupFailed:true,cleanupIds:['failed']});assert.deepEqual(cleaned.summary.removedNodeIds,['failed']);assert.deepEqual(cleaned.nodes.find(n=>n.id==='target').data,f.nodes[2].data);
 f.nodes[2].data.nativeLODStageRetry.parentAssetPath=failed.data.assetPath=asset;assert.equal(compact(f.nodes,f.edges,{cleanupFailed:true,cleanupIds:['failed']}).summary.removedNodeIds.length,0);
 assert.throws(()=>compact([{...failed,data:{...failed.data,status:'running'}}],[]),/运行/);
}
// Read-only saved real graph: all immutable payloads/plan confirmations and input identities survive.
try {
 const project=JSON.parse(await readFile('.cache/native3d-inline-results/project-before.json','utf8')),{nodes,edges}=project.canvas,r=compact(nodes,edges);
 for(const id of r.summary.collapsedNodeIds) {
  const old=nodes.find(n=>n.id===id),owner=r.nodes.find(n=>n.id===old.data.sourceNodeId),record=owner.data.nativeOutputRecords.find(x=>x.recordId===id);
  assert.deepEqual(record.data,old.data);
 }
 for(const n of nodes.filter(n=>n.type==='native3d'&&n.data.operation!=='analyze')) {
  const next=r.nodes.find(x=>x.id===n.id),oldInputs=nativeInputs(n,nodes,edges),newInputs=nativeInputs(next,r.nodes,r.edges);
  assert.equal(nativeRunIdentity(n,oldInputs.model,oldInputs),nativeRunIdentity(next,newInputs.model,newInputs),n.id);
 }
 assert.ok(r.nodes.some(n=>n.id==='native3d-stage-n3d_0c519a16202940869dd2e139b7ea6509-lod0'));
 assert.ok(r.nodes.some(n=>n.data.nativeOutputRecords?.some(record=>record.jobId==='n3d_e14cd90011394861a6dfbf8d51e0c66e')));
 assert.deepEqual(r.nodes.filter(n=>n.type!=='native3d'),nodes.filter(n=>n.type!=='native3d'));
 const again=compact(r.nodes,r.edges);assert.deepEqual(again.nodes,r.nodes);assert.deepEqual(again.edges,r.edges);
 console.log('INLINE_REAL_SNAPSHOT_OK',JSON.stringify(r.summary));
}catch(error){if(error.code!=='ENOENT')throw error;}
console.log('INLINE_MIGRATION_OK exact output binding, immutable records, identities, idempotency, dependency-safe explicit cleanup, self-loop rejection');
