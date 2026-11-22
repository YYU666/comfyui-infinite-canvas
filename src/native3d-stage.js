import {nativeOutputNode} from './native3d-output.js';
const assetPattern=/^assets\/[a-f0-9]{64}\.glb$/i;
const stagePattern=/^(fit|lod_[1-9][0-9]{0,5}|lod[0-4])$/;
export function nativeVisibleStages(data) {
  if(data?.metadata?.geometry?.status!=='accepted')return [];
  return (data.metadata.geometry.stages || []).filter(record=>{
    if(record.visible===false || !stagePattern.test(record.stage || ''))return false;
    if(data.metadata.operation!=='source_lod')return true;
    const geometry=record.receipt?.geometry || record.receipt?.after || record.geometry;
    return record.status==='accepted' && record.eligibleForDownstream===true && geometry?.status==='accepted' && geometry.intersectionComplete===true && geometry.intersection_pairs_count===0;
  });
}
export function stageGeometry(record) {
  const geometry=record?.receipt?.geometry || record?.receipt?.after || record?.geometry;
  if (!geometry || !Number.isInteger(geometry.triangles) || geometry.triangles<1 || !Number.isInteger(geometry.vertices) || geometry.vertices<1) throw new Error('阶段缺少真实几何计数。');
  return geometry;
}
export function nativeStagePlan(source, stage, nodes, options={}) {
  source=nativeOutputNode(source);
  const data=source?.data;const geometry=data?.metadata?.geometry;
  if (options.diagnostic!==undefined && typeof options.diagnostic!=='boolean') throw new Error('诊断选项必须是布尔值。');
  const diagnostic=options.diagnostic===true;
  if (source?.type!=='native3d' || (!diagnostic && geometry?.status!=='accepted') || !/^n3d_[a-f0-9]{32}$/.test(data.sourceJobId || '')) throw new Error('需要已接受的修复减面结果及真实任务来源。');
  if (!stagePattern.test(stage || '')) throw new Error('仅支持fit或lod_N真实阶段。');
  if (diagnostic && (data.metadata?.operation!=='source_lod' || !geometry)) throw new Error('诊断阶段需要真实原高模减面任务报告。');
  const records=(geometry.stages || []).filter(s=>s.stage===stage);
  if (records.length!==1 || (!diagnostic && ((records[0].filename!==`${stage}.glb` && !records[0].aliasOfStage) || !/^(fit|lod_[1-9]\d{0,5}|lod[0-4]|step_\d+)\.glb$/.test(records[0].filename || '')))) throw new Error('阶段文件未在几何报告中登记。');
  const record=records[0];const metrics=stageGeometry(record);
  if (!diagnostic && data.metadata?.operation==='source_lod' && (record.status!=='accepted' || record.eligibleForDownstream!==true || metrics.status!=='accepted' || metrics.intersectionComplete!==true || metrics.intersection_pairs_count!==0)) throw new Error('这个LOD没有通过完整检查，只能作为诊断。');
  if (!/^[a-f0-9]{64}$/i.test(record.mesh_hash || '')) throw new Error('阶段缺少真实几何哈希。');
  if (diagnostic && (record.status!=='blocked' || record.eligibleForDownstream!==false || metrics.status!=='blocked' || record.diagnosticFilename!==`blocked_${stage}.glb` || !/^[a-f0-9]{64}$/i.test(record.diagnosticFileSha256 || ''))) throw new Error('阶段没有已登记且禁止下游的失败诊断模型。');
  const filename=diagnostic ? record.diagnosticFilename : record.filename;
  const files=(data.nativeArtifacts || []).filter(a=>a.name===filename && a.role==='export');
  if (files.length!==1 || !assetPattern.test(files[0].assetPath || '')) throw new Error('阶段缺少已保存的真实GLB素材。');
  if (diagnostic && files[0].assetPath.toLowerCase()!==`assets/${record.diagnosticFileSha256.toLowerCase()}.glb`) throw new Error('诊断模型素材哈希与阶段报告不符。');
  if (!assetPattern.test(data.originalAssetPath || '') && !/^assets\/[a-f0-9]{64}\.(obj|fbx)$/i.test(data.originalAssetPath || '')) throw new Error('阶段缺少原高模素材来源。');
  if (options.title!==undefined && (typeof options.title!=='string' || !options.title.trim() || options.title.length>160)) throw new Error('阶段标题无效。');
  for (const key of ['x','y']) if (options[key]!==undefined && !Number.isFinite(options[key])) throw new Error('节点坐标必须有限。');
  const existing=nodes.find(n=>n.type==='native3d' && n.data?.sourceJobId===data.sourceJobId && n.data?.nativeStage===stage);
  if (existing && existing.data.assetPath!==files[0].assetPath) throw new Error('已有阶段节点素材与来源冲突。');
  const processor=nodes.find(n=>n.id===data.sourceNodeId && n.type==='native3d' && ['repair_lod','source_lod'].includes(n.data.operation) && (n.data.nativeDeliveredJobId===data.sourceJobId || n.data.nativeJobId===data.sourceJobId));
  if (!processor || (diagnostic && processor.data.operation!=='source_lod')) throw new Error('阶段的真实修复减面处理节点缺失或任务不匹配。');
  const parent=geometry.stages.slice(0,geometry.stages.indexOf(record)).reverse().find(s=>s.mesh_hash===record.parent_mesh_hash);
  const reference=nodes.find(n=>n.type==='native3d' && n.data.operation==='analyze' && !n.data.sourceJobId && n.data.assetPath===data.originalAssetPath);
  const stageIndex=geometry.stages.filter(s=>stagePattern.test(s.stage)).findIndex(s=>s.stage===stage);
  const provenance={processorNodeId:processor.id,referenceNodeId:reference?.id,parentStage:parent?.stage || null,parentMeshHash:record.parent_mesh_hash,parentTriangles:parent ? (parent.receipt?.geometry || parent.receipt?.after || parent.geometry)?.triangles : null,stageIndex,lodLevel:record.lodLevel,sourceMode:processor.data.operation};
  // Keep the lineage and stage metrics; full collapse/move evidence stays in the
  // inherited report attachment instead of duplicating megabytes per canvas node.
  const lineage=geometry.stages.map(s=>({stage:s.stage,filename:s.filename,mesh_hash:s.mesh_hash,parent_mesh_hash:s.parent_mesh_hash,
    ...(s.diagnosticFilename?{diagnosticFilename:s.diagnosticFilename,diagnosticFileSha256:s.diagnosticFileSha256}:{}),
    ...(s.status!==undefined?{status:s.status}:{}),...(s.eligibleForDownstream!==undefined?{eligibleForDownstream:s.eligibleForDownstream}:{}),
    ...(Number.isInteger(s.lodLevel)?{lodLevel:s.lodLevel}:{}),...(s.visible!==undefined?{visible:s.visible}:{}),...(s.aliasOfStage?{aliasOfStage:s.aliasOfStage}:{}),
    receipt:{geometry:s.receipt?.geometry || s.receipt?.after || s.geometry,...(s.receipt?.fidelity?{fidelity:s.receipt.fidelity}:{})}}));
  const node={id:`native3d-stage-${data.sourceJobId}-${stage}`,type:'native3d',position:{x:options.x ?? (source.position?.x || 0)+420,y:options.y ?? (source.position?.y || 0)},
    data:{title:options.title || existing?.data.title || (diagnostic?`LOD${record.lodLevel} · 检查未通过 · ${metrics.triangles}面`:record.lodLevel===0?`LOD0 · Nanite候选 · ${metrics.triangles}面`:Number.isInteger(record.lodLevel)?`LOD${record.lodLevel} · ${metrics.triangles}面`:stage==='fit'?'LOD0 · 修复贴合基底':`LOD${stageIndex} · ${metrics.triangles}面`),operation:'analyze',status:'completed',
      assetPath:files[0].assetPath,resultAssetPath:files[0].assetPath,proxyAssetPath:files[0].assetPath,name:filename,
      ...(diagnostic?{nativeStageDiagnostic:true,eligibleForDownstream:false,nativeDiagnosticFileSha256:record.diagnosticFileSha256}:{}),
      originalAssetPath:data.originalAssetPath,sourceJobId:data.sourceJobId,sourceNodeId:processor.id,nativeStage:stage,nativeStageProvenance:provenance,
      nativeGeometryProvenance:true,nativeArtifacts:data.nativeArtifacts,...(processor.data.operation==='source_lod' ? {nativeLODLevel:record.lodLevel,nativeNaniteCandidate:!diagnostic && record.lodLevel===0}:{}),
      quality:{...metrics,status:diagnostic?'blocked':'accepted'},metadata:{operation:processor.data.operation,source:metrics,
        geometry:{...geometry,...(diagnostic?{status:'blocked',eligibleForDownstream:false,diagnosticOnly:true,...(metrics.blocker?{blocker:metrics.blocker}:{})}:{}),stages:lineage,selectedStage:stage,selectedMeshHash:record.mesh_hash,...(Number.isInteger(record.lodLevel)?{selectedLodLevel:record.lodLevel}:{})}}}};
  if (!existing && nodes.some(n=>n.id===node.id)) throw new Error('阶段节点ID已被其他内容占用。');
  const updated=existing ? {...existing,data:{...existing.data,...node.data},position:{x:options.x ?? existing.position.x,y:options.y ?? existing.position.y}} : node;
  const edge={id:`native3d-stage-edge-${data.sourceJobId}-${stage}`,source:processor.id,sourceHandle:'model',target:updated.id,targetHandle:'provenance',label:diagnostic?'失败诊断':'阶段输出',data:{role:'stage-output',sourceJobId:data.sourceJobId,stage,...(diagnostic?{diagnostic:true}: {})}};
  const edges=[edge];
  if (reference) edges.push({id:`native3d-stage-reference-${data.sourceJobId}-${stage}`,source:reference.id,sourceHandle:'model',target:updated.id,targetHandle:'reference',label:'高模参考',style:{strokeDasharray:'6 4'},data:{role:'high-reference',sourceJobId:data.sourceJobId,stage}});
  return {node:updated,existing:Boolean(existing),edge,edges};
}

export function moveSpecifiedNodes(nodes, moves) {
  if (!Array.isArray(moves) || moves.length<1 || moves.length>30) throw new Error('指定移动必须为1至30个节点。');
  const map=new Map();
  for (const item of moves) {
    if (!item || Object.keys(item).some(k=>!['nodeId','x','y'].includes(k)) || typeof item.nodeId!=='string' || !Number.isFinite(item.x) || !Number.isFinite(item.y) || map.has(item.nodeId)) throw new Error('移动参数无效、重复或坐标非有限。');
    if (!nodes.some(n=>n.id===item.nodeId)) throw new Error('指定节点不存在。');
    map.set(item.nodeId,item);
  }
  return nodes.map(n=>map.has(n.id)?{...n,position:{x:map.get(n.id).x,y:map.get(n.id).y}}:n);
}

export function applyNativeStagePlan(nodes, edges, plan) {
  const managed=new Set([`native3d-stage-edge-${plan.node.data.sourceJobId}-${plan.node.data.nativeStage}`,`native3d-stage-reference-${plan.node.data.sourceJobId}-${plan.node.data.nativeStage}`]);
  return {nodes:plan.existing ? nodes.map(n=>n.id===plan.node.id?plan.node:n) : nodes.concat(plan.node),
    edges:edges.filter(e=>!managed.has(e.id)).concat(plan.edges)};
}

export async function saveNativeStagePoster(plan, {fetchPreview=fetch,saveFile,assertCurrent}) {
  assertCurrent();
  const {sourceJobId,nativeStage}=plan.node.data;
  const response=await fetchPreview(`/api/native3d/jobs/${encodeURIComponent(sourceJobId)}/stage-preview/${encodeURIComponent(nativeStage)}${plan.node.data.nativeStageDiagnostic===true?'?diagnostic=true':''}`);
  assertCurrent();
  if (!response.ok) throw new Error(`阶段预览未交付：HTTP ${response.status}`);
  const blob=await response.blob();
  assertCurrent();
  if (blob.type!=='image/png' || blob.size<8 || blob.size>8*1024*1024) throw new Error('阶段预览不是有效的有界PNG。');
  const signature=new Uint8Array(await blob.slice(0,8).arrayBuffer());
  if (signature.join(',')!=='137,80,78,71,13,10,26,10') throw new Error('阶段预览PNG签名无效。');
  const path=await saveFile(new File([blob],`${nativeStage}-preview.png`,{type:'image/png'}));
  assertCurrent();
  if (!/^assets\/[a-f0-9]{64}\.png$/i.test(path || '')) throw new Error('阶段预览尚未保存为项目素材。');
  return path;
}

export function nativeStageEdgeLabel(edge) {
  return edge?.data?.role==='high-reference' ? '高模参考' : edge?.data?.role==='stage-output' ? (edge.data.diagnostic===true?'失败诊断':'阶段输出') : null;
}
