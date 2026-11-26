import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {compactNative3DGraph} from './src/native3d-inline-migration.js';
import {nativeOutputNode} from './src/native3d-output.js';
import {nativeLODStageRetryPlan} from './src/native3d-rerun.js';
import {resolutionDraft,lodResolution} from './src/native3d-lod-resolution.js';
const {project,failureJob,parentJob}=JSON.parse(await readFile('.cache/native3d-inline-results/retry-proof-input.json','utf8'));
const compact=compactNative3DGraph(project.canvas.nodes,project.canvas.edges);
const cleanupIds=compact.nodes.filter(n=>n.type==='native3d'&&(['error','failed','cancelled','canceled'].includes(n.data.status)||(n.data.operation==='source_lod'||n.data.metadata?.operation==='source_lod')&&n.data.metadata?.geometry?.status==='blocked')).map(n=>n.id);
const cleaned=compactNative3DGraph(compact.nodes,compact.edges,{cleanupFailed:true,cleanupIds});
const source=nativeOutputNode(cleaned.nodes.find(n=>n.id===failureJob.nodeId));
assert.equal(source.data.sourceJobId,failureJob.id);
const before=nativeLODStageRetryPlan(source,compact.nodes,parentJob,project.id,1234567,'offline-retry-proof');
const after=nativeLODStageRetryPlan(source,cleaned.nodes,parentJob,project.id,1234567,'offline-retry-proof');
assert.deepEqual(after.node.data.nativeParameters,before.node.data.nativeParameters);assert.deepEqual(after.edges,before.edges);assert.deepEqual(after.target,before.target);
const resolution=lodResolution(source.data);
if(resolution.available){
 const args={result:source,failureJob,parentJob,projectId:project.id,percent:resolution.suggestedPercent,seed:1234567,id:'offline-resolution-proof'};
 const a=resolutionDraft({...args,nodes:compact.nodes,edges:compact.edges}),b=resolutionDraft({...args,nodes:cleaned.nodes,edges:cleaned.edges});
 assert.deepEqual(a.node.data.nativeParameters,b.node.data.nativeParameters);assert.deepEqual(a.edges,b.edges);
}
const plan={projectId:project.id,revision:project.revision,dryRun:true,compaction:compact.summary,requestedCleanupIds:cleanupIds,safeCleanupIds:cleaned.summary.removedNodeIds,retainedCleanup:cleaned.summary.retainedCleanup,afterCompactionCleanup:cleaned.summary,retryProof:{sourceJobId:failureJob.id,parentJobId:parentJob.id,parametersUnchanged:true,inputsUnchanged:true,thresholdsUnchanged:true,backendJobsDeleted:false,assetsDeleted:false},ignoredHistoryFields:['nativeLODStageRetry.originResultId','nativeResolution.key','nativeResolution.failureJobId']};
await writeFile('.cache/native3d-inline-results/cleanup-plan.json',JSON.stringify(plan,null,2));
console.log('INLINE_REAL_RETRY_OK',JSON.stringify({revision:project.revision,removed:plan.safeCleanupIds,retained:plan.retainedCleanup,finalNodeCount:cleaned.nodes.length}));
