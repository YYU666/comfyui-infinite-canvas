import assert from 'node:assert/strict';
import {registerCanvasMcp,waitForNodeForMcp,native3dNodeSummary} from './src/canvas-mcp.js';
const tools=new Map(),calls=[];let tidies=0,saves=0;
const latest={current:{readOnly:false,actions:{native3dCompact:async request=>{calls.push(request);return {dryRun:request.dryRun,removedNodeIds:[],revision:442};},tidyCanvas:()=>tidies++,persistProject:async()=>saves++}}};
const stop=registerCanvasMcp(latest,{context:{registerTool:t=>tools.set(t.name,t)},startPage:()=>()=>{}});
const tidy=tools.get('canvas_tidy');assert.deepEqual(tidy.inputSchema.properties.mode.enum,['native3d_compact']);
assert.equal(JSON.parse(await tidy.execute({})).ok,true);assert.equal(tidies,1);assert.equal(saves,1);
let r=JSON.parse(await tidy.execute({mode:'native3d_compact'}));assert.equal(r.dryRun,true);assert.equal(tidies,1);assert.equal(saves,1);
r=JSON.parse(await tidy.execute({mode:'native3d_compact',dryRun:false,cleanupFailedIds:['failed']}));assert.equal(r.revision,442);assert.deepEqual(calls.at(-1),{dryRun:false,cleanupFailed:true,cleanupIds:['failed']});assert.equal(saves,1);
assert.equal(JSON.parse(await tidy.execute({mode:'unknown'})).ok,false);assert.equal(tidies,1);
latest.current.readOnly=true;assert.equal(JSON.parse(await tidy.execute({mode:'native3d_compact',dryRun:false})).ok,false);assert.equal(JSON.parse(await tidy.execute({mode:'native3d_compact'})).ok,true);
assert.equal(JSON.parse(await tools.get('canvas_native3d_compact').execute({})).dryRun,true);stop();
{
 const job='n3d_'+'a'.repeat(32),recordId='native3d-result-'+job,asset='assets/'+'b'.repeat(64)+'.glb';
 const node={id:'producer',type:'native3d',data:{operation:'source_lod',status:'completed',nativeJobId:job,resultAssetPath:asset,nativeCurrentOutputId:recordId,nativeOutputRecords:[{schemaVersion:1,recordId,jobId:job,data:{operation:'analyze',status:'completed',sourceJobId:job,sourceNodeId:'producer',assetPath:asset,metadata:{operation:'source_lod'}}}]}};
 const actions={native3dRetryStage:async id=>({processorId:id}),persistProject:async()=>{}};
 const current={current:{readOnly:false,nodesRef:{current:[node]},actions}},registered=new Map();
 const end=registerCanvasMcp(current,{context:{registerTool:t=>registered.set(t.name,t)},startPage:()=>()=>{}});
 assert.equal(JSON.parse(await registered.get('canvas_native3d_retry_stage').execute({nodeId:'producer'})).processorId,'producer');
 const result=await waitForNodeForMcp(current,{nodeId:'producer'},async poll=>poll());assert.equal(result.resultNode.id,'producer');assert.equal(result.resultNode.assetPath,asset);
 const summary=native3dNodeSummary(node);assert.equal(summary.nativeOutputRecordCount,1);assert.equal(summary.nativeCurrentOutputId,recordId);assert.equal(summary.resultAssetPath,asset);assert.ok(!JSON.stringify(summary).includes('nativeOutputRecords'));
 end();
}
console.log('INLINE_MCP_OK explicit mode, default tidy unchanged, read-only dry-run, no double save, cleanup ids and revision forwarded');
