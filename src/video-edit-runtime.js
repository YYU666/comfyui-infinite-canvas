import { getVisibleGenerationPage } from './canvas-current-page.js';
import { videoExportPreviewPatch } from './video-export-preview.js';
import { cancelVideoRun, observeVideoCancellation, readVideoJob, hasUnconfirmedVideoSubmission, makeVideoSubmission, postVideoSubmission, videoSubmissionError, videoSubmissionPhase } from './video-submission.js';
// Page-side runtime for the video edit node: talks to /api/video-edit, uploads
// non-project inputs through the page's normal asset channel, and writes the
// result back onto the same node. The backend never edits project.json.
import { normalizeVideoEditDocument, usedVideoEditSlots, videoEditInputs, isVideoEdit } from './video-edit-document.js';

const ACTIVE = ['queued', 'running'];

async function request(path, body, { signal, keepalive = false } = {}) {
  const response = await fetch(`/api/video-edit${path}`, body === undefined
    ? { credentials: 'same-origin', cache: 'no-store', signal }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, keepalive });
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
export const cancelVideoEditJob = (jobId, projectId, options) => request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { projectId }, options);
export const commitVideoEditJob = (jobId, projectId, revision) => request(`/jobs/${encodeURIComponent(jobId)}/commit`, { projectId, revision });
const openMotionRequest = (action, payload, options) => request(`/openmotion/${action}`, payload, options);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
});

export const submitVideoAnalysis = (payload) => request('/auto-cut', payload);

/**
 * deps: { getProjectId, getNodes, getEdges, updateNode, saveCanvasMedia, persistProject, jobs (Map id->AbortController), onJobsChange }
 */
export function createVideoEditRunner(deps) {
  const node = (id) => deps.getNodes().find((item) => item.id === id);
  const canWrite = () => deps.canWrite?.() !== false;
  const currentProject = projectId => deps.getProjectId() === projectId && canWrite();
  const register = (id, controller) => { deps.jobs.set(id, controller); deps.onJobsChange?.(); };
  const unregister = (id, controller) => { if (deps.jobs.get(id) === controller) { deps.jobs.delete(id); deps.onJobsChange?.(); } };

  async function resolveInputs(id, needed, signal) {
    const projectId = deps.getProjectId();
    const assertCurrent = () => { signal?.throwIfAborted(); if (deps.getProjectId() !== projectId || !canWrite() || !node(id)) throw new Error('当前画布已改变。'); };
    assertCurrent();
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
    assertCurrent();
      const file = new File([blob], source.data.name || `${slot}.mp4`, { type: blob.type || 'video/mp4' });
      const saved = await deps.saveCanvasMedia((revision, storageId) => { assertCurrent(); return deps.saveProjectFile(storageId, file, revision); }, (result) => ({ ok: true, assetPath: result.asset.path }));
      if (!saved?.ok) throw new Error(saved?.error?.message || '输入素材保存失败。');
      assertCurrent();
      inputs[slot] = saved.assetPath;
      deps.updateNode(id, { editInputCache: { ...(node(id)?.data.editInputCache || {}), [source.id]: { url: source.data.url, assetPath: saved.assetPath } } });
    }
    return Object.fromEntries(needed.map((slot) => [slot, inputs[slot]]));
  }

  async function follow(id, jobId, controller) {
    const projectId = deps.getProjectId();
    const isCurrent = () => currentProject(projectId) && node(id)?.data.videoEditJobId === jobId;
    const identity = { id: jobId, intent: { projectId, nodeId: id } };
    try {
      for (;;) {
        await sleep(700, controller.signal);
        if (!isCurrent()) return;
        const job = await readVideoJob(getVideoEditJob, identity, controller.signal, () => {
          if (isCurrent()) deps.updateNode(id, { stage: '连接波动 · 正在查询原作业' });
        });
        if (controller.signal.aborted || !isCurrent()) return;
        const receipt = videoSubmissionPhase(node(id), jobId, 'accepted');
        if (receipt.videoSubmission) {
          deps.updateNode(id, receipt);
          await deps.persistProject?.().catch(() => {});
        }
        if (ACTIVE.includes(job.status)) { deps.updateNode(id, { status: job.status, stage: job.stage, progress: job.progress, error: null, ...videoExportPreviewPatch(job) }); continue; }
        if (job.status !== 'completed') {
          deps.updateNode(id, { status: job.status === 'cancelled' ? 'cancelled' : 'error', stage: job.stage, error: job.status === 'cancelled' ? null : job.error || '导出失败。', ...videoSubmissionPhase(node(id), jobId, job.status === 'cancelled' ? 'cancelled' : 'failed') });
          await deps.persistProject?.().catch(() => {});
          return;
        }
        deps.updateNode(id, { status: 'running', stage: '正在保存到项目素材', progress: 0.99, previewFrame: null });
        const saved = await deps.saveCanvasMedia((revision) => commitVideoEditJob(jobId, projectId, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
        if (!saved?.ok) throw new Error(saved?.error?.message || '成片保存失败。');
        if (controller.signal.aborted || !currentProject(projectId) || node(id)?.data.videoEditJobId !== jobId) return;
        deps.updateNode(id, { status: 'done', stage: '已导出', progress: 1, error: null, ...videoSubmissionPhase(node(id), jobId, 'completed'), editResultAssetPath: saved.assetPath, editResult: job.result, editResultDocument: node(id)?.data.editSubmittedDocument ?? null, editResultJobId: jobId });
        await deps.persistProject?.();
        return;
      }
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return;
      deps.updateNode(id, { status: 'error', stage: '导出失败', error: error.message, ...videoSubmissionError(node(id), jobId, error) });
      await deps.persistProject?.().catch(() => {});
    } finally { unregister(id, controller); }
  }

  function attach(id, jobId) {
    const projectId = deps.getProjectId();
    const controller = new AbortController();
    observeVideoCancellation(controller, {
      cancel: () => cancelVideoEditJob(jobId, projectId),
      isCurrent: () => currentProject(projectId) && node(id)?.data.videoEditJobId === jobId,
      update: (patch) => deps.updateNode(id, patch),
    });
    register(id, controller);
    follow(id, jobId, controller);
    return controller;
  }

  async function setAnalysisPhase(id, record, phase, job) {
    const saved = node(id)?.data.videoAnalysisSubmission;
    if (!currentProject(record.intent.projectId) || saved?.id !== record.id) return;
    const next = { ...saved, phase, ...(job && { stage: job.stage, progress: job.progress }) };
    if (saved.phase === next.phase && saved.stage === next.stage && saved.progress === next.progress) return;
    deps.updateNode(id, { videoAnalysisSubmission: next });
    if (saved.phase !== phase) await deps.persistProject?.().catch(() => {});
  }

  async function startAnalysis(id, inputs, signal, generation = {}) {
    const projectId = deps.getProjectId();
    if (!currentProject(projectId) || !isVideoEdit(node(id)) || deps.jobs.has(id)) throw new Error('当前视频节点不可分析。');
    const intent = { slot: inputs.slot, assetPath: inputs.assetPath, mode: inputs.mode, projectId, nodeId: id };
    const saved = node(id).data.videoAnalysisSubmission;
    if (['prepared', 'accepted', 'unconfirmed'].includes(saved?.phase)) {
      if (Object.keys(intent).some(key => saved.intent?.[key] !== intent[key])) throw new Error('请先核对原素材的分析任务。');
      const job = await readVideoJob(getVideoEditJob, saved, signal, () => {});
      return { record: saved, job };
    }
    const record = makeVideoSubmission('ved', intent, generation.page || getVisibleGenerationPage(projectId));
    deps.updateNode(id, { videoAnalysisJobId: record.id, videoAnalysisSubmission: record });
    try {
      const job = await postVideoSubmission(record, { persistProject: deps.persistProject, signal,
        current: () => {
          generation.assertActive?.();
          return currentProject(projectId) && node(id)?.data.videoAnalysisJobId === record.id;
        }, submit: submitVideoAnalysis, lookup: getVideoEditJob });
      await setAnalysisPhase(id, record, 'accepted', job);
      return { record, job };
    } catch (error) {
      await setAnalysisPhase(id, record, error.code === 'VIDEO_SUBMISSION_UNKNOWN' ? 'unconfirmed' : signal.aborted ? 'cancelled' : 'rejected');
      throw error;
    }
  }

  return {
    isBusy: (id) => deps.jobs.has(id),
    startAnalysis,
    updateAnalysisPhase(id, job) {
      const record = node(id)?.data.videoAnalysisSubmission;
      if (record?.id !== job.id) return;
      return setAnalysisPhase(id, record, ACTIVE.includes(job.status) ? 'accepted' : job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : 'failed', job);
    },
    async cancelAnalysis(id) {
      const record = node(id)?.data.videoAnalysisSubmission;
      if (!record || !currentProject(record.intent.projectId)) return;
      await cancelVideoEditJob(record.id, record.intent.projectId);
    },
    async resumeAnalysis(id, signal) {
      const record = node(id)?.data.videoAnalysisSubmission;
      if (!record || !['prepared', 'accepted', 'unconfirmed'].includes(record.phase)) return;
      try {
        while (currentProject(record.intent.projectId) && node(id)?.data.videoAnalysisJobId === record.id) {
          const job = await readVideoJob(getVideoEditJob, record, signal, () => {});
          const active = ACTIVE.includes(job.status);
          await setAnalysisPhase(id, record, active ? 'accepted' : job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : 'failed', job);
          if (!active) return;
          await sleep(700, signal);
        }
      } catch (error) {
        if (!signal.aborted) await setAnalysisPhase(id, record, 'unconfirmed');
      }
    },
    async analyze(id, inputs, signal) {
      const { record, job: accepted } = await startAnalysis(id, inputs, signal);
      const current = () => currentProject(record.intent.projectId) && node(id)?.data.videoAnalysisJobId === record.id;
      try {
        let job = accepted;
        while (ACTIVE.includes(job.status)) {
          await sleep(500, signal);
          job = await readVideoJob(getVideoEditJob, record, signal, () => {});
          if (!current()) throw new Error('当前画布已改变。');
          if (ACTIVE.includes(job.status)) await setAnalysisPhase(id, record, 'accepted', job);
        }
        await setAnalysisPhase(id, record, job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : 'failed', job);
        if (job.status === 'completed') return job.result;
        throw new Error(job.error || job.stage || '素材分析失败。');
      } catch (error) {
        if (!signal.aborted && (error.status === 404 || error.status >= 500)) {
          await setAnalysisPhase(id, record, 'unconfirmed');
        }
        throw error;
      }
    },
    async openMotion(id, action, options) {
      const projectId = deps.getProjectId();
      const current = node(id);
      if (!isVideoEdit(current)) throw new Error('找不到视频编辑节点。');
      if (action === 'inspect') return openMotionRequest(action, { projectId, nodeId: id });
      if (!canWrite() || deps.jobs.has(id)) throw new Error('当前节点不可编辑或正在处理其他任务。');
      const controller = new AbortController();
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        if (!currentProject(projectId) || !node(id)) throw new Error('当前画布已改变。');
      };
      register(id, controller);
      try {
        await deps.persistProject?.();
        assertCurrent();
        const identity = { projectId, nodeId: id };
        if (action === 'import') {
          const saved = await deps.saveCanvasMedia((revision) => {
            assertCurrent();
            return openMotionRequest('import', { ...identity, exportId: options.exportId, revision });
          }, (result) => ({ ok: true, assetPath: result.asset.path }), id);
          if (!saved?.ok) throw new Error(saved?.error?.message || 'OpenMotion 成片未保存。');
          assertCurrent();
          deps.updateNode(id, { openMotion: { ...node(id).data.openMotion, exportId: options.exportId, resultAssetPath: saved.assetPath } });
          await deps.persistProject?.();
          return saved;
        }
        const assetPath = node(id).data.editResultAssetPath;
        const payload = action === 'create' ? { ...identity, assetPath } : { ...identity, ...options };
        const result = await openMotionRequest(action, payload);
        assertCurrent();
        if (action === 'create' || action === 'link') {
          if (action === 'create' && assetPath !== node(id).data.editResultAssetPath) throw new Error('节点成片已变化，请重新选择。');
          const previous = node(id).data.openMotion;
          const matching = previous?.remoteProjectId === result.remoteProjectId && previous.origin === result.origin;
          deps.updateNode(id, { openMotion: { ...(matching ? previous : {}), remoteProjectId: result.remoteProjectId, origin: result.origin,
            title: result.title, sourceAssetPath: action === 'create' ? assetPath : matching ? previous.sourceAssetPath : null } });
          await deps.persistProject?.();
        }
        return result;
      } finally { unregister(id, controller); }
    },
    async run(id, generation = {}) {
      if (!canWrite()) return { ok: false, error: '当前画布不可编辑。' };
      const projectId = deps.getProjectId();
      const current = node(id);
      if (!isVideoEdit(current)) return { ok: false, error: '找不到视频编辑节点。' };
      if (!deps.jobs.has(id) && current.data.videoEditJobId && hasUnconfirmedVideoSubmission(current)) {
        attach(id, current.data.videoEditJobId);
        return { ok: false, code: 'VIDEO_SUBMISSION_UNKNOWN', jobId: current.data.videoEditJobId, error: '正在核对原作业。' };
      }
      if (deps.jobs.has(id) || ACTIVE.includes(current.data.status)) return { ok: false, error: '此节点正在导出，请等待或取消。' };
      let document;
      try { document = normalizeVideoEditDocument(current.data.editDocument); }
      catch (error) { deps.updateNode(id, { status: 'error', error: error.message }); return { ok: false, error: error.message }; }
      const preparing = new AbortController();
      register(id, preparing);
      let preparation;
      let submittedJobId = null;
      try {
        deps.updateNode(id, { status: 'running', stage: '正在准备素材', progress: 0, error: null });
        const inputs = await resolveInputs(id, usedVideoEditSlots(document), preparing.signal);
        preparing.signal.throwIfAborted();
        if (!currentProject(projectId) || !node(id)) throw new Error('当前画布已改变。');
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
        if (!currentProject(projectId) || !node(id)) throw new Error('当前画布已改变。');
        unregister(id, preparing);
        deps.updateNode(id, { status: job.status, stage: job.stage, progress: job.progress, ...videoSubmissionPhase(node(id), job.id, 'accepted') });
        const attached = attach(id, job.id);
        if (preparing.signal.aborted) await cancelVideoRun(attached);
        await deps.persistProject?.().catch(() => {});
        return { ok: true, jobId: job.id, status: job.status, execution: 'accepted' };
      } catch (error) {
        if (submittedJobId) await cancelVideoEditJob(submittedJobId, projectId).catch(() => {});
        unregister(id, preparing);
        const pending = error.code === 'VIDEO_SUBMISSION_UNKNOWN';
        const cancelled = preparing.signal.aborted && !pending;
        if (deps.getProjectId() === projectId && canWrite() && node(id)) {
          const phase = pending ? 'unconfirmed' : cancelled ? 'cancelled' : 'rejected';
          deps.updateNode(id, { status: cancelled ? 'cancelled' : 'error', stage: pending ? '原作业未确认' : cancelled ? '已取消' : '提交失败',
            error: cancelled ? null : error.message, ...videoSubmissionPhase(node(id), preparation?.id, phase) });
          if (preparation) await deps.persistProject?.().catch(() => {});
        }
        return { ok: false, ...(pending && { code: error.code, jobId: preparation.id }), error: cancelled ? '已取消。' : error.message };
      }
    },
    cancel(id) { return cancelVideoRun(deps.jobs.get(id)); },
    async prepare(id) {
      if (!canWrite()) throw new Error('当前画布不可编辑。');
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
