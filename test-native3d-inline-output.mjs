import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeAppendOutput,nativeOutputNode,nativeOutputForEdge,nativeOutputCandidates} from './src/native3d-output.js';
import {nativeInputs,assertPlanCurrent,assertConfirmedPlan} from './src/native3d-plan.js';
import {nativeRunIdentity,nativeModelIdentity} from './src/native3d.js';
import {compactNative3DGraph} from './src/native3d-inline-migration.js';
import {planCanvasConnection} from './src/canvas-connections.js';
const snapshot=JSON.parse(await readFile('.cache/native3d-inline-results/project-before.json','utf8'));
const graph=compactNative3DGraph(snapshot.canvas.nodes,snapshot.canvas.edges);
const plan=graph.nodes.find(n=>n.data.nativeUVPlan?.jobId==='n3d_25cf0fdef1134c339e8bb9743b6a5803');
const projected=nativeOutputNode(plan);assert.equal(projected.id,plan.id);assert.equal(projected.nativeLogicalId,'native3d-result-'+plan.data.nativeJobId);
assert.equal(projected.data.nativeUVPlanConfirmation,snapshot.canvas.nodes.find(n=>n.id===projected.nativeLogicalId).data.nativeUVPlanConfirmation);
assertPlanCurrent(projected.data.nativeUVPlan,graph.nodes,graph.edges,nativeRunIdentity);
const uv=graph.nodes.find(n=>n.data.operation==='uv'&&n.data.nativeJobId==='n3d_d7bb685a2013438f898c8ad77d57b694');
const inputs=nativeInputs(uv,graph.nodes,graph.edges);assertConfirmedPlan(inputs.plan,inputs.model,inputs.high);
const before=nativeRunIdentity(uv,inputs.model,inputs),original=structuredClone(plan);
const newer={id:'new-output',type:'native3d',data:{...projected.data,sourceJobId:'n3d_'+'f'.repeat(32),nativeUVPlan:{...projected.data.nativeUVPlan,jobId:'n3d_'+'f'.repeat(32)}}};
plan.data=nativeAppendOutput(plan,newer);plan.data.nativeJobId=newer.data.sourceJobId;plan.data.nativeRun={identity:'new run'};
assert.equal(nativeRunIdentity(uv,nativeInputs(uv,graph.nodes,graph.edges).model,nativeInputs(uv,graph.nodes,graph.edges)),before);
assertPlanCurrent(inputs.plan.data.nativeUVPlan,graph.nodes,graph.edges,nativeRunIdentity);assertConfirmedPlan(nativeInputs(uv,graph.nodes,graph.edges).plan,inputs.model,inputs.high);
assert.equal(nativeOutputCandidates([plan]).length,2);assert.equal(nativeOutputForEdge(plan,{data:{outputRecordId:projected.nativeLogicalId}}).data.sourceJobId,original.data.nativeJobId);
assert.throws(()=>nativeOutputNode(plan,'missing'),/版本/);
const target={id:'new-uv',type:'native3d',data:{operation:'uv',status:'idle'}};
const connection=planCanvasConnection({source:original.id,target:target.id,sourceHandle:'plan',targetHandle:'plan'},[original,target],[]);assert.equal(connection.connection.source,original.id);assert.equal(connection.connection.data.outputRecordId,original.data.nativeCurrentOutputId);
assert.deepEqual(nativeModelIdentity(inputs.model),nativeModelIdentity(nativeOutputForEdge(graph.nodes.find(n=>n.id===inputs.model.id),graph.edges.find(e=>e.target===uv.id&&e.targetHandle==='model'))));
const text=await readFile('src/native3d-runtime.js','utf8');const code=text.slice(text.indexOf('  async function compactResults('),text.indexOf('  async function run('));
function transaction(){const o={projectId:'p',nodesRef:{current:snapshot.canvas.nodes},edgesRef:{current:snapshot.canvas.edges},setNodes(){},setEdges(){},persistProject:async()=>{},readOnly:false};const latest={current:o},current=()=>{if(o.readOnly)throw Error('readonly');return o;};const compact=new Function('latest','current','compactNative3DGraph',code+';return compactResults;')(latest,current,compactNative3DGraph);return {o,compact};}
{const {o,compact}=transaction();const old=o.nodesRef.current;o.readOnly=true;assert.equal((await compact()).dryRun,true);await assert.rejects(compact({dryRun:false}),/readonly/);assert.equal(o.nodesRef.current,old);}
{const {o,compact}=transaction();const old=o.nodesRef.current;let saves=0;o.persistProject=async()=>{if(++saves===2)throw Error('save failed');};await assert.rejects(compact({dryRun:false}),/save failed/);assert.equal(o.nodesRef.current,old);}
{const {o,compact}=transaction();const report=await compact({dryRun:false});assert.equal(report.nodeCountAfter,o.nodesRef.current.length);assert.equal(o.nodesRef.current.some(n=>n.id===projected.nativeLogicalId),false);}
console.log('INLINE_OUTPUT_OK real equivalent identities and confirmation, pinned old plan survives rerun, no hidden nodes, actual edge binding, compact dryrun/write guards/rollback');
import {nativeNextStepPlan} from './src/native3d-next-step.js';
const reply=JSON.parse(await readFile('.cache/native3d-inline-results/plan-job-read.json','utf8')),job=reply.job||reply;
const legacyPlan=snapshot.canvas.nodes.find(n=>n.id==='native3d-result-'+job.id);
const initialNodes=snapshot.canvas.nodes.filter(n=>!(n.data.nativeNextStep?.action==='unwrap'&&n.data.nativeNextStep.sourceJobId===job.id));
const initialEdges=snapshot.canvas.edges.filter(e=>initialNodes.some(n=>n.id===e.source)&&initialNodes.some(n=>n.id===e.target));
const draft=nativeNextStepPlan({source:legacyPlan,nodes:initialNodes,edges:initialEdges,job,projectId:snapshot.id,action:'unwrap',id:'test-idle-unwrap'});
const withDraft=compactNative3DGraph([...initialNodes,draft.node],[...initialEdges,...draft.edges]);
const repeated=nativeNextStepPlan({source:withDraft.nodes.find(n=>n.id===legacyPlan.data.sourceNodeId),nodes:withDraft.nodes,edges:withDraft.edges,job,projectId:snapshot.id,action:'unwrap',id:'must-not-create'});
assert.equal(repeated.reused,true);assert.equal(repeated.node.id,draft.node.id);console.log('INLINE_NEXT_STEP_REUSE_OK real confirmed plan idle unwrap draft reused after compaction');
