// Page-side runtime for constant-speed and time-remap nodes.
// Jobs stay on /api/video-rhythm inside the workbench process. The page commits
// the file through the normal versioned asset channel; the backend does not edit project.json.
import { videoStreamAsset } from './video-stream.js';
import { isVideoRhythm, normalizeRemapDocument, normalizeSpeedDocument } from './video-rhythm-document.js';

const ACTIVE = ['queued', 'running'];

async function request(path, body, { signal } = {}) {
  const response = await fetch(`/api/video-rhythm${path}`, body === undefined
    ? { credentials: 'same-origin', cache: 'no-store', signal }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.message || `视频节奏服务不可用（HTTP ${response.status}）。若刚更新代码，需要重启工作台后端。`);
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}

export const submitVideoRhythmJob = (payload) => request('/jobs', payload);
export const getVideoRhythmJob = (jobId, options) => request(`/jobs/${encodeURIComponent(jobId)}`, undefined, options);
export const cancelVideoRhythmJob = (jobId, projectId) => request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { projectId });
export const commitVideoRhythmJob = (jobId, projectId, revision) => request(`/jobs/${encodeURIComponent(jobId)}/commit`, { projectId, revision });

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }, { once: true });
});

export function rhythmDocument(node) {
  if (node?.type === 'videoSpeed') {
    return normalizeSpeedDocument({ schemaVersion: 1, operation: 'speed', speed: node.data.speed, audio: node.data.rhythmAudio });
  }
  if (node?.type === 'videoTimeRemap') {
    return normalizeRemapDocument({ schemaVersion: 1, operation: 'remap', keyframes: node.data.remapKeyframes });
  }
  throw new Error('找不到视频节奏节点。');
}

export function createVideoRhythmRunner(deps) {
  const node = (id) => deps.getNodes().find((item) => item.id === id);
  const register = (id, controller) => { deps.jobs.set(id, controller); deps.onJobsChange?.(); };
  const unregister = (id, controller) => { if (deps.jobs.get(id) === controller) { deps.jobs.delete(id); deps.onJobsChange?.(); } };

  async function resolveInput(id, signal) {
    const current = node(id);
    const edge = deps.getEdges().find((item) => item.target === id && item.targetHandle === 'v1');
    const source = deps.getNodes().find((item) => item.id === edge?.source);
    if (!source) throw new Error('请先把一段视频连接到 v1。');
    const cache = current?.data.rhythmInputCache || {};
    const resolved = videoStreamAsset(source, cache);
    if (resolved.needsExport) throw new Error(`请先导出上游「${resolved.needsExport}」。`);
    if (resolved.assetPath) return resolved.assetPath;
    if (!resolved.pendingUrl) throw new Error(`「${resolved.missing || '视频'}」还没有可用的视频文件。`);
    deps.updateNode(id, { stage: '正在导入视频到项目素材' });
    const response = await fetch(resolved.pendingUrl.data.url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`无法读取「${resolved.pendingUrl.data.title || '视频'}」。`);
    const blob = await response.blob();
    const file = new File([blob], resolved.pendingUrl.data.name || 'v1.mp4', { type: blob.type || 'video/mp4' });
    const saved = await deps.saveCanvasMedia((revision, storageId) => deps.saveProjectFile(storageId, file, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
    if (!saved?.ok) throw new Error(saved?.error?.message || '输入素材保存失败。');
    signal.throwIfAborted();
    deps.updateNode(id, { rhythmInputCache: { ...(node(id)?.data.rhythmInputCache || {}), [resolved.pendingUrl.id]: { url: resolved.pendingUrl.data.url, assetPath: saved.assetPath } } });
    return saved.assetPath;
  }

  async function follow(id, jobId, controller) {
    const projectId = deps.getProjectId();
    try {
      for (;;) {
        await sleep(700, controller.signal);
        const job = await getVideoRhythmJob(jobId, { signal: controller.signal });
        if (node(id)?.data.rhythmJobId !== jobId) return;
        if (ACTIVE.includes(job.status)) { deps.updateNode(id, { status: 'running', stage: job.stage, progress: job.progress }); continue; }
        if (job.status !== 'completed') {
          deps.updateNode(id, { status: job.status === 'cancelled' ? 'cancelled' : 'error', stage: job.stage, error: job.status === 'cancelled' ? null : job.error || '导出失败。' });
          return;
        }
        deps.updateNode(id, { status: 'running', stage: '正在保存到项目素材', progress: 0.99 });
        const saved = await deps.saveCanvasMedia((revision) => commitVideoRhythmJob(jobId, projectId, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
        if (!saved?.ok) throw new Error(saved?.error?.message || '成片保存失败。');
        if (node(id)?.data.rhythmJobId !== jobId) return;
        deps.updateNode(id, {
          status: 'done', stage: '已导出', progress: 1, error: null,
          rhythmResultAssetPath: saved.assetPath, rhythmResult: job.result,
          rhythmResultSettings: node(id)?.data.rhythmSubmittedSettings ?? null, rhythmResultJobId: jobId,
        });
        await deps.persistProject?.();
        return;
      }
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        if (node(id)) deps.updateNode(id, { status: 'cancelled', stage: '已取消', error: null });
        return;
      }
      if (node(id)) deps.updateNode(id, { status: 'error', stage: '导出失败', error: error.status === 404 ? '后台导出任务已不存在（工作台可能已重启），请重新导出。' : error.message });
    } finally { unregister(id, controller); }
  }

  function attach(id, jobId) {
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => { cancelVideoRhythmJob(jobId, deps.getProjectId()).catch(() => {}); }, { once: true });
    register(id, controller);
    follow(id, jobId, controller);
    return controller;
  }

  return {
    async run(id) {
      const current = node(id);
      if (!isVideoRhythm(current)) return { ok: false, error: '找不到视频节奏节点。' };
      if (deps.jobs.has(id) || ACTIVE.includes(current.data.status)) return { ok: false, error: '此节点正在导出，请等待或取消。' };
      let document;
      try { document = rhythmDocument(current); }
      catch (error) { deps.updateNode(id, { status: 'error', error: error.message }); return { ok: false, error: error.message }; }
      const preparing = new AbortController();
      register(id, preparing);
      try {
        deps.updateNode(id, { status: 'running', stage: '正在准备素材', progress: 0, error: null });
        const input = await resolveInput(id, preparing.signal);
        preparing.signal.throwIfAborted();
        const settings = document.operation === 'speed'
          ? { schemaVersion: 1, speed: document.speed.num / document.speed.den, audio: document.audio }
          : { schemaVersion: 1, keyframes: document.keyframes };
        const job = await submitVideoRhythmJob({ projectId: deps.getProjectId(), nodeId: id, input, operation: document.operation, settings });
        unregister(id, preparing);
        deps.updateNode(id, { status: 'running', stage: job.stage, progress: job.progress, rhythmJobId: job.id, rhythmSubmittedSettings: JSON.stringify(document) });
        attach(id, job.id);
        return { ok: true, jobId: job.id };
      } catch (error) {
        unregister(id, preparing);
        const cancelled = preparing.signal.aborted;
        if (node(id)) deps.updateNode(id, { status: cancelled ? 'cancelled' : 'error', stage: cancelled ? '已取消' : '提交失败', error: cancelled ? null : error.message });
        return { ok: false, error: cancelled ? '已取消。' : error.message };
      }
    },
    cancel(id) { deps.jobs.get(id)?.abort(); },
    resume(id) {
      const current = node(id);
      if (!isVideoRhythm(current) || deps.jobs.has(id) || !current.data.rhythmJobId || !ACTIVE.includes(current.data.status)) return false;
      attach(id, current.data.rhythmJobId);
      return true;
    },
  };
}
