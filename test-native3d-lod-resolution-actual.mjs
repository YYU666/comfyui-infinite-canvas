import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {nativeLODStageRetryPlan} from './src/native3d-rerun.js';
import {resolutionDraft} from './src/native3d-lod-resolution.js';
const folder='.cache/native3d/quarry-and-first-v1/';
const page=JSON.parse(await readFile(folder+'manual-next-step-v1/baseline-page.json','utf8'));
const failureJob=JSON.parse(await readFile(folder+'lod4-resolution-v1/user-job.json','utf8'));
const parentJob=JSON.parse(await readFile(folder+'lod4-resolution-v1/ui/actual-parent-job.json','utf8'));
const nodes=structuredClone(page.canvas.nodes),edges=structuredClone(page.canvas.edges);
const processor={id:failureJob.nodeId,type:'native3d',position:{x:0,y:0},data:{operation:'source_lod',status:'completed',nativeJobId:failureJob.id}};
const digest=failureJob.result.files.find(f=>f.name==='blocked_lod4.glb').sha256;
const result={id:`native3d-result-${failureJob.id}`,type:'native3d',position:{x:400,y:0},data:{operation:'analyze',sourceNodeId:processor.id,sourceJobId:failureJob.id,status:'completed',assetPath:`assets/${digest}.glb`,metadata:failureJob.result.metadata}};
const live=nodes.filter(n=>![processor.id,result.id].includes(n.id)).concat(processor,result);
const parent=live.find(n=>n.id===`native3d-result-${parentJob.id}`);
assert.equal(parent.data.nativeLODLevel,3);
const args={result,nodes:live,edges,failureJob,parentJob,projectId:page.id,percent:1.5,seed:12345,id:'offline-adjustment'};
const before=JSON.stringify(live),plan=resolutionDraft(args);assert.equal(JSON.stringify(live),before);
assert.equal(plan.edges[0].source,parent.id);assert.equal(plan.node.data.nativeParameters.retryKeepPercent,1.5);
const generic=structuredClone(live),gp=generic.find(n=>n.id===parent.id);delete gp.data.metadata.geometry.selectedStage;delete gp.data.metadata.geometry.selectedMeshHash;delete gp.data.nativeStage;
const genericPlan=resolutionDraft({...args,nodes:generic});assert.equal(genericPlan.edges[0].source,parent.id);
gp.data.metadata.geometry.selectedMeshHash='0'.repeat(64);assert.throws(()=>resolutionDraft({...args,nodes:generic}),/父模型/);
await writeFile(folder+'lod4-resolution-v1/ui/actual-shape-proof.json',JSON.stringify({parentJobId:parentJob.id,failureJobId:failureJob.id,sourcePageRevision:page.revision,parentNodeId:parent.id,parentFieldsPresent:Object.keys(parent.data.metadata.geometry).filter(k=>['selectedStage','selectedMeshHash','selectedLodLevel'].includes(k)),parentAssetPath:plan.node.data.nativeLODStageRetry.parentAssetPath,requestedKeepPercent:1.5,suggestedFaces:plan.resolution.suggestedFaces,originalPageUnchanged:true,genericOmittedFieldsAccepted:true,presentMismatchedHashRejected:true,generated:false,posted:false},null,2));
console.log('LOD_RESOLUTION_ACTUAL_SHAPE_OK real saved page+parent manifest+failure manifest; omitted redundant fields supported; no metadata mutation');

const matches=new Map();for(const n of nodes){if(n.type!=='native3d'||n.data.operation!=='analyze'||!n.data.sourceJobId)continue;const key=JSON.stringify([n.data.sourceJobId,n.data.assetPath]);matches.set(key,[...(matches.get(key)||[]),n]);}
let equivalentPairs=0;
for(const group of matches.values()){
 if(group.length<2)continue;const sample=group[0],g=sample.data.metadata?.geometry,level=sample.data.nativeLODLevel??g?.selectedLodLevel;if(![1,2].includes(level))continue;
 const stage=`lod${level}`,record=g.stages.find(r=>r.stage===stage),jobId=sample.data.sourceJobId;
 const high=nodes.find(n=>n.type==='native3d'&&n.data.operation==='analyze'&&!n.data.sourceJobId&&n.data.assetPath===sample.data.originalAssetPath);if(!high)continue;
 const source={id:'duplicate-case-processor',type:'native3d',position:{x:0,y:0},data:{operation:'source_lod',status:'completed',nativeJobId:jobId}};
 const failed={id:'duplicate-case-result',type:'native3d',position:{x:400,y:0},data:{operation:'analyze',status:'completed',sourceNodeId:source.id,sourceJobId:jobId,nativeStage:`lod${level+1}`,metadata:{operation:'source_lod',geometry:{status:'blocked'}}}};
 const job={id:jobId,projectId:page.id,operation:'source_lod',status:'succeeded',parameters:{},source:{highAssetPath:high.data.assetPath,highSha256:high.data.assetPath.slice(7,71)},result:{metadata:{geometry:{stages:[record]}},files:[{name:record.filename,role:'export',sha256:sample.data.assetPath.slice(7,71)}]}};
 const retry=nativeLODStageRetryPlan(failed,[...nodes,source,failed],job,page.id,12345,`duplicate-draft-${level}`);
 assert.ok(group.some(n=>n.id===retry.edges[0].source));assert.equal(retry.edges[0].source,group[0].id);equivalentPairs++;
}
assert.ok(equivalentPairs>=2,'actual saved LOD1/LOD2 equivalent duplicate nodes exercised');
console.log(`LOD_RETRY_ACTUAL_EQUIVALENT_DUPLICATES_OK ${equivalentPairs} saved-page LOD groups; same exact artifact nodes retain original order`);

const proofPath=folder+'lod4-resolution-v1/ui/actual-shape-proof.json';const proof=JSON.parse(await readFile(proofPath,'utf8'));proof.actualEquivalentDuplicateLODGroups=equivalentPairs;proof.equivalentDuplicateSelection='first exact matching node in saved page order';await writeFile(proofPath,JSON.stringify(proof,null,2));
