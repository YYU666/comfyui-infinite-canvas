const ACTIVE_STATES = new Set(['queued', 'running', 'finishing']);

/** Map one persisted backend job onto a generator without regressing newer runtime state. */
export function queueJobAction(node, job) {
  if (!node || !job) return null;
  if (node.data.queueJobId && node.data.queueJobId !== job.id) return null;
  const active = ACTIVE_STATES.has(job.status);
  if (!node.data.queueJobId && !active && node.data.promptId !== job.comfyPromptId) return null;
  if (active && ['done', 'cancelled'].includes(node.data.status) && node.data.promptId === job.comfyPromptId) return null;

  const identity = { queueJobId: job.id, promptId: job.comfyPromptId || node.data.promptId || null };
  const progress = Number.isFinite(job.progress) ? job.progress : node.data.progress || 0;
  if (job.status === 'queued') return { type: 'patch', patch: { ...identity, status: 'queued', stage: job.stage || '后台队列等待中', progress, error: null } };
  if (job.status === 'running') {
    // Keep the richer ComfyUI socket stage/progress when a poll adds no new information.
    if (node.data.status === 'running' && node.data.queueJobId === job.id && node.data.promptId === job.comfyPromptId && !(job.progress > node.data.progress)) return null;
    return { type: 'patch', patch: { ...identity, status: 'running', stage: job.stage || (job.comfyPromptId ? '本地 GPU 生成中' : '正在提交 ComfyUI'), progress: Math.max(progress, node.data.progress || 0), error: null } };
  }
  if (job.status === 'finishing') return { type: 'patch', patch: { ...identity, status: 'finishing', stage: job.stage || '正在读取生成结果', progress, error: null } };
  if (job.status === 'done' && job.comfyPromptId && job.history) return { type: 'complete', promptId: job.comfyPromptId, history: job.history };
  if (job.status === 'error') return { type: 'patch', patch: { ...identity, status: 'error', stage: '生成失败', error: job.error?.message || String(job.error || '后台生成失败，请查看诊断信息。') } };
  if (job.status === 'cancelled') return { type: 'patch', patch: { ...identity, status: 'cancelled', stage: '已取消', progress: 0, error: null } };
  return null;
}
