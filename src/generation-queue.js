const ACTIVE_STATES = new Set(['queued', 'running', 'finishing']);

export function takeOutputIdentity({ projectId, shotId, jobId, attempt = 1, promptId, output }) {
  return JSON.stringify([projectId, shotId, jobId || promptId, attempt, promptId, output?.filename, output?.subfolder || '', output?.type || 'output']);
}

export function comfyExternalAsset(output) {
  return `comfy://view?${new URLSearchParams({ filename: output?.filename || '', subfolder: output?.subfolder || '', type: output?.type || 'output' })}`;
}

/** A revision conflict defers Take registration, not the completed GPU output. */
export async function resolveCanvasCompletion({ shotId, pinResultToCanvas, output, persistProject, registerTake }) {
  let takePending = false;
  let deferredRegistration = false;
  if (shotId) {
    try {
      await persistProject();
      await registerTake();
    } catch (error) {
      if (error.code !== 'REVISION_CONFLICT' && error.status !== 409 && error.code !== 'SAVE_DEFERRED') throw error;
      takePending = true;
      deferredRegistration = error.code === 'SAVE_DEFERRED';
    }
  }
  return {
    deferredRegistration,
    pinMedia: !shotId || Boolean(pinResultToCanvas) || takePending,
    patch: {
      status: 'done', progress: 100, resultUrl: output.url, error: null, takePending,
      stage: takePending ? '已生成，待同步／待登记 Take' : shotId ? '已加入 Take 栈' : '生成完成',
    },
  };
}

export function queueOwnsCompletion(node) {
  return Boolean(node?.data?.queueJobId);
}

export function queueOwnsStage(node) {
  return queueOwnsCompletion(node) && node.data.mode === 'outfitEdit';
}

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
  if (job.status === 'done' && job.comfyPromptId && job.history) return { type: 'complete', promptId: job.comfyPromptId, history: job.history, attempt: job.attempts || 1 };
  if (job.status === 'error') return { type: 'patch', patch: { ...identity, status: 'error', stage: '生成失败', error: job.error?.message || String(job.error || '后台生成失败，请查看诊断信息。') } };
  if (job.status === 'cancelled') return { type: 'patch', patch: { ...identity, status: 'cancelled', stage: '已取消', progress: 0, error: null } };
  return null;
}
