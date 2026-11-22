import {compactNative3DGraph} from './native3d-inline-migration.js';
import {nativeOutputNode,nativeAppendOutput,nativePatchOutputData,nativeBindOutputEdges,nativeOutputForEdge,nativeOutputCandidates} from './native3d-output.js';
import {native3DNotifications} from './native3d-notifications.js';
import {reviewedDownstreamWarning} from './native3d-reviewed-warning.js';
import {nativeUVOrientationError} from './native3d-uv-prerequisite.js';
import {localRepairDraft} from './native3d-local-repair.js';
import {lodResolution,resolutionDraft} from './native3d-lod-resolution.js';
import {lodIssueTargets} from './native3d-lod-issues.js';
import {nativeNextStepPlan,nextStepActions,nextStepOrigin} from './native3d-next-step.js';
import {nativeRerunTarget,withNativeRerunLock,nativeAutomaticLODStages,layoutNativeResultDelivery,nextNativeLODSeed,nativeLODStageRetryPlan} from './native3d-rerun.js';
import { findFreePosition } from './canvas-layout.js';
import { useEffect, useRef, useState } from 'react';
import { nativeRequest, nativeRunIdentity, nativeParameters, nativeAdapterSchema, nativeGeometryInputError } from './native3d.js';
import {nativeInputs,planRecord,planConfirmationKey,assertPlanCurrent,assertConfirmedPlan,planUVParameters} from './native3d-plan.js';
import { transferNativeArtifacts, nativeRunIsCurrent, commitNativeDelivery } from './native3d-delivery.js';
import { nativeStagePlan, applyNativeStagePlan, saveNativeStagePoster } from './native3d-stage.js';
import { nativeUVIdentity, nativeUVHasLayout, saveNativeUVPreviews, nativeUVDeliveredPreviews } from './native3d-uv-preview.js';

export const PLAN_PREVIEW_MODES=['regions','convex','details','ao'];
export function supportsPlanPreviews(plan) {
  return plan?.settings?.seamPlanningMode==='ai_structure_ao_v2' && ['convex_structural','concave_structural'].every(reason=>plan.edgeReasons?.includes(reason)) && Boolean(plan.overlay?.arrays?.edgeReason);
}
export function validPlanPreviews(record,plan) {
  return supportsPlanPreviews(plan) && record?.schemaVersion===1 && record?.planSha256===plan?.planSha256 && record?.overlaySha256===plan?.overlay?.sha256 && PLAN_PREVIEW_MODES.every(mode=>/^assets\/[a-f0-9]{64}\.png$/i.test(record?.[mode] || ''));
}
export async function savePlanPreviews(plan,blobs,{assertCurrent,saveFile,apply,persist,rollback}) {
  assertCurrent();if(!supportsPlanPreviews(plan))throw Error('历史方案不支持结构分层预览。');const record={schemaVersion:1,planSha256:plan.planSha256,overlaySha256:plan.overlay.sha256};
  for(const mode of PLAN_PREVIEW_MODES){
    const blob=blobs?.[mode];
    if(!(blob instanceof Blob)||blob.type!=='image/png'||blob.size<8||blob.size>4*1024*1024)throw Error('方案静态预览不是有效PNG。');
    if(new Uint8Array(await blob.slice(0,8).arrayBuffer()).join(',')!=='137,80,78,71,13,10,26,10')throw Error('方案静态预览PNG签名无效。');
    assertCurrent();record[mode]=await saveFile(new File([blob],`plan-${mode}.png`,{type:'image/png'}));assertCurrent();
    if(!/^assets\/[a-f0-9]{64}\.png$/i.test(record[mode] || ''))throw Error('方案静态预览尚未保存。');
  }
  assertCurrent();apply(record);
  try{await persist();assertCurrent();}catch(error){rollback?.(record);throw error;}
  return record;
}
export async function saveUVDiagnosticPreviews(identity,{assertCurrent,saveFile,fetchFile=fetch}) {
  const record={...identity,diagnosticOnly:true,acceptedUV:false,bakeAllowed:false};
  for(const mode of ['layout','checker']){
    assertCurrent();
    const query=new URLSearchParams({projectId:identity.projectId,nodeId:identity.nodeId});
    const response=await fetchFile(`/api/native3d/jobs/${encodeURIComponent(identity.jobId)}/diagnostic-preview/${mode}?${query}`);
    assertCurrent();if(mode==='checker'&&response.status===404)continue;
    if(!response.ok)throw Error(`待审UV诊断读取失败（HTTP ${response.status}）。`);
    const blob=await response.blob();assertCurrent();
    if(blob.type!=='image/png'||blob.size<67||blob.size>8*1024*1024||new Uint8Array(await blob.slice(0,8).arrayBuffer()).join(',')!=='137,80,78,71,13,10,26,10')throw Error('待审UV诊断PNG无效。');
    assertCurrent();record[mode]=await saveFile(new File([blob],`uv-diagnostic-${mode}.png`,{type:'image/png'}));assertCurrent();
    if(!/^assets\/[a-f0-9]{64}\.png$/i.test(record[mode]||''))throw Error('待审UV诊断未保存。');
  }
  return record;
}

export function nativeSourceImportError(file, capabilities) {
  if (!/\.(glb|obj|fbx)$/i.test(file.name)) return '仅支持静态GLB、OBJ和受限FBX模型。';
  if (file.size > (capabilities?.maxSourceBytes || 512 * 1024 * 1024)) return '模型不能超过512 MiB。';
  if (/\.fbx$/i.test(file.name) && !capabilities?.sourceFormats?.includes('.fbx')) return '本机FBX转换器未就绪，暂不能导入FBX。';
  return null;
}

export function useNative3D(options) {
  const [notificationSoundEnabled,setNotificationSoundState]=useState(native3DNotifications.enabled);
  const setNotificationSoundEnabled=value=>setNotificationSoundState(native3DNotifications.setEnabled(value));
  const rerunLocks=useRef(new Set());
  const localRepairPromises=useRef(new Map());
  const latest = useRef(options); latest.current = options;
  const [capabilities, setCapabilities] = useState(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [viewer, setViewer] = useState(null);
  const delivering = useRef(new Set());
  const pollNow=useRef(null);
  const imports = useRef(new Map());
  const viewedPlans=useRef(new Map());
  const previewSaves=useRef(new Map());
  useEffect(()=>{viewedPlans.current.clear();setViewer(null);},[options.projectId]);
  useEffect(() => {
    let active = true;
    nativeRequest('/capabilities').then(value => { if (active) setCapabilities(value.capabilities || value); })
      .catch(error => { if (active) setCapabilityError(error.message); });
    return () => { active = false; };
  }, []);
  const current = () => {
    const o = latest.current;
    if (o.readOnly || o.switchingRef.current) throw new Error('当前画布不可编辑。');
    return o;
  };
  const patch = (id, data) => {const o=current(),node=o.nodesRef.current.find(n=>n.id===id);o.updateNode(id,node?.data.nativeCurrentOutputId?nativePatchOutputData(node.data,data):data);};
  const sourceFor = (o, node) => node?.data.operation === 'analyze'
    ? (node.data.nativePendingSource ? { ...node, data: { ...node.data, assetPath: node.data.nativePendingSource.path, originalAssetPath: node.data.nativePendingSource.path } } : node)
    : nativeInputs(node,o.nodesRef.current,o.edgesRef.current).model;
  const inputsFor=(o,node)=>nativeInputs(node,o.nodesRef.current,o.edgesRef.current);
  const identityFor=(node,source)=>{
    const inputs=inputsFor(latest.current,node);
    return nativeRunIdentity(node,source,(['uv_plan','source_lod'].includes(node?.data.operation) || inputs.high || inputs.plan || node?.data.nativeRun?.inputsVersion===2) ? inputs : undefined);
  };
  const assertLivePlan=(plan,o)=>{
    assertPlanCurrent(plan,o.nodesRef.current,o.edgesRef.current,nativeRunIdentity);
    const producer=o.nodesRef.current.find(n=>n.id===plan.producerNodeId);
    const adapter=(capabilities?.adapters || []).find(a=>(a.id || a.adapterId)===producer.data.adapterId) || capabilities?.operations?.uv_plan;
    if(!adapter)throw Error('切缝方案执行器尚未就绪。');
    const historical=producer.data.nativeOutputRecords?.find(r=>r.jobId===plan.jobId);
    const effective=nativeParameters(adapter,producer.data.nativeJobId!==plan.jobId?historical?.producerParameters || {}:producer.data.nativeParameters || {});
    for(const [key,value] of Object.entries(plan.settings || {}))if(Object.hasOwn(effective,key)&&effective[key]!==value)throw Error('切缝设置或默认值已改变，请重新预览。');
    return plan;
  };
  useEffect(()=>{
    const o=latest.current;if(o.readOnly||o.switchingRef.current||!capabilities)return;
    for(const node of o.nodesRef.current)if(node.data?.nativeUVPlan&&(node.data.nativeUVPlanConfirmation||node.data.nativeUVPlanViewed||node.data.nativeUVPlanPreviews)){
      try{assertLivePlan(node.data.nativeUVPlan,o);}catch{viewedPlans.current.delete(node.id);o.updateNode(node.id,{nativeUVPlanConfirmation:null,nativeUVPlanViewed:null,nativeUVPlanPreviews:null});}
    }
  },[options.nodesRef.current,options.edgesRef.current,capabilities]);
  const assertRun = (projectId, id, snapshot) => {
    const o = current();
    const node = o.nodesRef.current.find(n => n.id === id);
    if (o.projectId !== projectId || !nativeRunIsCurrent(node, sourceFor(o, node), snapshot, identityFor)) throw new Error('3D运行或来源已改变，旧响应未交付。');
    return { o, node };
  };
  async function compactResults({dryRun=true,cleanupFailed=false,cleanupIds=[]}={}) {
    let o=latest.current;
    const options={cleanupFailed,cleanupIds};
    if(o.nodesRef.current.some(n=>n.type==='native3d'&&(['queued','running','finishing','uploading'].includes(n.data.status)||n.data.nativeSubmissionUncertain)))throw Error('有3D任务正在处理，暂不能整理结果。');
    if(dryRun)return {...compactNative3DGraph(o.nodesRef.current,o.edgesRef.current,options).summary,dryRun:true};
    o=current();const projectId=o.projectId;
    await o.persistProject();o=current();if(o.projectId!==projectId)throw Error('项目已改变，未整理。');
    const beforeNodes=o.nodesRef.current,beforeEdges=o.edgesRef.current;
    const plan=compactNative3DGraph(beforeNodes,beforeEdges,options);
    o.recordHistory?.(beforeNodes,beforeEdges);
    o.nodesRef.current=plan.nodes;o.edgesRef.current=plan.edges;o.setNodes(plan.nodes);o.setEdges(plan.edges);
    try{await o.persistProject();if(current().projectId!==projectId)throw Error('项目已改变。');}
    catch(error){if(latest.current.projectId===projectId&&o.nodesRef.current===plan.nodes&&o.edgesRef.current===plan.edges){o.nodesRef.current=beforeNodes;o.edgesRef.current=beforeEdges;o.setNodes(beforeNodes);o.setEdges(beforeEdges);}throw error;}
    return {...plan.summary,dryRun:false};
  }
  async function run(id) {
    const o = current();
    let node = o.nodesRef.current.find(n => n.id === id);
    if (!node) throw new Error('3D节点已不存在。');
    if (node.data.nativeJobId && node.data.nativeDeliveryErrorJobId === node.data.nativeJobId) return retryDelivery(id);
    if(node.data.nativeSubmissionUncertain)throw Error('提交结果待核实，请先同步任务状态；不会更换种子或重复提交。');
    if(node.data.nativeLocalRepair&&(node.data.nativeRun||node.data.nativeJobId))throw Error('此候选已有局部修复尝试，请查看已有进度或结果。');

    if (['queued', 'running', 'finishing'].includes(node.data.status)) throw new Error('任务已在运行。');
    if(node.data.operation==='source_lod'&&node.data.nativeParameters?.retryStage&&node.data.nativeRun) {
      const parameters=node.data.nativeParameters;
      const seed=nextNativeLODSeed(o.nodesRef.current,parameters.retryJobId,parameters.retryStage);
      patch(id,{nativeParameters:{...parameters,seed},nativeLODStageRetry:{...node.data.nativeLODStageRetry,seed}});
      node=o.nodesRef.current.find(n=>n.id===id);
    }
    const source = sourceFor(o, node);
    const inputs=inputsFor(o,node);
    // Prerequisite failures must preserve the prior failed task and its provenance.
    const orientationError=node.data.operation==='uv_plan' ? nativeUVOrientationError(node,inputs) : null;
    if(orientationError)throw Error(orientationError);
    const identity = identityFor(node, source);
    let trackedOpId = node.data.nativeRun?.opId;
    let submittedJobId = null;
    let submissionStarted = false;
    const ownsDraft = () => {
      const live = latest.current.nodesRef.current.find(n => n.id === id);
      return latest.current.projectId === o.projectId && !latest.current.readOnly && !latest.current.switchingRef.current
        && live && live.data.nativeRun?.opId === trackedOpId && identityFor(live, sourceFor(latest.current, live)) === identity;
    };
    try {
      if (!source?.data.assetPath) throw new Error('请先导入并连接已保存的3D模型。');
      if (!capabilities) throw new Error(capabilityError || '3D能力查询尚未完成。');
      const adapter = (capabilities.adapters || []).find(a => (a.id || a.adapterId) === node.data.adapterId)
        || (capabilities.adapters || []).find(a => a.operation === node.data.operation || a.operations?.includes(node.data.operation))
        || (node.data.operation !== 'ai_lowpoly' && capabilities.operations?.[node.data.operation] ? { ...capabilities.operations[node.data.operation], operation: node.data.operation } : null);
      if (node.data.adapterId && !(capabilities.adapters || []).some(a => (a.id || a.adapterId) === node.data.adapterId)) throw new Error('已选择的执行器当前不可用，请重新选择。');
      if (capabilities.operations?.[node.data.operation]?.ready === false) throw new Error(capabilities.operations[node.data.operation].reason || '此操作尚未就绪。');
      if (node.data.operation !== 'analyze' && (!adapter || adapter.ready === false)) throw new Error(adapter?.reason || '当前操作没有就绪的执行器。');
      let parameters = node.data.operation === 'analyze' ? {} : nativeParameters(adapter, node.data.nativeParameters);
      if(node.data.operation==='source_lod'&&!parameters.localRepairJobId)for(const key of ['localRepairMaxPatches','localRepairDisplacementFraction','localRepairCorrectionFraction'])delete parameters[key];
      if (['uv_plan','bake'].includes(node.data.operation) && !inputs.high?.data.assetPath) throw Error('请连接高模参考输入。');
      if (node.data.operation==='uv') {
        const plan=assertConfirmedPlan(inputs.plan,source,inputs.high);
        assertLivePlan(plan,o);
        parameters={...parameters,...planUVParameters(plan,node.data.nativeParameters || {},nativeAdapterSchema(adapter))};
      }
      if(node.data.operation==='bake'&&parameters.reviewedBoundaryJobId){const highHash=inputs.high?.data.assetPath?.match(/^assets\/([a-f0-9]{64})\.[a-z0-9]+$/)?.[1];if(!highHash)throw Error('已审阅候选烘焙需要明确连接且已保存的材质高模。');parameters={...parameters,reviewedBoundaryBakeHighSha256:highHash};}
      const geometryError=nativeGeometryInputError(source,node.data.operation,parameters);if(geometryError)throw Error(geometryError);
      const opId = crypto.randomUUID(); trackedOpId = opId;
      const snapshot = { opId, identity };
      patch(id, { status: 'queued', progress:null, error: null, stage: '提交3D任务', nativeJobId: null, nativeDeliveryErrorJobId: null,nativeSubmissionUncertain:false,nativeBackendStatus:null,
        ...((node.data.operation==='source_lod'&&parameters.retryStage)?{nativeLODLastSubmittedSeed:parameters.seed}:{}),
        nativeRun: { ...snapshot, parameters, ...((['uv_plan','source_lod'].includes(node.data.operation) || inputs.high || inputs.plan) ? {inputsVersion:2}:{}),adapterId: adapter?.id || adapter?.adapterId, sourceId: source.id, sourceAssetPath: source.data.assetPath,highAssetPath:inputs.high?.data.assetPath, originalAssetPath: inputs.high?.data.assetPath || source.data.originalAssetPath || source.data.assetPath } });
      await o.persistProject();
      assertRun(o.projectId, id, snapshot);
      submissionStarted = true;
      const value = await nativeRequest('/jobs', { opId, projectId: o.projectId, nodeId: id, operation: node.data.operation,
        source: { assetPath: source.data.assetPath, ...(['bake','repair_lod','uv','uv_plan','source_lod'].includes(node.data.operation) ? { highAssetPath: inputs.high?.data.assetPath || source.data.originalAssetPath || source.data.assetPath } : {}) },
        parameters, ...(adapter?.id || adapter?.adapterId ? { adapterId: adapter.id || adapter.adapterId } : {}) });
      assertRun(o.projectId, id, snapshot);
      submittedJobId = (value.job || value).id;
      if(typeof native3DNotifications!=='undefined')native3DNotifications.arm(submittedJobId);
      patch(id, { nativeJobId: submittedJobId });
      await o.persistProject();
      assertRun(o.projectId, id, snapshot);
    } catch (error) {
      if (ownsDraft()) patch(id, { nativeSubmissionUncertain:submissionStarted&&!submittedJobId,...((!submissionStarted)?{nativeRun:null,nativeLocalRepairSaveFailed:Boolean(node.data.nativeLocalRepair),nativeRetrySaveFailed:Boolean(node.data.nativeRetryFailureJobId)}:{}), status: submittedJobId ? 'queued' : 'error', error: submittedJobId ? `任务已提交，状态保存失败：${error.message}` : error.message });
      throw error;
    }
  }
  async function importModel(id, file) {
    const o = current();
    const token = crypto.randomUUID(); imports.current.set(id, token);
    let submissionStarted = false;
    const initialOpId = o.nodesRef.current.find(n => n.id === id)?.data.nativeRun?.opId;
    const ownsImport = () => latest.current.projectId === o.projectId && imports.current.get(id) === token && latest.current.nodesRef.current.some(n => n.id === id && (submissionStarted || n.data.nativeRun?.opId === initialOpId || n.data.nativeRun === null));
    try {
      const importError = nativeSourceImportError(file, capabilities);
      if (importError) throw new Error(importError);
      const upload = /\.fbx$/i.test(file.name) ? new File([file], file.name, { type: 'application/octet-stream' }) : file;
      const path = await o.saveNativeFile(upload);
      if (!ownsImport()) throw new Error('导入目标已改变，旧素材未绑定。');
      patch(id, { nativePendingSource: { path, name: file.name }, nativeJobId: null, nativeRun: null, status: 'idle', error: null });
      await o.persistProject();
      if (!ownsImport()) throw new Error('导入目标已改变，旧素材未绑定。');
      submissionStarted = true;
      await run(id);
    } catch (error) {
      if (!submissionStarted && ownsImport() && !latest.current.readOnly && !latest.current.switchingRef.current) patch(id, { error: error.message });
      throw error;
    } finally { if (imports.current.get(id) === token) imports.current.delete(id); }
  }
  async function syncTask(id,retrySave=true) {
    const o=current(),bound=o.nodesRef.current.find(n=>n.id===id);
    const node=bound?.data.operation==='analyze'&&bound.data.sourceNodeId?o.nodesRef.current.find(n=>n.id===bound.data.sourceNodeId):bound;
    if(!node?.data.nativeRun?.opId)throw Error('缺少任务提交凭据，未猜测或重新提交。');
    const before={...node.data.nativeRun,jobId:node.data.nativeJobId},projectId=o.projectId;
    const assertCurrent=()=>assertRun(projectId,node.id,before);
    let job;
    if(before.jobId){const response=await nativeRequest(`/jobs/${encodeURIComponent(before.jobId)}`);job=response.job||response;}
    else{const response=await nativeRequest(`/jobs?projectId=${encodeURIComponent(projectId)}`);const matches=(response.jobs||[]).filter(j=>j.nodeId===node.id&&j.opId===before.opId);if(matches.length!==1)throw Error('尚未找到唯一已提交任务，未重复计算。');job=matches[0];}
    assertCurrent();
    if(job.projectId!==projectId||job.nodeId!==node.id||job.opId!==before.opId||job.operation!==node.data.operation||job.source?.assetPath!==before.sourceAssetPath)throw Error('后台任务来源与当前提交不一致。');
    const terminal=['succeeded','completed','success'].includes(job.status),failed=['failed','error','cancelled'].includes(job.status);
    patch(node.id,{nativeJobId:job.id,nativeSubmissionUncertain:false,nativeBackendStatus:job.status,status:terminal?'finishing':job.status,progress:Number.isFinite(job.progress)?Math.round(job.progress*100):null,stage:terminal?'后台已完成，正在同步结果':job.stage,error:failed?(typeof job.error==='string'?job.error:job.error?.message):null});
    before.jobId=job.id;
    if(retrySave){await o.persistProject(true);assertRun(projectId,node.id,before);patch(node.id,{nativeDeliveryErrorJobId:null});}
    if(terminal&&node.data.nativeDeliveredJobId===job.id){patch(node.id,{status:'completed',progress:100,stage:'结果已保存',error:null});return {jobId:job.id,status:'completed'};}
    if(retrySave&&pollNow.current)await pollNow.current(false);
    return {jobId:job.id,status:job.status};
  }
  async function retryDelivery(id) {
    const o = current(); const node = o.nodesRef.current.find(n => n.id === id);
    if (!node?.data.nativeJobId || node.data.nativeDeliveryErrorJobId !== node.data.nativeJobId) throw new Error('此节点没有待重试的交付。');
    const snapshot = { ...node.data.nativeRun, jobId: node.data.nativeJobId };
    assertRun(o.projectId, id, snapshot);
    // Explicit retry also retries the existing page's failed save barrier.
    await o.persistProject(true);
    assertRun(o.projectId, id, snapshot);
    patch(id, { status: 'finishing', nativeDeliveryErrorJobId: null, error: null, stage: '重试保存交付' });
  }
  async function refreshUVPreview(id) {
    const initial=current(); const node=initial.nodesRef.current.find(n=>n.id===id);
    const identity=nativeUVIdentity(node);
    if (!identity) throw new Error('需要已完成且已保存的真实UV结果。');
    const fingerprint=n=>JSON.stringify([nativeUVIdentity(n),n?.data.nativeRun,n?.data.nativeParameters,sourceFor(latest.current,n)?.data.assetPath]);
    const captured=fingerprint(node);
    const peers=initial.nodesRef.current.filter(n=>JSON.stringify(nativeUVIdentity(n))===JSON.stringify(identity)).map(n=>({id:n.id,fingerprint:fingerprint(n)}));
    const assertCurrent=()=>{
      const o=current(); const live=o.nodesRef.current.find(n=>n.id===id);
      if (o.projectId!==initial.projectId || fingerprint(live)!==captured || peers.some(peer=>fingerprint(o.nodesRef.current.find(n=>n.id===peer.id))!==peer.fingerprint)) throw new Error('UV来源或任务已改变，预览未交付。');
      return o;
    };
    const value=await nativeRequest(`/jobs/${encodeURIComponent(identity.jobId)}`); assertCurrent();
    const job=value.job || value;
    if (job.id!==identity.jobId || job.operation!=='uv' || !['completed','succeeded','success'].includes(job.status)) throw new Error('真实UV任务未完成或不匹配。');
    const previews=await saveNativeUVPreviews(identity,{saveFile:file=>initial.saveNativeFile(file),assertCurrent,includeAO:job.parameters?.seamStrategy==='ao_geometry' || Boolean(job.parameters?.highGuidedEvidence && job.result?.metadata?.uv?.aoGeometry),includeLayout:nativeUVHasLayout(job)});
    const o=assertCurrent();
    const matching=o.nodesRef.current.filter(n=>peers.some(peer=>peer.id===n.id));
    for (const target of matching) patch(target.id,{nativeUVPreviews:previews,nativeUVPreviewMode:target.data.nativeUVPreviewMode || (previews.layoutAssetPath?'layout':'seams')});
    await o.persistProject(); assertCurrent();
    return {nodeIds:matching.map(n=>n.id),nativeUVPreviews:previews};
  }
  async function refreshDiagnosticPreview(id) {
    const initial=current(),node=initial.nodesRef.current.find(n=>n.id===id);
    if(node?.data.operation!=='uv'||!['error','failed'].includes(node.data.status)||!/^n3d_[a-f0-9]{32}$/.test(node.data.nativeJobId||''))throw Error('需要同一节点已失败的UV任务。');
    if(!node.data.nativeRun||!nativeRunIsCurrent(node,sourceFor(initial,node),{...node.data.nativeRun,jobId:node.data.nativeJobId},identityFor))throw Error('输入或设置已改变，不能将旧诊断用于当前节点。');
    const fingerprint=n=>JSON.stringify([n?.data.nativeJobId,n?.data.nativeRun,n?.data.nativeParameters,n?.data.status,identityFor(n,sourceFor(latest.current,n))]);
    const captured=fingerprint(node),jobId=node.data.nativeJobId;
    const assertCurrent=()=>{const o=current(),live=o.nodesRef.current.find(n=>n.id===id);if(o.projectId!==initial.projectId||fingerprint(live)!==captured)throw Error('项目、任务或输入已改变，诊断未交付。');return o;};
    const value=await nativeRequest(`/jobs/${jobId}`);assertCurrent();const job=value.job||value;
    if(job.id!==jobId||job.projectId!==initial.projectId||job.nodeId!==id||job.operation!=='uv'||job.status!=='failed')throw Error('诊断任务与当前项目节点不匹配。');
    if(job.opId!==node.data.nativeRun.opId||job.source?.assetPath!==node.data.nativeRun.sourceAssetPath)throw Error('诊断任务来源与当前运行记录不一致。');
    const previews=await saveUVDiagnosticPreviews({jobId,projectId:initial.projectId,nodeId:id,sourceSha256:job.source?.sha256,inputIdentity:identityFor(node,sourceFor(initial,node))},{assertCurrent,saveFile:file=>initial.saveNativeFile(file)});
    const o=assertCurrent(),previous=o.nodesRef.current.find(n=>n.id===id).data.nativeUVDiagnosticPreviews;
    o.updateNode(id,{nativeUVDiagnosticPreviews:previews,nativeUVDiagnosticMode:previews.checker?'checker':'layout'});
    try{await o.persistProject();assertCurrent();}catch(error){if(latest.current.projectId===initial.projectId&&latest.current.nodesRef.current.find(n=>n.id===id)?.data.nativeUVDiagnosticPreviews===previews)initial.updateNode(id,{nativeUVDiagnosticPreviews:previous||null});throw error;}
    return {nodeId:id,jobId,diagnosticOnly:true,acceptedUV:false,bakeAllowed:false,previews};
  }
  useEffect(() => {
    let stopped = false; let timer;
    async function poll(schedule=true) {
      const o = latest.current;
      if(typeof native3DNotifications!=='undefined'&&!o.readOnly&&!o.switchingRef.current)native3DNotifications.observe(o.nodesRef.current);
      try {
        if(!o.readOnly&&!o.switchingRef.current)for(const pending of o.nodesRef.current.filter(n=>n.type==='native3d'&&n.data.nativeRun?.opId&&!n.data.nativeJobId&&(n.data.nativeSubmissionUncertain||n.data.status==='queued'))){try{await syncTask(pending.id,false);}catch{/* unresolved submission stays bound; never auto-resubmit */}}
        if (!o.readOnly && !o.switchingRef.current) for (const node of o.nodesRef.current.filter(n => n.type === 'native3d' && n.data.nativeJobId && n.data.nativeDeliveredJobId !== n.data.nativeJobId && n.data.nativeDeliveryErrorJobId !== n.data.nativeJobId && n.data.status!=='stale'&&!['failed','error','cancelled'].includes(n.data.nativeBackendStatus))) {
          const before = { ...node.data.nativeRun, jobId: node.data.nativeJobId };
          const value = await nativeRequest(`/jobs/${encodeURIComponent(before.jobId)}`); const job = value.job || value;
          if (stopped || latest.current.projectId !== o.projectId) return;
          const live = o.nodesRef.current.find(n => n.id === node.id);
          if (!live || live.data.nativeJobId !== before.jobId || live.data.nativeRun?.opId !== before.opId || job.id !== before.jobId) continue;
          if (!nativeRunIsCurrent(live,sourceFor(o,live),before,identityFor)) {
            o.updateNode(node.id, { status: 'stale', stage: '旧任务已结束；输入或配置已改变' }); continue;
          }
          const assertCurrent = () => { if (stopped) throw new Error('交付已停止。'); return assertRun(o.projectId, node.id, before); };
          if (['failed', 'error', 'cancelled'].includes(job.status)) {
            if(typeof native3DNotifications!=='undefined')native3DNotifications.discard(job.id);
            assertCurrent(); o.updateNode(node.id, { nativeBackendStatus:job.status,status: job.status, error: typeof job.error === 'string' ? job.error : job.error?.message, stage: job.stage }); continue;
          }
          if (!['completed', 'succeeded', 'success'].includes(job.status)) {
            assertCurrent(); o.updateNode(node.id, { nativeBackendStatus:job.status,error:null,status: job.status, stage: job.stage, progress: Number.isFinite(job.progress)?Math.round(job.progress*100):null }); continue;
          }
          assertCurrent();o.updateNode(node.id,{nativeBackendStatus:job.status,error:null,status:'finishing',stage:'后台已完成，正在保存结果'});
          if (delivering.current.has(job.id)) continue;
          delivering.current.add(job.id);
          try {
            const saved = await transferNativeArtifacts(job.result?.files || [], job.id, { saveFile: file => o.saveNativeFile(file), assertCurrent });
            const { node: now } = assertCurrent();
            if (!['analyze','uv_plan'].includes(now.data.operation) && !saved.model) throw new Error('执行器未返回真实模型结果。');
            const uvPlan=now.data.operation==='uv_plan' ? planRecord(job,saved,now.data.nativeRun,now.id) : null;
            const resultId = `native3d-result-${job.id}`;
            const previousMarker = now.data.nativeDeliveredJobId;
            const inheritedGeometry=sourceFor(o,now)?.data.metadata?.geometry;
            const geometry=job.result?.metadata?.geometry || inheritedGeometry;
            const common = { ...(now.data.operation==='source_lod' ? {nativeLODLevel:geometry?.selectedLodLevel,nativeNaniteCandidate:geometry?.status==='accepted'&&geometry?.selectedLodLevel===0}:{}),...(uvPlan ? {nativeUVPlan:uvPlan,nativeUVPlanConfirmation:null}:{}),nativeArtifacts: Object.values(saved).map(item => ({ name: item.name, role: item.role, assetPath: item.path })), metadata: { ...job.result?.metadata, ...(uvPlan ? {uvPlan} : {}),...(geometry ? {geometry} : {}) }, nativeGeometryProvenance: ['repair_lod','source_lod'].includes(now.data.operation) || Boolean(sourceFor(o,now)?.data.nativeGeometryProvenance), quality: geometry?.status==='blocked'?{...job.result?.quality,status:'blocked'}:job.result?.quality, warnings: job.result?.warnings || [],
              proxyAssetPath: saved.proxy?.path, posterAssetPath: saved.poster?.path, status: 'completed', progress: 100, stage: '结果已保存', error: null, nativeDeliveredJobId: job.id, originalAssetPath: now.data.nativeRun.originalAssetPath };
            if(now.data.operation==='uv'&&saved.model) {
              common.nativeUVPreviews=nativeUVDeliveredPreviews({type:'native3d',data:{...common,operation:'uv',nativeJobId:job.id,resultAssetPath:saved.model.path}});
              common.nativeUVPreviewMode=now.data.nativeUVPreviewMode || null;
            }
            const reviewedDownstream=['uv_plan','uv','bake'].includes(now.data.operation) && Boolean(reviewedDownstreamWarning({...common,operation:now.data.operation}));
            const resultPosition=o.nodesRef.current.find(n=>n.id===resultId)?.position||findFreePosition(o.nodesRef.current,{x:now.position.x+390,y:now.position.y},'native3d');
            const automaticStages=[];
            if(now.data.operation==='source_lod') {
              const stageSource={id:resultId,type:'native3d',position:resultPosition,data:{...common,operation:'analyze',sourceJobId:job.id,sourceNodeId:node.id}};
              let layoutNodes=o.nodesRef.current.map(n=>n.id===node.id?{...n,data:{...n.data,...common}}:n);
              layoutNodes=layoutNodes.filter(n=>n.id!==resultId).concat(stageSource);
              for(const request of nativeAutomaticLODStages(stageSource.data)) {
                assertCurrent();
                const existing=layoutNodes.find(n=>n.data?.sourceJobId===job.id&&n.data?.nativeStage===request.stage);
                const position=existing?.position||findFreePosition(layoutNodes,{x:stageSource.position.x+420,y:stageSource.position.y},'native3d');
                const plan=nativeStagePlan(stageSource,request.stage,layoutNodes,{...request,...position});
                const posterAssetPath=await saveNativeStagePoster(plan,{assertCurrent,saveFile:file=>o.saveNativeFile(file)});
                assertCurrent();plan.node={...plan.node,data:{...plan.node.data,posterAssetPath,error:null,stage:'阶段已保存',nativeDeliveredJobId:job.id}};
                automaticStages.push(plan);
                layoutNodes=applyNativeStagePlan(layoutNodes,[],plan).nodes;
              }
            }
            const beforeDeliveryNodes=o.nodesRef.current,beforeDeliveryEdges=o.edgesRef.current,beforeProcessorData=structuredClone(now.data);
            await commitNativeDelivery({ assertCurrent,
              apply: () => {
                if (now.data.operation === 'analyze') o.updateNode(node.id, { ...common, ...(now.data.nativePendingSource ? { assetPath: now.data.nativePendingSource.path, name: now.data.nativePendingSource.name, kind: 'model', nativePendingSource: null } : {}) });
                else {
                  let resultNode = { id: resultId, type: 'native3d', position: resultPosition, data: { ...common,...(!reviewedDownstream&&geometry?.returnedDiagnosticStage?{nativeStage:geometry.returnedDiagnosticStage,nativeStageDiagnostic:true,eligibleForDownstream:false}:{}), title: `${now.data.title} · ${geometry?.status==='blocked'&&!reviewedDownstream?'未通过诊断':uvPlan ? '待确认方案':now.data.operation==='source_lod'&&Number.isInteger(geometry?.selectedLodLevel)?`LOD${geometry.selectedLodLevel}结果`:'结果'}`, operation: 'analyze', ...(saved.model ? {assetPath:saved.model.path,resultAssetPath:saved.model.path,name:saved.model.name}:{}),sourceJobId: job.id, sourceNodeId: node.id } };
                  const inlineData=nativeAppendOutput(now,resultNode);
                  o.updateNode(node.id,{...common,nativeOutputRecords:inlineData.nativeOutputRecords,nativeCurrentOutputId:inlineData.nativeCurrentOutputId,...(saved.model?{resultAssetPath:saved.model.path}:{})});
                  // Existing outgoing links must remain bound to their old immutable output.
                  const boundEdges=nativeBindOutputEdges(o.edgesRef.current,o.nodesRef.current.map(n=>n.id===now.id?now:n));
                  o.edgesRef.current=boundEdges;o.setEdges(boundEdges);
                  for(const plan of automaticStages) {
                    if(plan.node.data.assetPath===saved.model?.path)continue;
                    const staged=applyNativeStagePlan(o.nodesRef.current,o.edgesRef.current,plan);
                    o.nodesRef.current=staged.nodes;o.edgesRef.current=staged.edges;
                    o.setNodes(staged.nodes);o.setEdges(staged.edges);
                  }
                }
              },
              persist: () => o.persistProject(),
              rollback: error => {
                const created=new Set(automaticStages.filter(p=>!beforeDeliveryNodes.some(n=>n.id===p.node.id)).map(p=>p.node.id));
                o.nodesRef.current=o.nodesRef.current.filter(n=>!created.has(n.id));o.edgesRef.current=o.edgesRef.current.filter(e=>!created.has(e.source)&&!created.has(e.target));o.setNodes(o.nodesRef.current);o.setEdges(o.edgesRef.current);
                o.updateNode(node.id, { ...beforeProcessorData,nativeOutputRecords:beforeProcessorData.nativeOutputRecords||[],nativeCurrentOutputId:beforeProcessorData.nativeCurrentOutputId||null, nativeDeliveredJobId: previousMarker, status: 'error', nativeDeliveryErrorJobId: job.id, stage: '交付未保存', error: `未交付：${error.message}` });
                if (o.nodesRef.current.some(n => n.id === resultId)) o.updateNode(resultId, { nativeDeliveredJobId: null, status: 'error', stage: '交付未保存', error: `未交付：${error.message}` });
                for(const plan of automaticStages)if(o.nodesRef.current.some(n=>n.id===plan.node.id))o.updateNode(plan.node.id,{nativeDeliveredJobId:null,status:'error',stage:'交付未保存',error:`未交付：${error.message}`});
              },
            });
            // Only the producer delivery path, after persistence and current-run validation.
            if(typeof native3DNotifications!=='undefined') {
              const diagnosticOnly=['source_lod','repair_lod','ai_lowpoly'].includes(now.data.operation)&&geometry?.status!=='accepted';
              native3DNotifications.delivered(job.id,diagnosticOnly?'diagnostic':'succeeded');
            }
          } catch (error) {
            try { assertCurrent(); o.updateNode(node.id, { status: 'error', nativeDeliveryErrorJobId: job.id, error: `未交付：${error.message}` }); } catch { /* superseded run */ }
          } finally { delivering.current.delete(job.id); }
        }
      } catch (error) { if (!stopped) setCapabilityError(error.message); }
      if (!stopped&&schedule) timer = setTimeout(poll, 1800);
    }
    pollNow.current=poll;poll(); return () => { stopped = true; pollNow.current=null;clearTimeout(timer); };
  }, [options.projectId]);
  function rerunStatus(id) {
    try {
      const o=latest.current;
      if(o.readOnly||o.switchingRef.current)throw new Error('当前画布不可编辑。');
      const target=nativeRerunTarget(o.nodesRef.current.find(n=>n.id===id),o.nodesRef.current);
      const processor=o.nodesRef.current.find(n=>n.id===target.processorId);
      if(target.operation==='source_lod') {
        if(rerunLocks.current.has(`${target.retryJobId}:${target.retryStage}`))throw new Error('已提交该档重试，请勿重复点击。');
        if(!nativeAdapterSchema(capabilities?.operations?.source_lod).properties?.retryStage)throw new Error('单档重试接口尚未就绪，请刷新后重试。');
        if(capabilities.operations.source_lod.ready===false)throw new Error(capabilities.operations.source_lod.reason||'LOD执行器未就绪。');
        return {ready:true,...target};
      }
      if(rerunLocks.current.has(target.processorId))throw new Error('已提交重试，请勿重复点击。');
      const source=sourceFor(o,processor),inputs=inputsFor(o,processor);
      if(!source?.data.assetPath)throw new Error('原处理节点缺少已保存的输入模型。');
      const geometryError=nativeGeometryInputError(source,target.operation,processor.data.nativeParameters);
      if(geometryError)throw new Error(geometryError);
      if(!capabilities)throw new Error(capabilityError||'3D能力查询尚未完成。');
      if(capabilities.operations?.[target.operation]?.ready===false)throw new Error(capabilities.operations[target.operation].reason||'执行器尚未就绪。');
      if(target.operation==='uv') {
        const plan=assertConfirmedPlan(inputs.plan,source,inputs.high);assertLivePlan(plan,o);
        planUVParameters(plan,processor.data.nativeParameters||{},nativeAdapterSchema(capabilities.operations?.uv));
      }
      return {ready:true,...target};
    }catch(error){return {ready:false,message:error.message};}
  }
  async function repairLOD(id,settings={}) {
    const initial=current(),projectId=initial.projectId,bound=initial.nodesRef.current.find(n=>n.id===id);
    const origin=nextStepOrigin(bound),jobId=bound?.data.sourceJobId||bound?.data.nativeJobId;
    if(!jobId)throw Error('缺少当前候选任务。');
    const repairKey=`${projectId}:${jobId}:${JSON.stringify(settings)}`;
    if(localRepairPromises.current.has(repairKey))return localRepairPromises.current.get(repairKey);
    const promise=withNativeRerunLock(rerunLocks.current,`local-repair:${jobId}`,async()=>{
      const assertOrigin=()=>{const o=current();if(o.projectId!==projectId||nextStepOrigin(o.nodesRef.current.find(n=>n.id===id))!==origin)throw Error('来源或项目已改变，修复未继续。');return o;};
      const response=await nativeRequest(`/jobs/${encodeURIComponent(jobId)}`);let job=response.job||response;
      let o=assertOrigin();
      let draftBoundId=id,draftOrigin=origin,draftOutputRecordId;
      if(job.parameters?.localRepairJobId){const sourceJobId=job.parameters.localRepairJobId,original=nativeOutputCandidates(o.nodesRef.current).find(n=>n.data?.nativeJobId===sourceJobId||n.data?.sourceJobId===sourceJobId);if(!original)throw Error('原候选节点已不存在，请恢复原节点。');draftBoundId=original.id;draftOutputRecordId=original.nativeOutputRecordId;draftOrigin=nextStepOrigin(original);const prior=await nativeRequest(`/jobs/${encodeURIComponent(sourceJobId)}`);o=assertOrigin();job=prior.job||prior;if(job.id!==sourceJobId)throw Error('原候选任务不匹配。');}
      const draftSource=o=>{const n=nativeOutputNode(o.nodesRef.current.find(n=>n.id===draftBoundId),draftOutputRecordId);if(nextStepOrigin(n)!==draftOrigin)throw Error('原候选来源已改变。');return nativeOutputNode(n);};
      const args={job,projectId,settings};
      const plan=localRepairDraft({...args,bound:draftSource(o),nodes:o.nodesRef.current,edges:o.edgesRef.current,id:`native3d-local-repair-${crypto.randomUUID()}`});
      if(!plan.reused){o.recordHistory?.(o.nodesRef.current,o.edgesRef.current);o.nodesRef.current=o.nodesRef.current.concat(plan.node);o.edgesRef.current=o.edgesRef.current.concat(plan.edges);o.setNodes(o.nodesRef.current);o.setEdges(o.edgesRef.current);}
      o.focusNode?.(plan.node.id);
      if(plan.node.data.nativeRun||plan.node.data.nativeJobId)return {nodeId:plan.node.id,reused:true,status:plan.node.data.status,jobId:plan.node.data.nativeJobId};
      const retrySave=Boolean(plan.node.data.nativeLocalRepairSaveFailed);
      try{await o.persistProject(retrySave);}catch(error){o=assertOrigin();o.updateNode(plan.node.id,{nativeLocalRepairSaveFailed:true});throw error;}
      o=assertOrigin();localRepairDraft({...args,bound:draftSource(o),nodes:o.nodesRef.current,edges:o.edgesRef.current,id:plan.node.id});
      await run(plan.node.id);
      return {nodeId:plan.node.id,reused:plan.reused,generated:true};
    });
    localRepairPromises.current.set(repairKey,promise);
    try{return await promise;}finally{localRepairPromises.current.delete(repairKey);}
  }
  async function createResolution(id,percent) {
    const initial=current(),initialProjectId=initial.projectId;
    const bound=initial.nodesRef.current.find(n=>n.id===id);
    const candidates=bound?.data.nativeCurrentOutputId?[nativeOutputNode(bound)]:bound?.data.operation==='source_lod'?initial.nodesRef.current.filter(n=>n.data?.sourceNodeId===id&&n.data?.sourceJobId===bound.data.nativeJobId&&n.data?.operation==='analyze'):[bound];
    const processorOnly=candidates.length===0&&bound?.data.operation==='source_lod'&&bound.data.nativeJobId;
    if(!processorOnly&&(candidates.length!==1||!candidates[0]?.data.sourceJobId))throw Error('当前处理节点缺少唯一诊断结果。');
    const anchor=processorOnly?bound:candidates[0],resultId=anchor.id,origin=nextStepOrigin(anchor),jobId=processorOnly?bound.data.nativeJobId:anchor.data.sourceJobId;
    return withNativeRerunLock(rerunLocks.current,`resolution:${jobId}`,async()=>{
      const assertOrigin=()=>{const o=current(),node=o.nodesRef.current.find(n=>n.id===resultId),liveBound=o.nodesRef.current.find(n=>n.id===id);
        if(o.projectId!==initialProjectId||nextStepOrigin(node)!==origin||(id!==resultId&&liveBound?.data.nativeJobId!==jobId))throw Error('来源或项目已改变，调整草稿未继续。');return o;};
      const response=await nativeRequest(`/jobs/${encodeURIComponent(jobId)}`);assertOrigin();const failureJob=response.job||response;
      const resolutionResult=o=>{if(!processorOnly)return o.nodesRef.current.find(n=>n.id===resultId);const stage=failureJob.result?.metadata?.geometry?.returnedDiagnosticStage||failureJob.parameters?.retryStage,files=(failureJob.result?.files||[]).filter(f=>f.name===`blocked_${stage}.glb`&&f.role==='export');if(files.length!==1||!/^[a-f0-9]{64}$/.test(files[0].sha256))throw Error('缺少确切诊断候选文件。');const live=o.nodesRef.current.find(n=>n.id===resultId);return {...live,data:{operation:'analyze',status:'completed',sourceJobId:failureJob.id,sourceNodeId:failureJob.nodeId,assetPath:`assets/${files[0].sha256}.glb`,metadata:failureJob.result.metadata}};};
      if(failureJob.parameters?.localRepairJobId){const o=assertOrigin(),original=o.nodesRef.current.find(n=>n.data?.sourceJobId===failureJob.parameters.localRepairJobId||n.data?.nativeJobId===failureJob.parameters.localRepairJobId);if(original)o.focusNode?.(original.id);throw Error('已定位原候选，请在原候选调整保留比例；不会对修复结果重复减面。');}
      const parentId=failureJob.parameters?.retryJobId;if(!/^n3d_[a-f0-9]{32}$/.test(parentId||''))throw Error('缺少确切父任务。');
      const parentResponse=await nativeRequest(`/jobs/${encodeURIComponent(parentId)}`);let o=assertOrigin();const parentJob=parentResponse.job||parentResponse;
      const stage=failureJob.parameters.retryStage;
      let seed;for(let tries=0;tries<16;tries++){seed=nextNativeLODSeed(o.nodesRef.current,parentId,stage);if(seed!==failureJob.parameters?.seed&&seed!==parentJob.parameters?.seed)break;}
      const args={failureJob,parentJob,projectId:initialProjectId,percent,seed};
      const plan=resolutionDraft({...args,result:resolutionResult(o),nodes:o.nodesRef.current,edges:o.edgesRef.current,id:`native3d-resolution-${crypto.randomUUID()}`});
      if(!plan.reused){o.recordHistory?.(o.nodesRef.current,o.edgesRef.current);o.nodesRef.current=o.nodesRef.current.concat(plan.node);o.edgesRef.current=o.edgesRef.current.concat(plan.edges);o.setNodes(o.nodesRef.current);o.setEdges(o.edgesRef.current);}
      o.focusNode?.(plan.node.id);const retrySave=Boolean(plan.node.data.nativeResolutionSaveFailed);if(retrySave)o.updateNode(plan.node.id,{nativeResolutionSaveFailed:false});
      let persisted=false;
      try{await o.persistProject(retrySave);persisted=true;o=assertOrigin();resolutionDraft({...args,result:resolutionResult(o),nodes:o.nodesRef.current,edges:o.edgesRef.current,id:plan.node.id});return {nodeId:plan.node.id,reused:plan.reused,generated:false,keepPercent:percent};}
      catch(error){if(!persisted&&latest.current.projectId===initialProjectId&&!latest.current.readOnly&&!latest.current.switchingRef.current&&latest.current.nodesRef.current.some(n=>n.id===plan.node.id))latest.current.updateNode(plan.node.id,{nativeResolutionSaveFailed:true});throw error;}
    });
  }
  function nextSource(id) {const o=latest.current,node=o.nodesRef.current.find(n=>n.id===id);if(node?.data.nativeCurrentOutputId)return nativeOutputNode(node);if(node?.data.operation==='analyze')return node;const matches=o.nodesRef.current.filter(n=>n.data?.operation==='analyze'&&n.data.sourceNodeId===id&&n.data.sourceJobId===node?.data.nativeJobId);return matches.length===1?matches[0]:null;}
  async function nextStep(id,action) {
    const resolved=nextSource(id);if(!resolved)throw Error('缺少唯一已交付结果，请先同步任务状态。');id=resolved.id;
    const initial=current(),originNode=initial.nodesRef.current.find(n=>n.id===id),origin=nextStepOrigin(originNode);
    const jobId=nativeOutputNode(originNode)?.data.sourceJobId,initialProjectId=initial.projectId;
    if(!nextStepActions(originNode).some(item=>item.action===action))throw Error('当前节点没有此下一步。');
    return withNativeRerunLock(rerunLocks.current,`next:${id}:${action}`,async()=>{
      const assertOrigin=()=>{
        const o=current(),node=o.nodesRef.current.find(n=>n.id===id);
        if(o.projectId!==initialProjectId||nextStepOrigin(node)!==origin)throw Error('来源或项目已改变，下一步未继续。');
        if(action==='unwrap')assertLivePlan(node.data.nativeUVPlan,o);
        return o;
      };
      const response=await nativeRequest(`/jobs/${encodeURIComponent(jobId)}`);let o=assertOrigin();const job=response.job||response;
      const source=o.nodesRef.current.find(n=>n.id===id);
      const level=source.data.nativeLODLevel??source.data.metadata?.geometry?.selectedLodLevel;
      let seed;
      if(action==='next_lod'){for(let tries=0;tries<16;tries++){seed=nextNativeLODSeed(o.nodesRef.current,jobId,`lod${level+1}`);if(seed!==job.parameters?.seed)break;}}
      const plan=nativeNextStepPlan({source,nodes:o.nodesRef.current,edges:o.edgesRef.current,job,projectId:o.projectId,action,seed,id:`native3d-next-${crypto.randomUUID()}`});
      if(!plan.reused){
        o.recordHistory?.(o.nodesRef.current,o.edgesRef.current);
        o.nodesRef.current=o.nodesRef.current.concat(plan.node);o.edgesRef.current=o.edgesRef.current.concat(plan.edges);
        o.setNodes(o.nodesRef.current);o.setEdges(o.edgesRef.current);
      }
      o.focusNode?.(plan.node.id);
      const retrySave=Boolean(plan.node.data.nativeNextStepSaveFailed);
      if(retrySave)o.updateNode(plan.node.id,{nativeNextStepSaveFailed:false});
      let persisted=false;
      try {
        await o.persistProject(retrySave);persisted=true;o=assertOrigin();
        nativeNextStepPlan({source:o.nodesRef.current.find(n=>n.id===id),nodes:o.nodesRef.current,edges:o.edgesRef.current,job,projectId:o.projectId,action,seed,id:plan.node.id});
        return {nodeId:plan.node.id,operation:plan.node.data.operation,reused:plan.reused,generated:false,notice:plan.notice};
      } catch(error) {
        if(!persisted&&latest.current.projectId===initialProjectId&&!latest.current.readOnly&&!latest.current.switchingRef.current&&latest.current.nodesRef.current.some(n=>n.id===plan.node.id))latest.current.updateNode(plan.node.id,{nativeNextStepSaveFailed:true});
        throw error;
      }
    });
  }
  async function retryLOD(id) {
    const initial=current(),projectId=initial.projectId,bound=initial.nodesRef.current.find(n=>n.id===id),origin=nextStepOrigin(bound);
    const jobId=bound?.data.sourceJobId||bound?.data.nativeJobId;
    if(!jobId)throw Error('缺少本档失败任务。');
    const check=()=>{const o=current();if(o.projectId!==projectId||nextStepOrigin(o.nodesRef.current.find(n=>n.id===id))!==origin)throw Error('项目或失败来源已改变。');return o;};
    const response=await nativeRequest(`/jobs/${encodeURIComponent(jobId)}`);check();let failure=response.job||response;
    if(failure.id!==jobId||failure.projectId!==projectId||failure.operation!=='source_lod'||failure.status!=='succeeded'||failure.result?.metadata?.geometry?.status!=='blocked')throw Error('本档任务尚未完成诊断，请先同步任务状态。');
    if(failure.parameters?.localRepairJobId){const original=await nativeRequest(`/jobs/${encodeURIComponent(failure.parameters.localRepairJobId)}`);check();const prior=original.job||original;if(prior.id!==failure.parameters.localRepairJobId||prior.projectId!==projectId||prior.operation!=='source_lod'||prior.status!=='succeeded'||prior.result?.metadata?.geometry?.status!=='blocked')throw Error('局部修复的原失败任务证据不匹配。');failure=prior;}
    const stage=failure.parameters?.retryStage||failure.result.metadata.geometry.returnedDiagnosticStage,parentId=failure.parameters?.retryJobId||failure.result.metadata.geometry.retry?.retryJobId||failure.id;
    if(!/^lod[1-4]$/.test(stage||'')||!parentId)throw Error('缺少已验收直接父LOD的单档重试来源。');
    return withNativeRerunLock(rerunLocks.current,`${parentId}:${stage}`,async()=>{
      const parentResponse=await nativeRequest(`/jobs/${encodeURIComponent(parentId)}`),parent=parentResponse.job||parentResponse;let o=check();
      const pending=o.nodesRef.current.filter(n=>n.data?.operation==='source_lod'&&n.data.nativeParameters?.retryJobId===parentId&&n.data.nativeParameters?.retryStage===stage&&(['queued','running','finishing'].includes(n.data.status)||n.data.nativeSubmissionUncertain));
      if(pending.length){o.focusNode?.(pending[0].id);throw Error('该档已有待核实任务，请在已定位节点同步任务状态；不会重复提交。');}
      const virtual={...bound,data:{operation:'analyze',status:'completed',sourceJobId:failure.id,sourceNodeId:failure.nodeId,metadata:failure.result.metadata}};
      const drafts=o.nodesRef.current.filter(n=>n.data?.nativeRetryFailureJobId===failure.id&&!n.data.nativeJobId&&!n.data.nativeRun);
      if(drafts.length>1)throw Error('已有多个未提交草稿，请先核对。');
      const existing=drafts[0],seed=existing?.data.nativeParameters?.seed??nextNativeLODSeed(o.nodesRef.current,parentId,stage),newId=existing?.id||`native3d-retry-${crypto.randomUUID()}`;
      const plan=nativeLODStageRetryPlan(virtual,o.nodesRef.current.filter(n=>n.id!==newId),parent,projectId,seed,newId);
      // Preserve the failed attempt's immutable percentage, never the parent job's percentage.
      const keep=failure.parameters.retryKeepPercent??failure.result.metadata.geometry.targetPolicy?.requestedKeepPercent;
      if(!Number.isFinite(keep)||keep<=0||keep>100)throw Error('缺少原失败档的确切保留比例。');
      plan.node.data.nativeParameters.retryKeepPercent=keep;
      plan.node.data.nativeRetryFailureJobId=failure.id;
      const parameters=JSON.stringify(plan.node.data.nativeParameters),links=JSON.stringify(plan.edges.map(e=>[e.source,e.targetHandle]).sort());
      if(existing){const actual=o.edgesRef.current.filter(e=>e.target===newId&&['model','high'].includes(e.targetHandle)).map(e=>[e.source,e.targetHandle]).sort();if(JSON.stringify(existing.data.nativeParameters)!==parameters||JSON.stringify(actual)!==links)throw Error('已有重试草稿已编辑，请在该节点继续。');}
      else{o.recordHistory?.(o.nodesRef.current,o.edgesRef.current);o.nodesRef.current=o.nodesRef.current.concat(plan.node);o.edgesRef.current=o.edgesRef.current.concat(plan.edges);o.setNodes(o.nodesRef.current);o.setEdges(o.edgesRef.current);}
      o.focusNode?.(newId);
      try{await o.persistProject(Boolean(existing?.data.nativeRetrySaveFailed));}catch(error){o=check();o.updateNode(newId,{nativeRetrySaveFailed:true});throw error;}o=check();
      const fresh=o.nodesRef.current.find(n=>n.id===newId),actualLinks=o.edgesRef.current.filter(e=>e.target===newId&&['model','high'].includes(e.targetHandle)).map(e=>[e.source,e.targetHandle]).sort();
      if(JSON.stringify(fresh?.data.nativeParameters)!==parameters||JSON.stringify(actualLinks)!==links)throw Error('重试设置或输入连接已改变，未提交。');
      nativeLODStageRetryPlan(virtual,o.nodesRef.current.filter(n=>n.id!==newId),parent,projectId,seed,newId);
      await run(newId);return {nodeId:newId,seed,retryStage:stage,retryJobId:parentId,keepPercent:keep};
    });
  }
  async function rerunResult(id) {
    const target=rerunStatus(id);
    if(!target.ready)throw new Error(target.message);
    if(target.operation!=='source_lod')return withNativeRerunLock(rerunLocks.current,target.processorId,()=>run(target.processorId));
    const initial=current(),key=`${target.retryJobId}:${target.retryStage}`;
    return withNativeRerunLock(rerunLocks.current,key,async()=>{
      const assertOrigin=()=>{
        const live=current();
        if(live.projectId!==initial.projectId)throw new Error('项目已改变，单档重试未提交。');
        const fresh=nativeRerunTarget(live.nodesRef.current.find(n=>n.id===id),live.nodesRef.current);
        if(JSON.stringify(fresh)!==JSON.stringify(targetWithoutReady))throw new Error('重试来源已改变，未提交任务。');
        return live;
      };
      const {ready,...targetWithoutReady}=target;
      const response=await nativeRequest(`/jobs/${encodeURIComponent(target.retryJobId)}`);
      const job=response.job||response;let live=assertOrigin();
      const seed=nextNativeLODSeed(live.nodesRef.current,target.retryJobId,target.retryStage);
      const newId=`native3d-retry-${crypto.randomUUID()}`;
      const planned=nativeLODStageRetryPlan(live.nodesRef.current.find(n=>n.id===id),live.nodesRef.current,job,live.projectId,seed,newId);
      live.recordHistory?.(live.nodesRef.current,live.edgesRef.current);
      live.nodesRef.current=live.nodesRef.current.concat(planned.node);live.edgesRef.current=live.edgesRef.current.concat(planned.edges);
      live.setNodes(live.nodesRef.current);live.setEdges(live.edgesRef.current);
      try {
        await live.persistProject();live=assertOrigin();
        const checked=nativeLODStageRetryPlan(live.nodesRef.current.find(n=>n.id===id),live.nodesRef.current.filter(n=>n.id!==newId),job,live.projectId,seed,newId);
        const liveInputEdges=live.edgesRef.current.filter(e=>e.target===newId&&['model','high'].includes(e.targetHandle));
        if(liveInputEdges.length!==planned.edges.length||planned.edges.some(expected=>!liveInputEdges.some(actual=>actual.id===expected.id&&actual.source===expected.source&&actual.targetHandle===expected.targetHandle)))throw new Error('重试输入连线已改变，未提交。');
        if(JSON.stringify(checked.edges)!==JSON.stringify(planned.edges))throw new Error('父LOD或高模来源已改变，未提交任务。');
        const draft=live.nodesRef.current.find(n=>n.id===newId);
        if(!draft||JSON.stringify(draft.data.nativeParameters)!==JSON.stringify(planned.node.data.nativeParameters))throw new Error('单档重试设置已改变，未提交。');
        await run(newId);
        return {nodeId:newId,seed,retryStage:target.retryStage,retryJobId:target.retryJobId};
      }catch(error){
        if(latest.current.projectId===initial.projectId&&!latest.current.nodesRef.current.find(n=>n.id===newId)?.data.nativeJobId)patch(newId,{status:'error',error:error.message});
        throw error;
      }
    });
  }
  return { compactResults,output:id=>nativeOutputNode(latest.current.nodesRef.current.find(n=>n.id===id)),notificationSoundEnabled,setNotificationSoundEnabled,unlockNotificationSound:()=>native3DNotifications.unlock(),syncTask,retryLOD, repairLOD, createResolution, nextStep, nextActions: id=>{const node=nextSource(id);return nextStepActions(node).map(action=>{if(action.action!=='unwrap')return action;try{assertLivePlan(node.data.nativeUVPlan,current());return action;}catch{return {...action,disabled:true};}});}, projectId: options.projectId, readOnly: options.readOnly, capabilities, capabilityError, patch, run, rerunStatus, rerunResult, importModel, retryDelivery, refreshUVPreview,refreshDiagnosticPreview,
    diagnosticPreview:id=>{const o=latest.current,n=o.nodesRef.current.find(n=>n.id===id),p=n?.data.nativeUVDiagnosticPreviews;return p?.diagnosticOnly===true&&p.acceptedUV===false&&p.bakeAllowed===false&&p.projectId===o.projectId&&p.nodeId===id&&p.jobId===n.data.nativeJobId&&n.data.operation==='uv'&&['error','failed'].includes(n.data.status)&&p.inputIdentity===identityFor(n,sourceFor(o,n))?p:null;},
    persist:()=>current().persistProject(),
    inputs:id=>inputsFor(latest.current,latest.current.nodesRef.current.find(n=>n.id===id)),
    planStatus:id=>{
      try {const o=latest.current,node=o.nodesRef.current.find(n=>n.id===id),inputs=inputsFor(o,node);
        const plan=assertConfirmedPlan(inputs.plan,inputs.model,inputs.high);assertLivePlan(plan,o);
        const adapter=capabilities?.operations?.uv;planUVParameters(plan,node.data.nativeParameters || {},nativeAdapterSchema(adapter));
        return {ready:true};
      }catch(error){return {ready:false,message:error.message};}
    },
    openPlan: id=>{
      const o=current();let node=o.nodesRef.current.find(n=>n.id===id);
      if(node?.data.nativeCurrentOutputId)node=nativeOutputNode(node);
      else if(node?.data.operation==='uv_plan') node=o.nodesRef.current.find(n=>n.data.sourceNodeId===id&&n.data.nativeUVPlan?.jobId===node.data.nativeJobId);
      const plan=node?.data.nativeUVPlan;
      assertLivePlan(plan,o);
      setViewer({path:plan.lowAssetPath,title:node.data.title,plan,nodeId:node.id,planPreviews:validPlanPreviews(node.data.nativeUVPlanPreviews,plan)?node.data.nativeUVPlanPreviews:null});
      return {nodeId:node.id,planSha256:plan.planSha256};
    },
    planLoaded: async (id,hash)=>{
      const o=current(),node=o.nodesRef.current.find(n=>n.id===id),plan=node?.data.nativeUVPlan;
      assertLivePlan(plan,o);
      if (plan.planSha256!==hash) throw Error('方案已改变，未标记审阅。');
      const key=planConfirmationKey(plan);viewedPlans.current.set(id,{projectId:o.projectId,key});
      patch(id,{nativeUVPlanViewed:key});
      try {await o.persistProject();assertLivePlan(plan,current());} catch(error) {viewedPlans.current.delete(id);if(latest.current.projectId===o.projectId)patch(id,{nativeUVPlanViewed:null});throw error;}
    },
    planPreviews: async(id,hash,blobs)=>{
      const initial=current(),node=initial.nodesRef.current.find(n=>n.id===id),plan=node?.data.nativeUVPlan;
      assertLivePlan(plan,initial);if(plan.planSha256!==hash)throw Error('方案已改变，预览未保存。');
      if(validPlanPreviews(node.data.nativeUVPlanPreviews,plan))return node.data.nativeUVPlanPreviews;
      const key=planConfirmationKey(plan);
      const saveKey=`${initial.projectId}:${id}:${key}`;
      if(previewSaves.current.has(saveKey))return previewSaves.current.get(saveKey);
      const assertCurrent=()=>{const o=current(),live=o.nodesRef.current.find(n=>n.id===id);if(o.projectId!==initial.projectId||planConfirmationKey(live?.data.nativeUVPlan)!==key)throw Error('项目或方案已改变，预览未交付。');assertLivePlan(live.data.nativeUVPlan,o);return o;};
      const targets=()=>assertCurrent().nodesRef.current.filter(n=>[id,plan.producerNodeId].includes(n.id)&&n.data.nativeUVPlan?.planSha256===hash);
      const previous=new Map(targets().map(n=>[n.id,n.data.nativeUVPlanPreviews]));
      const pending=savePlanPreviews(plan,blobs,{assertCurrent,saveFile:file=>initial.saveNativeFile(file),
        apply:record=>{for(const target of targets())patch(target.id,{nativeUVPlanPreviews:record,nativePlanPreviewMode:'regions'});},
        persist:()=>initial.persistProject(),rollback:record=>{if(latest.current.projectId!==initial.projectId)return;for(const target of latest.current.nodesRef.current)if(previous.has(target.id)&&target.data.nativeUVPlanPreviews===record)patch(target.id,{nativeUVPlanPreviews:previous.get(target.id)||null});}});
      previewSaves.current.set(saveKey,pending);
      try{return await pending;}finally{if(previewSaves.current.get(saveKey)===pending)previewSaves.current.delete(saveKey);}
    },
    confirmPlan: async (id,hash)=>{
      const o=current(),node=o.nodesRef.current.find(n=>n.id===id),plan=node?.data.nativeUVPlan;
      assertLivePlan(plan,o);
      const key=planConfirmationKey(plan);
      if (plan.planSha256!==hash || node.data.nativeUVPlanViewed!==key || viewedPlans.current.get(id)?.key!==key || viewedPlans.current.get(id)?.projectId!==o.projectId) throw Error('请先在当前页3D面板查看真实方案。');
      patch(id,{nativeUVPlanConfirmation:key});
      try {await o.persistProject();assertLivePlan(plan,current());} catch(error) {if(latest.current.projectId===o.projectId)patch(id,{nativeUVPlanConfirmation:null});throw error;}
      return {nodeId:id,planSha256:hash,confirmed:true};
    },
    createStage: async ({sourceId,stage,...position}) => {
      const o=current();const source=o.nodesRef.current.find(n=>n.id===sourceId);
      const visible=nativeOutputNode(source);
      const selectedArtifact=visible?.data.nativeArtifacts?.find(a=>a.name===`${stage}.glb`&&a.role==='export');
      if(source?.data.nativeCurrentOutputId&&visible.data.assetPath===selectedArtifact?.assetPath)return {node:source,existing:true};
      const initial=nativeStagePlan(source,stage,o.nodesRef.current,position);
      const fingerprint=plan=>JSON.stringify([plan.node.data.assetPath,plan.node.data.sourceJobId,plan.node.data.sourceNodeId,plan.node.data.originalAssetPath,plan.node.data.nativeStageProvenance.parentMeshHash,plan.node.data.metadata.geometry.selectedMeshHash]);
      const assertCurrent=()=>{
        const live=current();
        if (live.projectId!==o.projectId) throw new Error('当前项目已改变，阶段预览未交付。');
        const plan=nativeStagePlan(live.nodesRef.current.find(n=>n.id===sourceId),stage,live.nodesRef.current,position);
        if (fingerprint(plan)!==fingerprint(initial)) throw new Error('阶段来源已改变，预览未交付。');
        return {live,plan};
      };
      const posterAssetPath=await saveNativeStagePoster(initial,{saveFile:file=>o.saveNativeFile(file),assertCurrent});
      const {live,plan}=assertCurrent();
      plan.node={...plan.node,data:{...plan.node.data,posterAssetPath}};
      live.recordHistory?.(live.nodesRef.current,live.edgesRef.current);
      const {nodes,edges}=applyNativeStagePlan(live.nodesRef.current,live.edgesRef.current,plan);
      live.nodesRef.current=nodes;live.edgesRef.current=edges;live.setNodes(nodes);live.setEdges(edges);
      live.recordHistory?.(nodes,edges);
      return {node:plan.node,existing:plan.existing};
    },
    parameter: (id, key, value) => { const n = current().nodesRef.current.find(n => n.id === id); patch(id, { nativeParameters: { ...n.data.nativeParameters, [key]: value },nativeUVPlanConfirmation:null,nativeUVPlanViewed:null }); },
    cancel: async id => {
      const o = current(); const n = o.nodesRef.current.find(n => n.id === id); const snapshot = { ...n.data.nativeRun, jobId: n.data.nativeJobId };
      try { await nativeRequest(`/jobs/${encodeURIComponent(snapshot.jobId)}/cancel`, {}); }
      catch (error) { try { assertRun(o.projectId, id, snapshot); patch(id, { error: error.message }); } catch { /* superseded run */ } }
    }, openRepair: repairTarget => setViewer({issueTarget:repairTarget,repairPreview:true}), openIssues: (issueTarget,nodeId) => {const node=current().nodesRef.current.find(n=>n.id===nodeId);if(!lodIssueTargets(node?.data).some(t=>JSON.stringify(t)===JSON.stringify(issueTarget)))throw Error('诊断来源已改变。');setViewer({issueTarget,nodeId,resolution:lodResolution(node.data)?{...lodResolution(node.data),repairAttempt:Boolean(node.data.nativeLocalRepair||node.data.metadata?.geometry?.localRepair)}:null});}, view: setViewer, viewer, closeViewer: () => setViewer(null) };
}
