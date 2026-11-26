const hash=/^[a-f0-9]{64}$/;
const job=/^n3d_[a-f0-9]{32}$/;
// Presentation only: never changes the backend geometry gate or confirms a plan.
export function reviewedDownstreamWarning(data) {
  const m=data?.metadata,r=m?.geometryReview,operation=m?.operation || data?.operation;
  if(data?.status!=='completed'||data.error||!['uv_plan','uv','bake'].includes(operation)||m?.geometry?.status!=='blocked')return null;
  if(r?.profile!=='reviewed-boundary-deviation-v1'||r.status!=='experimental_reviewed'||r.geometryStatus!=='blocked'||!job.test(r.reviewedBoundaryJobId||'')||!/^lod[0-4]$/.test(r.reviewedBoundaryStage||'')||!hash.test(r.sourceSha256||'')||r.sourceSha256!==m.sourceSha256||r.intersectionComplete!==true||r.intersectionCount!==0)return null;
  const rows=(m.geometry.stages||[]).filter(s=>s.stage===r.reviewedBoundaryStage),row=rows[0],audit=row?.receipt?.geometry;
  if(rows.length!==1||row.status!=='blocked'||row.eligibleForDownstream!==false||row.diagnosticFileSha256!==r.diagnosticFileSha256||!hash.test(r.diagnosticFileSha256||'')||row.mesh_hash!==r.diagnosticMeshHash||audit?.mesh_hash!==row.mesh_hash||audit?.status!=='accepted'||audit.intersectionComplete!==true||audit.intersection_pairs_count!==0)return null;
  if(operation==='uv_plan') {
    const p=data.nativeUVPlan;
    if(!p||p.jobId!==(data.nativeJobId||data.sourceJobId||data.nativeDeliveredJobId)||p.source?.lowSha256!==r.sourceSha256||p.lowAssetPath!==`assets/${r.sourceSha256}.glb`||p.settings?.reviewedBoundaryJobId!==r.reviewedBoundaryJobId||p.settings?.reviewedBoundaryStage!==r.reviewedBoundaryStage)return null;
  }
  const settings=data.nativeRun?.parameters;
  if(settings&&(settings.reviewedBoundaryJobId!==r.reviewedBoundaryJobId||settings.reviewedBoundaryStage!==r.reviewedBoundaryStage))return null;
  return {stage:r.reviewedBoundaryStage.toUpperCase(),message:`来源${r.reviewedBoundaryStage.toUpperCase()}轮廓警告，已选择继续，${operation==='uv_plan'?'当前切缝已生成':operation==='uv'?'当前UV已生成':'当前烘焙已完成'}`,blocker:r.originalBlocker||m.geometry.blocker,jobId:r.reviewedBoundaryJobId};
}
export function reviewedDisplayTitle(data) {
  if(!reviewedDownstreamWarning(data))return data?.title;
  // Only normalize known generated titles. Custom names remain untouched.
  return /^UV切缝方案(?: · 轮廓待复核)? · 未通过诊断$/.test(data.title||'') ? data.title.replace(/ · 未通过诊断$/,' · 待确认方案') : data.title;
}
