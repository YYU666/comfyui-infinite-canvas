import {nativeAppendOutput} from './native3d-output.js';

const active=new Set(['queued','running','uploading','finishing']);
const jobPattern=/^n3d_[a-f0-9]{32}$/;
const assetPattern=/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/i;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const stage=d=>d.nativeStage||d.metadata?.geometry?.selectedStage||(/^[0-4]$/.test(String(d.nativeLODLevel))?`lod${d.nativeLODLevel}`:null);
const failed=d=>['error','failed','cancelled','canceled'].includes(d.status)||(d.metadata?.operation==='source_lod'||d.operation==='source_lod')&&d.metadata?.geometry?.status==='blocked';
function mentions(value,tokens,parentKey='') {
  if(typeof value==='string')return tokens.some(token=>value.includes(token));
  if(Array.isArray(value))return value.some(item=>mentions(item,tokens));
  return value&&typeof value==='object'&&Object.entries(value).some(([key,item])=>{
    // These retain UI origin/draft-dedup history, not executable node lookups.
    // Keep their values in the saved record; backend jobs/files are never removed.
    if(parentKey==='nativeLODStageRetry'&&key==='originResultId')return false;
    if(parentKey==='nativeResolution'&&['key','failureJobId'].includes(key))return false;
    return mentions(item,tokens,key);
  });
}

// Explicit, pure migration. Embedded data keeps legacy logical identities intact.
export function compactNative3DGraph(nodes,edges,{cleanupFailed=false,cleanupIds=[]}={}) {
  if(!Array.isArray(nodes)||!Array.isArray(edges)||!Array.isArray(cleanupIds)||cleanupIds.some(id=>typeof id!=='string'))throw Error('整理参数无效。');
  if(nodes.some(n=>n.type==='native3d'&&(active.has(n.data?.status)||n.data?.nativeSubmissionUncertain)))throw Error('3D任务正在运行或提交待核实，暂不能整理。');
  const byId=new Map(nodes.map(n=>[n.id,n]));
  if(byId.size!==nodes.length||new Set(edges.map(e=>e.id)).size!==edges.length)throw Error('节点或连线ID重复，不能整理。');
  const requested=new Set(cleanupFailed?cleanupIds:[]),removed=new Set(),retained=new Map();
  for(const id of requested) {
    const n=byId.get(id);
    if(!n){retained.set(id,'节点不存在');continue;}
    if(n.type!=='native3d'||!failed(n.data)||n.data.nativeOutputRecords?.some(r=>!failed(r.data))){retained.set(id,'不是可清理的失败3D记录');continue;}
    removed.add(id);
  }
  // Keep dependency closure, including frozen retry/local-repair metadata and run identities.
  let changed=true;
  while(changed) {
    changed=false;
    for(const id of [...removed]) {
      const d=byId.get(id).data;
      const tokens=[id,d.nativeJobId,d.sourceJobId,d.assetPath,d.resultAssetPath].filter(Boolean);
      const required=edges.some(e=>e.source===id&&!removed.has(e.target))||nodes.some(n=>n.id!==id&&!removed.has(n.id)&&mentions(n.data,tokens));
      if(required){removed.delete(id);retained.set(id,'仍被连线、任务或重试来源依赖');changed=true;}
    }
  }
  const remaining=nodes.filter(n=>!removed.has(n.id)),remainingEdges=edges.filter(e=>!removed.has(e.source)&&!removed.has(e.target));
  const replacements=new Map(),mainByProducer=new Map();
  for(const result of remaining) {
    const d=result.data,producer=byId.get(d?.sourceNodeId),p=producer?.data;
    if(result.type!=='native3d'||d.operation!=='analyze'||d.status!=='completed'||d.error||!jobPattern.test(d.sourceJobId||'')||!result.id.startsWith('native3d-result-')||removed.has(producer?.id))continue;
    if(producer?.type!=='native3d'||p.operation==='analyze'||p.status!=='completed'||p.nativeJobId!==d.sourceJobId||p.nativeDeliveredJobId!==d.sourceJobId||d.nativeDeliveredJobId!==d.sourceJobId||d.metadata?.operation!==p.operation)continue;
    const outputMatches=d.nativeUVPlan ? p.nativeUVPlan?.jobId===d.sourceJobId&&d.nativeUVPlan.jobId===d.sourceJobId&&d.nativeUVPlan.planSha256===p.nativeUVPlan.planSha256&&d.nativeUVPlan.lowAssetPath===p.nativeUVPlan.lowAssetPath&&d.nativeUVPlan.highAssetPath===p.nativeUVPlan.highAssetPath : assetPattern.test(d.assetPath||'')&&d.assetPath===p.resultAssetPath;
    const provenance=remainingEdges.filter(e=>e.target===result.id&&e.targetHandle==='provenance');
    if(!outputMatches||provenance.length!==1||provenance[0].source!==producer.id)continue;
    if(mainByProducer.has(producer.id))throw Error('同一处理节点有多个当前结果，未猜测输出版本。');
    mainByProducer.set(producer.id,result);replacements.set(result.id,producer.id);
  }
  // Same-stage, same-asset aliases can share a card but retain separate logical records.
  for(const result of remaining) {
    const d=result.data,main=mainByProducer.get(d?.sourceNodeId);
    if(result.type!=='native3d'||!result.id.startsWith('native3d-stage-')||!main||d.operation!=='analyze'||d.status!=='completed'||d.error||d.sourceJobId!==main.data.sourceJobId||d.nativeStageProvenance?.processorNodeId!==d.sourceNodeId||!d.nativeStage||d.nativeStage!==stage(main.data)||d.assetPath!==main.data.assetPath)continue;
    const provenance=remainingEdges.filter(e=>e.target===result.id&&e.targetHandle==='provenance');
    if(provenance.length===1&&provenance[0].source===d.sourceNodeId)replacements.set(result.id,d.sourceNodeId);
  }
  const merged=new Map();
  for(const [resultId,producerId] of replacements) {
    const result=byId.get(resultId),producer=merged.get(producerId)||byId.get(producerId);
    const old=producer.data.nativeOutputRecords?.find(r=>r.recordId===resultId);
    if(old&&!same(old.data,result.data))throw Error('已有结果版本内容不同，不能覆盖。');
    merged.set(producerId,{...producer,data:nativeAppendOutput(producer,result)});
  }
  for(const [producerId,main] of mainByProducer) {
    const producer=merged.get(producerId);producer.data={...producer.data,nativeCurrentOutputId:main.id};
  }
  const outputNodes=remaining.filter(n=>!replacements.has(n.id)).map(n=>merged.get(n.id)||n);
  const outputEdges=[];
  for(const edge of remainingEdges) {
    const source=replacements.get(edge.source)||edge.source,target=replacements.get(edge.target)||edge.target;
    if(source===target&&edge.source!==edge.target) {
      if(edge.targetHandle==='provenance'&&replacements.get(edge.target)===edge.source)continue;
      throw Error('整理会产生自连接，已取消。');
    }
    if(replacements.has(edge.target)&&!['provenance','reference','diagnostic'].includes(edge.targetHandle))throw Error('结果节点带有执行输入，不能安全整理。');
    outputEdges.push(source===edge.source&&target===edge.target?edge:{...edge,source,target,...(replacements.has(edge.source)?{data:{...edge.data,outputRecordId:edge.source}}:{})});
  }
  return {nodes:outputNodes,edges:outputEdges,summary:{collapsedNodeIds:[...replacements.keys()],removedNodeIds:[...removed],retainedCleanup:[...retained].map(([id,reason])=>({id,reason})),nodeCountBefore:nodes.length,nodeCountAfter:outputNodes.length,edgeCountBefore:edges.length,edgeCountAfter:outputEdges.length,filesDeleted:false}};
}
