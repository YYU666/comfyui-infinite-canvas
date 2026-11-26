import { cancelVideoRun, hasUnconfirmedVideoSubmission, makeVideoSubmission, observeVideoCancellation, postVideoSubmission, readVideoJob, videoSubmissionError, videoSubmissionPhase } from './video-submission.js';
// CPU jobs only. Asset import and result commit use the page's revision-safe save queue.
import { videoStreamAsset, videoStreamKind } from './video-stream.js';
import { REPAIR_PORT, REPAIR_PREVIEW_MODES, isVideoRepair, normalizeRepairPreviewTime, repairDocumentFromNode, repairSourceSignature } from './video-repair-document.js';

const ACTIVE = ['queued', 'running'];
async function request(path, body, signal) {
  const response = await fetch(`/api/video-repair${path}`, body === undefined
    ? { credentials: 'same-origin', cache: 'no-store', signal }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(value.message || value.error || `局部修复服务不可用（HTTP ${response.status}）。`); error.status = response.status; throw error; }
  return value;
}
const jobPath = id => `/jobs/${encodeURIComponent(id)}`;
const getJob = (id, { signal } = {}) => request(jobPath(id), undefined, signal);
const cancelJob = (id, projectId) => request(`${jobPath(id)}/cancel`, { projectId });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export function createVideoRepairRunner(deps) {
  const node = id => deps.getNodes().find(item => item.id === id);
  const canWrite = () => deps.canWrite?.() !== false;
  const register = (id, controller) => { deps.jobs.set(id, controller); deps.onJobsChange?.(); };
  const unregister = (id, controller) => { if (deps.jobs.get(id) === controller) { deps.jobs.delete(id); deps.onJobsChange?.(); } };
  async function resolveSource(id, signal) {
    const projectId = deps.getProjectId();
    const assertCurrent = () => { signal?.throwIfAborted(); if (deps.getProjectId() !== projectId || !canWrite() || !node(id)) throw new Error('当前画布已改变。'); };
    assertCurrent();
    const inputs = deps.getEdges().filter(item => item.target === id && item.targetHandle === REPAIR_PORT);
    const source = deps.getNodes().find(item => item.id === inputs[0]?.source);
    if (inputs.length !== 1 || videoStreamKind(source) !== 'video') throw new Error('请连接一个视频素材或视频处理成片。');
    const resolved = videoStreamAsset(source, node(id)?.data.repairInputCache || {}, { nodes: deps.getNodes(), edges: deps.getEdges() });
    if (resolved.needsExport) throw new Error(`请先导出上游「${resolved.needsExport}」。`);
    if (resolved.assetPath) return resolved.assetPath;
    if (!resolved.pendingUrl) throw new Error('输入视频还没有可用文件。');
    const response = await fetch(source.data.url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error('无法读取输入视频。');
    const blob = await response.blob();
    assertCurrent();
    const extension = String(source.data.name || source.data.filename || source.data.url).split('?')[0].match(/\.(mp4|mov|webm)$/i)?.[0] || (blob.type.includes('webm') ? '.webm' : '.mp4');
    const file = new File([blob], `repair-input${extension}`, { type: blob.type || 'video/mp4' });
    signal?.throwIfAborted();
    const saved = await deps.saveCanvasMedia((revision, storageId) => { assertCurrent(); return deps.saveProjectFile(storageId, file, revision); }, result => ({ ok: true, assetPath: result.asset.path }));
    if (!saved?.ok) throw new Error(saved?.error?.message || '输入素材保存失败。');
    assertCurrent();
    deps.updateNode(id, { repairInputCache: { ...(node(id)?.data.repairInputCache || {}), [source.id]: { url: source.data.url, assetPath: saved.assetPath } } });
    return saved.assetPath;
  }
  async function follow(id, jobId, projectId, controller) {
    const isCurrent = () => node(id)?.data.repairJobId === jobId && deps.getProjectId() === projectId && canWrite();
    const identity = { id: jobId, intent: { projectId, nodeId: id } };
    try {
      for (;;) {
        await sleep(deps.pollInterval ?? 700, controller.signal);
        if (!isCurrent()) return;
        const job = await readVideoJob(getJob, identity, controller.signal, () => {
          if (isCurrent()) deps.updateNode(id, { stage: '连接波动 · 正在查询原作业' });
        });
        if (controller.signal.aborted || !isCurrent()) return;
        const receipt = videoSubmissionPhase(node(id), jobId, 'accepted');
        if (receipt.videoSubmission) {
          deps.updateNode(id, receipt);
          await deps.persistProject?.().catch(() => {});
        }
        if (ACTIVE.includes(job.status)) { deps.updateNode(id, { status: job.status, stage: job.stage, progress: job.progress, error: null }); continue; }
        if (job.status !== 'completed') {
          deps.updateNode(id, { status: job.status === 'cancelled' ? 'cancelled' : 'error', stage: job.stage, error: job.status === 'cancelled' ? null : job.error || '修复失败。', ...videoSubmissionPhase(node(id), jobId, job.status === 'cancelled' ? 'cancelled' : 'failed') });
          await deps.persistProject?.().catch(() => {});
          return;
        }
        controller.signal.throwIfAborted();
        deps.updateNode(id, { status: 'running', stage: '正在保存到项目素材', progress: 0.99 });
        const saved = await deps.saveCanvasMedia(revision => request(`${jobPath(jobId)}/commit`, { projectId, revision }), result => ({ ok: true, assetPath: result.asset.path }));
        if (!saved?.ok) throw new Error(saved?.error?.message || '修复成片保存失败。');
        controller.signal.throwIfAborted();
        if (node(id)?.data.repairJobId !== jobId || deps.getProjectId() !== projectId || !canWrite()) return;
        const checkpoint = { projectId, nodeId: id, jobId,
          repairResultAssetPath: saved.assetPath, repairResult: job.result,
          repairResultSettings: node(id).data.repairSubmittedSettings,
          repairResultSource: node(id).data.repairSubmittedSource, repairResultJobId: jobId };
        deps.updateNode(id, { status: 'running', stage: '正在确认项目保存', progress: 0.99, repairPendingResult: checkpoint });
        if (!deps.persistProject) throw new Error('项目保存通道不可用。');
        await deps.persistProject();
        controller.signal.throwIfAborted();
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('无法读回项目，修复结果尚未确认保存。');
        const document = await response.json();
        const storedNode = document.canvas?.nodes?.find(item => item.id === id);
        const stored = storedNode?.data?.repairPendingResult;
        if (document.id !== projectId || storedNode?.type !== 'videoLocalRepair' || storedNode?.data?.repairJobId !== jobId
          || !stored || Object.keys(checkpoint).filter(key => key !== 'repairResult').some(key => stored[key] !== checkpoint[key])) throw new Error('项目读回不匹配，修复结果尚未确认保存。');
        controller.signal.throwIfAborted();
        if (node(id)?.data.repairJobId !== jobId || deps.getProjectId() !== projectId || !canWrite()) return;
        // The recoverable checkpoint is durable. Only now expose terminal state and current media.
        const { projectId: _project, nodeId: _node, jobId: _job, ...result } = checkpoint;
        deps.updateNode(id, { ...result, status: 'done', stage: '已修复并保存', progress: 1, error: null,
          repairPendingResult: null, ...videoSubmissionPhase(node(id), jobId, 'completed') });
        await deps.persistProject();
        return;
      }
    } catch (error) {
      if (isCurrent() && !controller.signal.aborted) {
        deps.updateNode(id, { status: 'error', stage: '修复失败', error: error.message, ...videoSubmissionError(node(id), jobId, error) });
        await deps.persistProject?.().catch?.(() => {});
      }
    } finally { unregister(id, controller); }
  }
  function attach(id, jobId, projectId) {
    const controller = new AbortController();
    observeVideoCancellation(controller, {
      cancel: () => cancelJob(jobId, projectId),
      isCurrent: () => node(id)?.data.repairJobId === jobId && deps.getProjectId() === projectId && canWrite(),
      update: (patch) => deps.updateNode(id, patch),
    });
    register(id, controller); void follow(id, jobId, projectId, controller);
    return controller;
  }
  return {
    async run(id, generation = {}) {
      if (!canWrite()) return { ok: false, error: '当前画布不可编辑。' };
      const current = node(id), projectId = deps.getProjectId();
      if (!isVideoRepair(current)) return { ok: false, error: '找不到局部修复节点。' };
      if (!deps.jobs.has(id) && current.data.repairJobId && hasUnconfirmedVideoSubmission(current)) {
        attach(id, current.data.repairJobId, projectId);
        return { ok: false, code: 'VIDEO_SUBMISSION_UNKNOWN', jobId: current.data.repairJobId, error: '正在核对原作业。' };
      }
      if (deps.jobs.has(id) || ACTIVE.includes(current.data.status)) return { ok: false, error: '此节点正在处理，请等待或取消。' };
      const controller = new AbortController();
      register(id, controller);
      let preparation;
      let submitted;
      try {
        const settings = repairDocumentFromNode(current.data);
        const signature = repairSourceSignature(id, deps.getNodes(), deps.getEdges());
        deps.updateNode(id, { status: 'running', stage: '正在准备视频', progress: 0, error: null });
        const source = await resolveSource(id, controller.signal);
        controller.signal.throwIfAborted();
        // Keep the POST response: cancellation during submission must cancel its returned job too.
        preparation = makeVideoSubmission('vrp', { projectId, nodeId: id, source, settings }, generation.page);
        deps.updateNode(id, { stage: '待提交 · 正在保存作业准备记录', videoSubmission: preparation,
          repairJobId: preparation.id, repairSubmittedSettings: JSON.stringify(settings), repairSubmittedSource: signature });
        submitted = await postVideoSubmission(preparation, { persistProject: deps.persistProject,
          current: () => {
            generation.assertActive?.();
            return deps.getProjectId() === projectId && canWrite() && node(id)?.data.videoSubmission?.id === preparation.id;
          },
          signal: controller.signal, submit: payload => request('/jobs', payload), lookup: getJob });
        if (!node(id) || deps.getProjectId() !== projectId || !canWrite()) throw new Error('当前画布已改变。');
        unregister(id, controller);
        deps.updateNode(id, { status: submitted.status, stage: submitted.stage, progress: submitted.progress, ...videoSubmissionPhase(node(id), submitted.id, 'accepted') });
        const attached = attach(id, submitted.id, projectId);
        if (controller.signal.aborted) await cancelVideoRun(attached);
        await deps.persistProject?.().catch(() => {});
        return { ok: true, jobId: submitted.id, status: submitted.status, execution: 'accepted' };
      } catch (error) {
        if (submitted?.id) await cancelJob(submitted.id, projectId).catch(() => {});
        unregister(id, controller);
        const pending = error.code === 'VIDEO_SUBMISSION_UNKNOWN';
        const cancelled = controller.signal.aborted && !pending;
        if (deps.getProjectId() === projectId && canWrite() && node(id)) {
          const phase = pending ? 'unconfirmed' : cancelled ? 'cancelled' : 'rejected';
          deps.updateNode(id, { status: cancelled ? 'cancelled' : 'error', stage: pending ? '原作业未确认' : cancelled ? '已取消' : '提交失败',
            error: cancelled ? null : error.message, ...videoSubmissionPhase(node(id), preparation?.id, phase) });
          if (preparation) await deps.persistProject?.().catch(() => {});
        }
        return { ok: false, ...(pending && { code: error.code, jobId: preparation.id }), error: cancelled ? '已取消。' : error.message };
      }
    },
    async preview(id, { mode = 'original', time } = {}) {
      if (!canWrite()) return { ok: false, error: '当前画布不可编辑。' };
      const current = node(id);
      if (!isVideoRepair(current) || deps.jobs.has(id)) return { ok: false, error: '节点不存在或正在处理。' };
      const controller = new AbortController(), projectId = deps.getProjectId(); register(id, controller);
      try {
        if (!REPAIR_PREVIEW_MODES.includes(mode)) throw new Error('无效的预览模式。');
        const settings = repairDocumentFromNode(current.data), previewTime = normalizeRepairPreviewTime(time ?? current.data.previewTime);
        const source = await resolveSource(id, controller.signal);
        controller.signal.throwIfAborted();
        if (deps.getProjectId() !== projectId || !canWrite()) throw new Error('当前画布已改变。');
        const frame = await request('/preview', { projectId, nodeId: id, source, settings, time: previewTime, mode }, controller.signal);
        controller.signal.throwIfAborted();
        if (deps.getProjectId() !== projectId || !canWrite()) throw new Error('当前画布已改变。');
        return { ok: true, ...frame };
      } catch (error) { return { ok: false, error: controller.signal.aborted ? '已取消预览。' : error.message }; }
      finally { unregister(id, controller); }
    },
    async cancel(id) {
      if (!canWrite()) return { ok: false, error: '当前画布不可编辑。' };
      const controller = deps.jobs.get(id);
      if (controller) return cancelVideoRun(controller);
      const current = node(id);
      if (isVideoRepair(current) && current.data.repairJobId && ACTIVE.includes(current.data.status)) {
        return cancelVideoRun(attach(id, current.data.repairJobId, deps.getProjectId()));
      }
    },
    resume(id) {
      if (!canWrite()) return false;
      const current = node(id);
      if (!isVideoRepair(current) || deps.jobs.has(id) || !current.data.repairJobId) return false;
      const checkpoint = current.data.repairPendingResult;
      const recoverable = checkpoint && checkpoint.projectId === deps.getProjectId() && checkpoint.nodeId === id
        && checkpoint.jobId === current.data.repairJobId
        && checkpoint.repairResultSettings === JSON.stringify(repairDocumentFromNode(current.data))
        && checkpoint.repairResultSource === repairSourceSignature(id, deps.getNodes(), deps.getEdges());
      if (!ACTIVE.includes(current.data.status) && !recoverable && !hasUnconfirmedVideoSubmission(current)) return false;
      attach(id, current.data.repairJobId, deps.getProjectId()); return true;
    },
  };
}
