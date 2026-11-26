// Immutable result records belong to real processor nodes, never hidden canvas nodes.
export const nativeLogicalNodeId=node=>node?.nativeLogicalId || node?.id;
export function nativeOutputNode(node,recordId) {
  if(!node)return node;
  if(node.nativeOutputRecordId)return node;
  const records=node.data?.nativeOutputRecords || [];
  const id=recordId || node.data?.nativeCurrentOutputId;
  if(!id)return node;
  const matches=records.filter(r=>r.recordId===id);
  if(matches.length!==1)throw Error('结果版本缺失或重复，请核对来源。');
  const record=matches[0];
  if(record.schemaVersion!==1||record.jobId!==record.data?.sourceJobId||!record.data||record.data.operation!=='analyze')throw Error('结果版本凭据无效。');
  return {...node,nativeLogicalId:record.recordId,nativeOutputRecordId:record.recordId,data:{...record.data}};
}
export const nativeOutputForEdge=(node,edge)=>nativeOutputNode(node,edge?.data?.outputRecordId);
export const nativeOutputBinding=node=>node?.nativeOutputRecordId?{outputRecordId:node.nativeOutputRecordId}:{};
export function nativeAppendOutput(processor,result,{producerRun=processor.data.nativeRun,producerParameters=processor.data.nativeParameters}={}) {
  if(result.data?.operation!=='analyze'||!result.data.sourceJobId||result.data.sourceNodeId!==processor.id)throw Error('结果与处理节点不匹配。');
  const recordId=result.nativeLogicalId||result.id;
  const record={schemaVersion:1,recordId,jobId:result.data.sourceJobId,data:structuredClone(result.data),producerRun:structuredClone(producerRun),producerParameters:structuredClone(producerParameters)};
  const records=processor.data.nativeOutputRecords || [];
  const prior=records.find(r=>r.recordId===recordId);
  if(prior&&prior.jobId!==record.jobId)throw Error('结果版本已被其他任务占用。');
  return {...processor.data,nativeOutputRecords:[...records.filter(r=>r.recordId!==recordId),record],nativeCurrentOutputId:recordId};
}
export function nativePatchOutputData(data,patch) {
  const id=data.nativeCurrentOutputId;
  if(!id)return {...data,...patch};
  const fields=['nativeUVPlanConfirmation','nativeUVPlanViewed','nativeUVPlanPreviews','nativePlanPreviewMode','nativeUVPreviews','nativeUVPreviewMode','nativeBakePreviewMode'];
  const outputPatch=Object.hasOwn(patch,'nativeParameters')?{}:Object.fromEntries(Object.entries(patch).filter(([key])=>fields.includes(key)));
  return {...data,...patch,nativeOutputRecords:data.nativeOutputRecords.map(r=>r.recordId===id?{...r,data:{...r.data,...outputPatch}}:r)};
}
export function nativeBindOutputEdges(edges,nodes) {
  return edges.map(edge=>{
    if(edge.data?.outputRecordId||!['model','high','plan'].includes(edge.targetHandle))return edge;
    const source=nodes.find(n=>n.id===edge.source);
    return source?.data.nativeCurrentOutputId?{...edge,data:{...edge.data,outputRecordId:source.data.nativeCurrentOutputId}}:edge;
  });
}

export function nativeOutputCandidates(nodes) {
  return nodes.flatMap(n=>n.data?.nativeOutputRecords?.length?n.data.nativeOutputRecords.map(r=>nativeOutputNode(n,r.recordId)):[n]);
}
