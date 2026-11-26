import {boundaryFailure} from './native3d-lod-resolution.js';
export function lodIssueTargets(data) {
  const jobId=data?.nativeJobId || data?.sourceJobId;
  if (!/^n3d_[a-f0-9]{32}$/.test(jobId || '')) return [];
  return (data.metadata?.geometry?.stages || []).filter(stage=>stage.status==='blocked' && stage.eligibleForDownstream===false && /^lod[0-4]$/.test(stage.stage) && stage.diagnosticFilename===`blocked_${stage.stage}.glb` && /^[a-f0-9]{64}$/.test(stage.diagnosticFileSha256 || '')).map(stage=>({jobId,stage:stage.stage,diagnosticFileSha256:stage.diagnosticFileSha256,meshHash:stage.mesh_hash}));
}
export function validateLodIssueSummary(value,target) {
  if (!value || ['jobId','stage','diagnosticFileSha256','meshHash'].some(key=>value[key]!==target[key]) || !Array.isArray(value.items)) throw new Error('诊断来源已改变，请重新打开当前候选。');
  return value;
}
export function lodBlockerLabel(value='') {
  const exact=boundaryFailure(value);if(exact)return exact.message;
  if (/Original boundary distance exceeds|Original boundary perimeter changed|boundary.*(?:loop count changed|Euler characteristic|connected-component count)/i.test(value)) return '已确认边界距离、周长或拓扑不符合要求。';
  if (/boundary.*(budget|certif)/i.test(value)) return '边界认证未完成，尚不能确认达标。';
  if (/intersection/i.test(value)) return '相交检查未通过，请查看当前候选证据。';
  return '当前候选未通过质量检查，请查看诊断详情。';
}
