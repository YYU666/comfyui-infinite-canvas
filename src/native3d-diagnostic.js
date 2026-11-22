// Associate an already uploaded diagnostic image with immutable model references.
// This records provenance only: no generation, UV acceptance or model conversion.
export function linkNativeDiagnostic(nodes, edges, { imageId, sourceIds }) {
  const image = nodes.find(n => n.id === imageId);
  if (image?.type !== 'media' || image.data.kind !== 'image' || !/^assets\/[a-f0-9]{64}\.(png|jpg|jpeg|webp)$/i.test(image.data.assetPath || '')) throw new Error('请先在当前页面保存诊断图片。');
  if (image.data.sourceGeneratorId || !Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 4 || new Set(sourceIds).size !== sourceIds.length) throw new Error('诊断来源必须是1至4个不同模型，不能覆盖生成结果来源。');
  const sources = sourceIds.map(id => {
    const n = nodes.find(n => n.id === id);
    if (n?.type !== 'native3d' || n.data.operation !== 'analyze' || ['uploading','running','queued','finishing'].includes(n.data.status) || !/^assets\/[a-f0-9]{64}\.(obj|glb)$/i.test(n.data.assetPath || '')) throw new Error('诊断来源需要已保存且空闲的模型素材。');
    return { nodeId:id, assetPath:n.data.assetPath };
  });
  const retained=edges.filter(e=>!(e.data?.role==='diagnostic-reference' && e.target===imageId));
  const added = sources.map(s => ({ id:`native3d-diagnostic-${encodeURIComponent(JSON.stringify([imageId,s.nodeId]))}`, source:s.nodeId, target:imageId, sourceHandle:'model', targetHandle:'preview', label:'诊断参考', style:{strokeDasharray:'5 4'}, data:{role:'diagnostic-reference'} }));
  if (added.some(edge=>retained.some(existing=>existing.id===edge.id))) throw new Error('诊断参考连线ID已被其他内容占用。');
  return {
    nodes:nodes.map(n => n.id===imageId ? {...n,data:{...n.data,output:false,nativeDiagnosticSources:sources,nativeDiagnosticImageAssetPath:image.data.assetPath}} : n),
    edges:retained.concat(added),
    linkedSourceIds:sourceIds,
  };
}

export const nativeProcessLabels={source:'源模型 · 非执行',partition:'分区边界 · 证据',ao_review:'辅助核对 · 未新增AO硬缝',mapping:'高低模边界映射 · 证据',uv_evidence:'UV流程证据 · 非执行'};
export const nativeProcessEdgeId=({kind,sourceId,targetId})=>`native3d-process-${encodeURIComponent(JSON.stringify([kind,sourceId,targetId]))}`;
function processAsset(node) {
  const d=node?.data;
  if (!d || ['uploading','running','queued','finishing'].includes(d.status)) throw new Error('流程证据节点不存在或正在运行。');
  if (node.type==='media' && d.kind==='image') {
    if (d.sourceGeneratorId || d.output || d.mediaRole==='mask' || !/^assets\/[a-f0-9]{64}\.(png|jpg|jpeg|webp)$/i.test(d.assetPath || '')) throw new Error('流程图片必须是当前页已保存的独立诊断素材。');
    if ([d.nativeDiagnosticImageAssetPath,d.nativeProcessEvidenceImageAssetPath].some(path=>path && path!==d.assetPath)) throw new Error('诊断图片已替换，旧流程证据失效。');
    return {nodeId:node.id,assetPath:d.assetPath};
  }
  if (node.type==='native3d') {
    if (d.operation==='analyze' && /^assets\/[a-f0-9]{64}\.(obj|glb)$/i.test(d.assetPath || '')) return {nodeId:node.id,assetPath:d.assetPath,...(d.sourceJobId ? {jobId:d.sourceJobId} : {})};
    if (d.operation==='uv' && d.status==='completed' && d.metadata?.operation==='uv' && /^n3d_[a-f0-9]{32}$/.test(d.nativeJobId || '') && /^assets\/[a-f0-9]{64}\.(obj|glb)$/i.test(d.resultAssetPath || '')) return {nodeId:node.id,assetPath:d.resultAssetPath,jobId:d.nativeJobId};
  }
  throw new Error('流程模型需要已保存来源或已完成的真实UV结果。');
}
export function linkNativeProcess(nodes,edges,request) {
  if (!Array.isArray(request?.edges) || !request.edges.length || request.edges.length>24) throw new Error('需要1至24条流程证据线。');
  const added=[];const markers=new Map();
  for (const item of request.edges) {
    if (!item || Object.keys(item).some(key=>!['sourceId','targetId','kind'].includes(key)) || !Object.hasOwn(nativeProcessLabels,item.kind) || item.sourceId===item.targetId) throw new Error('流程证据类型或端点无效。');
    const source=nodes.find(n=>n.id===item.sourceId),target=nodes.find(n=>n.id===item.targetId);
    const sourceAsset=processAsset(source),targetAsset=processAsset(target);
    const image=n=>n.type==='media';
    const valid=item.kind==='source' ? source.type==='native3d' && source.data.operation==='analyze' && image(target)
      : item.kind==='uv_evidence' ? image(source) && target.type==='native3d' && target.data.operation==='uv'
      : image(source) && image(target);
    if (!valid) throw new Error('流程证据端口类型不匹配，不可替代模型输入。');
    const edge={id:nativeProcessEdgeId(item),source:source.id,target:target.id,sourceHandle:image(source)?'ref':'model',targetHandle:image(target)?'preview':'diagnostic',label:nativeProcessLabels[item.kind],style:{strokeDasharray:'5 4'},data:{role:'native3d-process-evidence',kind:item.kind,nonExecuting:true,sourceAsset,targetAsset}};
    const idMatches=edges.concat(added).filter(e=>e.id===edge.id);
    if (idMatches.length>1 || idMatches.some(e=>e.source!==edge.source || e.target!==edge.target || e.sourceHandle!==edge.sourceHandle || e.targetHandle!==edge.targetHandle || JSON.stringify(e.data)!==JSON.stringify(edge.data))) throw new Error('流程证据连线ID已被其他内容占用。');
    const existing=edges.concat(added).filter(e=>e.source===source.id && e.target===target.id);
    if (existing.some(e=>e.id!==edge.id || JSON.stringify(e.data)!==JSON.stringify(edge.data))) throw new Error('已有连线语义或来源快照冲突。');
    if (!existing.length) {
      const queue=[target.id],seen=new Set();
      while (queue.length) {
        const id=queue.pop();if (id===source.id) throw new Error('流程证据不能形成环。');
        if (seen.has(id)) continue;seen.add(id);
        for (const e of edges.concat(added)) if (e.source===id) queue.push(e.target);
      }
      added.push(edge);
    }
    for (const n of [source,target]) markers.set(n.id,n.type==='media' ? {nativeProcessEvidenceImageAssetPath:n.data.assetPath} : n.data.operation==='uv' ? {nativeProcessEvidenceUV:targetAsset} : {});
  }
  return {nodes:nodes.map(n=>markers.has(n.id)?{...n,data:{...n.data,...markers.get(n.id)}}:n),edges:edges.concat(added),edgeIds:request.edges.map(nativeProcessEdgeId)};
}
