import { cancelVideoRun, observeVideoCancellation, readVideoJob, hasUnconfirmedVideoSubmission, makeVideoSubmission, postVideoSubmission, videoSubmissionError, videoSubmissionPhase } from './video-submission.js';
// Page-side runtime for the video edit node: talks to /api/video-edit, uploads
// non-project inputs through the page's normal asset channel, and writes the
// result back onto the same node. The backend never edits project.json.
import { normalizeVideoEditDocument, usedVideoEditSlots, videoEditInputs, isVideoEdit } from './video-edit-document.js';

const ACTIVE = ['queued', 'running'];

async function request(path, body, { signal } = {}) {
  const response = await fetch(`/api/video-edit${path}`, body === undefined
    ? { credentials: 'same-origin', cache: 'no-store', signal }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.message || `视频编辑服务不可用（HTTP ${response.status}）。若刚更新代码，需要重启工作台后端。`);
    error.status = response.status; error.code = value.code; error.details = value.details;
    throw error;
  }
  return value;
}

export const probeVideoAsset = (projectId, assetPath, options) => request('/probe', { projectId, assetPath }, options);
export const submitVideoEditJob = (payload) => request('/jobs', payload);
export const getVideoEditJob = (jobId, options) => request(`/jobs/${encodeURIComponent(jobId)}`, undefined, options);
export const cancelVideoEditJob = (jobId, projectId) => request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { projectId });
export const commitVideoEditJob = (jobId, projectId, revision) => request(`/jobs/${encodeURIComponent(jobId)}/commit`, { projectId, revision });

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/**
 * deps: { getProjectId, getNodes, getEdges, updateNode, saveCanvasMedia, persistProject, jobs (Map id->AbortController), onJobsChange }
 */
export function createVideoEditRunner(deps) {
  const canWrite = () => deps.canWrite?.() !== false;
  const node = (id) => deps.getNodes().find((item) => item.id === id);
  const register = (id, controller) => { deps.jobs.set(id, controller); deps.onJobsChange?.(); };
  const unregister = (id, controller) => { if (deps.jobs.get(id) === controller) { deps.jobs.delete(id); deps.onJobsChange?.(); } };

  async function resolveInputs(id, needed, signal) {
    const { inputs, pending } = videoEditInputs(id, deps.getNodes(), deps.getEdges());
    const missing = needed.filter((slot) => !inputs[slot] && !pending[slot]);
    if (missing.length) throw new Error(`请先把素材连接到端口：${missing.join('、')}。`);
    for (const slot of needed.filter((item) => pending[item])) {
      // Generated results live in ComfyUI output; import them once via the page's
      // normal versioned upload so the backend only ever sees project assets.
      const source = pending[slot];
      deps.updateNode(id, { stage: `正在导入 ${slot} 到项目素材` });
      const response = await fetch(source.data.url, { credentials: 'same-origin', signal });
      if (!response.ok) throw new Error(`无法读取「${source.data.title || slot}」。`);
      const blob = await response.blob();
      const file = new File([blob], source.data.name || `${slot}.mp4`, { type: blob.type || 'video/mp4' });
      const saved = await deps.saveCanvasMedia((revision, storageId) => deps.saveProjectFile(storageId, file, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
      if (!saved?.ok) throw new Error(saved?.error?.message || '输入素材保存失败。');
      signal.throwIfAborted();
      inputs[slot] = saved.assetPath;
      deps.updateNode(id, { editInputCache: { ...(node(id)?.data.editInputCache || {}), [source.id]: { url: source.data.url, assetPath: saved.assetPath } } });
    }
    return Object.fromEntries(needed.map((slot) => [slot, inputs[slot]]));
  }

  async function follow(id, jobId, controller) {
    const projectId = deps.getProjectId();
    const current = () => deps.getProjectId() === projectId && canWrite() && node(id)?.data.videoEditJobId === jobId;
    const identity = { id: jobId, intent: { projectId, nodeId: id } };
    try {
      for (;;) {
        await sleep(700, controller.signal);
        if (!current()) return;
        const job = await readVideoJob(getVideoEditJob, identity, controller.signal, () => {
          if (current()) deps.updateNode(id, { stage: '连接波动 · 正在查询原作业' });
        });
        if (!current()) return;
        const receipt = videoSubmissionPhase(node(id), jobId, 'accepted');
        if (receipt.videoSubmission) {
          deps.updateNode(id, receipt);
          await deps.persistProject?.().catch(() => {});
        }
        if (ACTIVE.includes(job.status)) { deps.updateNode(id, { status: job.status, stage: job.stage, progress: job.progress, error: null }); continue; }
        if (job.status !== 'completed') {
          deps.updateNode(id, { status: job.status === 'cancelled' ? 'cancelled' : 'error', stage: job.stage, error: job.status === 'cancelled' ? null : job.error || '导出失败。', ...videoSubmissionPhase(node(id), jobId, job.status === 'cancelled' ? 'cancelled' : 'failed') });
          await deps.persistProject?.().catch(() => {});
          return;
        }
        deps.updateNode(id, { status: 'running', stage: '正在保存到项目素材', progress: 0.99 });
        const saved = await deps.saveCanvasMedia((revision) => commitVideoEditJob(jobId, projectId, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
        if (!saved?.ok) throw new Error(saved?.error?.message || '成片保存失败。');
        if (!current()) return;
        deps.updateNode(id, { status: 'done', stage: '已导出', progress: 1, error: null, ...videoSubmissionPhase(node(id), jobId, 'completed'), editResultAssetPath: saved.assetPath, editResult: job.result, editResultDocument: node(id)?.data.editSubmittedDocument ?? null, editResultJobId: jobId });
        await deps.persistProject?.();
        return;
      }
    } catch (error) {
      if (!current() || controller.signal.aborted) return;
      deps.updateNode(id, { status: 'error', stage: '导出失败', error: error.status === 404 ? '后台导出任务已不存在（工作台可能已重启）。' : error.message, ...videoSubmissionError(node(id), jobId, error) });
      await deps.persistProject?.().catch(() => {});
    } finally { unregister(id, controller); }
  }

  function attach(id, jobId) {
    const controller = new AbortController();
    const projectId = deps.getProjectId();
    observeVideoCancellation(controller, {
      cancel: () => cancelVideoEditJob(jobId, projectId),
      isCurrent: () => deps.getProjectId() === projectId && canWrite() && node(id)?.data.videoEditJobId === jobId,
      update: (patch) => deps.updateNode(id, patch),
    });
    register(id, controller);
    follow(id, jobId, controller);
    return controller;
  }

  return {
    isBusy: (id) => deps.jobs.has(id),
    async run(id, generation = {}) {
      if (!canWrite()) return { ok: false, error: '当前画布不可编辑。' };
      const current = node(id);
      if (!isVideoEdit(current)) return { ok: false, error: '找不到视频编辑节点。' };
      if (!deps.jobs.has(id) && current.data.videoEditJobId && hasUnconfirmedVideoSubmission(current)) {
        attach(id, current.data.videoEditJobId);
        return { ok: false, code: 'VIDEO_SUBMISSION_UNKNOWN', jobId: current.data.videoEditJobId, error: '正在核对原作业。' };
      }
      if (deps.jobs.has(id) || ACTIVE.includes(current.data.status)) return { ok: false, error: '此节点正在导出，请等待或取消。' };
      const projectId = deps.getProjectId();
      let document;
      try { document = normalizeVideoEditDocument(current.data.editDocument); }
      catch (error) { deps.updateNode(id, { status: 'error', error: error.message }); return { ok: false, error: error.message }; }
      const preparing = new AbortController();
      register(id, preparing);
      let preparation;
      let submittedJobId;
      try {
        deps.updateNode(id, { status: 'running', stage: '正在准备素材', progress: 0, error: null });
        const inputs = await resolveInputs(id, usedVideoEditSlots(document), preparing.signal);
        preparing.signal.throwIfAborted();
        preparation = makeVideoSubmission('ved', { projectId, nodeId: id, inputs, document }, generation.page);
        deps.updateNode(id, { stage: '待提交 · 正在保存作业准备记录', videoSubmission: preparation,
          videoEditJobId: preparation.id, editSubmittedDocument: JSON.stringify(document) });
        const job = await postVideoSubmission(preparation, { persistProject: deps.persistProject,
          current: () => {
            generation.assertActive?.();
            return deps.getProjectId() === projectId && canWrite() && node(id)?.data.videoSubmission?.id === preparation.id;
          },
          signal: preparing.signal, submit: submitVideoEditJob, lookup: getVideoEditJob });
        submittedJobId = job.id;
        if (deps.getProjectId() !== projectId || !canWrite() || !node(id)) throw new Error('当前画布已改变。');
        unregister(id, preparing);
        deps.updateNode(id, { status: ACTIVE.includes(job.status) ? job.status : 'running', stage: job.stage, progress: job.progress, error: null, ...videoSubmissionPhase(node(id), job.id, 'accepted') });
        const observer = attach(id, job.id);
        if (preparing.signal.aborted) {
          await cancelVideoRun(observer);
          return { ok: false, jobId: job.id, error: '已请求取消，正在查询后台终态。' };
        }
        return { ok: true, jobId: job.id };
      } catch (error) {
        if (submittedJobId) await cancelVideoEditJob(submittedJobId, projectId).catch(() => {});
        unregister(id, preparing);
        const pending = error.code === 'VIDEO_SUBMISSION_UNKNOWN';
        const cancelled = preparing.signal.aborted && !pending;
        if (deps.getProjectId() === projectId && canWrite() && node(id)
            && (!preparation || node(id).data.videoSubmission?.id === preparation.id)) {
          const phase = pending ? 'unconfirmed' : cancelled ? 'cancelled' : 'rejected';
          deps.updateNode(id, { status: cancelled ? 'cancelled' : 'error', stage: pending ? '原作业未确认' : cancelled ? '已取消' : '提交失败',
            error: cancelled ? null : error.message, ...videoSubmissionPhase(node(id), preparation?.id, phase) });
          if (preparation) await deps.persistProject?.().catch(() => {});
        }
        return { ok: false, ...(pending && { code: error.code, jobId: preparation.id }), error: cancelled ? '已取消。' : error.message };
      }
    },
    cancel(id) { if (canWrite()) return cancelVideoRun(deps.jobs.get(id)); },
    async prepare(id) {
      // Import every connected generated result into project assets (no export).
      if (deps.jobs.has(id)) throw new Error('此节点正在导出。');
      const controller = new AbortController();
      register(id, controller);
      try {
        const { inputs, pending } = videoEditInputs(id, deps.getNodes(), deps.getEdges());
        const resolved = await resolveInputs(id, [...Object.keys(inputs), ...Object.keys(pending)], controller.signal);
        deps.updateNode(id, { stage: '素材已导入' });
        await deps.persistProject?.();
        return resolved;
      } finally { unregister(id, controller); }
    },
    resume(id) {
      if (!canWrite()) return false;
      const current = node(id);
      if (!isVideoEdit(current) || deps.jobs.has(id) || !current.data.videoEditJobId || (!ACTIVE.includes(current.data.status) && !hasUnconfirmedVideoSubmission(current))) return false;
      attach(id, current.data.videoEditJobId);
      return true;
    },
  };
}
