// Page-side runtime for the white-model plate.
// SAM3 runs on local ComfyUI inside the workbench job. The page commits the
// file through the versioned asset channel and registers it as a video asset.
import { videoStreamAsset } from './video-stream.js';
import { PLATE_PORT, isVideoPlate, plateDocumentFromNode } from './video-plate-document.js';

const ACTIVE = ['queued', 'running'];

async function request(path, body, { signal } = {}) {
  const response = await fetch(`/api/video-plate${path}`, body === undefined
    ? { credentials: 'same-origin', cache: 'no-store', signal }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.message || `绿幕白模服务不可用（HTTP ${response.status}）。若刚更新代码，需要重启工作台后端。`);
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}

export const submitVideoPlateJob = (payload) => request('/jobs', payload);
export const getVideoPlateJob = (jobId, options) => request(`/jobs/${encodeURIComponent(jobId)}`, undefined, options);
export const cancelVideoPlateJob = (jobId, projectId) => request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { projectId });
export const commitVideoPlateJob = (jobId, projectId, revision) => request(`/jobs/${encodeURIComponent(jobId)}/commit`, { projectId, revision });

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }, { once: true });
});

function fileNameFor(source) {
  const fromName = source.data.name || source.data.filename || '';
  if (/\.(mp4|mov|webm)$/i.test(fromName)) return fromName;
  const match = String(source.data.url || '').split('?')[0].match(/\.(mp4|mov|webm)$/i);
  return match ? `v1${match[0].toLowerCase()}` : 'v1.mp4';
}

function settingsPayload(document) {
  return {
    schemaVersion: 1,
    keepPrompts: document.keepPrompts,
    maskGrow: document.maskGrow,
    maskFeather: document.maskFeather,
    shadeMode: document.shadeMode,
    greenColor: document.greenColor,
  };
}

export function createVideoPlateRunner(deps) {
  const node = (id) => deps.getNodes().find((item) => item.id === id);
  const register = (id, controller) => { deps.jobs.set(id, controller); deps.onJobsChange?.(); };
  const unregister = (id, controller) => { if (deps.jobs.get(id) === controller) { deps.jobs.delete(id); deps.onJobsChange?.(); } };

  async function resolveVideo(id, signal) {
    const edge = deps.getEdges().find((item) => item.target === id && item.targetHandle === PLATE_PORT);
    const source = deps.getNodes().find((item) => item.id === edge?.source);
    if (!source) throw new Error('请先把一段视频连到 v1。');
    const cache = node(id)?.data.plateInputCache || {};
    const resolved = videoStreamAsset(source, cache);
    if (resolved.needsExport) throw new Error(`请先导出上游「${resolved.needsExport}」。`);
    if (resolved.assetPath) return resolved.assetPath;
    if (!resolved.pendingUrl) throw new Error(`「${resolved.missing || '视频'}」还没有可用的文件。`);
    deps.updateNode(id, { stage: '正在导入视频到项目素材' });
    const response = await fetch(resolved.pendingUrl.data.url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`无法读取「${resolved.pendingUrl.data.title || '视频'}」。`);
    const blob = await response.blob();
    const file = new File([blob], fileNameFor(resolved.pendingUrl), { type: blob.type || 'video/mp4' });
    const saved = await deps.saveCanvasMedia((revision, storageId) => deps.saveProjectFile(storageId, file, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
    if (!saved?.ok) throw new Error(saved?.error?.message || '输入素材保存失败。');
    signal?.throwIfAborted();
    deps.updateNode(id, { plateInputCache: { ...(node(id)?.data.plateInputCache || {}), [resolved.pendingUrl.id]: { url: resolved.pendingUrl.data.url, assetPath: saved.assetPath } } });
    return saved.assetPath;
  }

  async function follow(id, jobId, controller) {
    const projectId = deps.getProjectId();
    try {
      for (;;) {
        await sleep(700, controller.signal);
        const job = await getVideoPlateJob(jobId, { signal: controller.signal });
        if (node(id)?.data.plateJobId !== jobId) return;
        if (ACTIVE.includes(job.status)) { deps.updateNode(id, { status: 'running', stage: job.stage, progress: job.progress }); continue; }
        if (job.status !== 'completed') {
          deps.updateNode(id, { status: job.status === 'cancelled' ? 'cancelled' : 'error', stage: job.stage, error: job.status === 'cancelled' ? null : job.error || '导出失败。' });
          return;
        }
        deps.updateNode(id, { status: 'running', stage: '正在保存到项目素材', progress: 0.99 });
        const saved = await deps.saveCanvasMedia((revision) => commitVideoPlateJob(jobId, projectId, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
        if (!saved?.ok) throw new Error(saved?.error?.message || '成片保存失败。');
        if (node(id)?.data.plateJobId !== jobId) return;
        const mediaId = deps.placeResult?.(id, saved.assetPath) || null;
        deps.updateNode(id, {
          status: 'done', stage: '已导出', progress: 1, error: null,
          plateResultAssetPath: saved.assetPath, plateResultNodeId: mediaId, plateResult: job.result,
          plateSubmittedSettings: node(id)?.data.plateSubmittedSettings ?? null, plateResultJobId: jobId,
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
    controller.signal.addEventListener('abort', () => { cancelVideoPlateJob(jobId, deps.getProjectId()).catch(() => {}); }, { once: true });
    register(id, controller);
    follow(id, jobId, controller);
    return controller;
  }

  return {
    async run(id) {
      const current = node(id);
      if (!isVideoPlate(current)) return { ok: false, error: '找不到绿幕白模节点。' };
      if (deps.jobs.has(id) || ACTIVE.includes(current.data.status)) return { ok: false, error: '此节点正在导出，请等待或取消。' };
      let document;
      try { document = plateDocumentFromNode(current.data); }
      catch (error) { deps.updateNode(id, { status: 'error', error: error.message }); return { ok: false, error: error.message }; }
      const preparing = new AbortController();
      register(id, preparing);
      try {
        deps.updateNode(id, { status: 'running', stage: '正在准备素材', progress: 0, error: null });
        const video = await resolveVideo(id, preparing.signal);
        preparing.signal.throwIfAborted();
        const job = await submitVideoPlateJob({
          projectId: deps.getProjectId(), nodeId: id, video, settings: settingsPayload(document),
        });
        unregister(id, preparing);
        deps.updateNode(id, { status: 'running', stage: job.stage, progress: job.progress, plateJobId: job.id, plateSubmittedSettings: JSON.stringify(document) });
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
      if (!isVideoPlate(current) || deps.jobs.has(id) || !current.data.plateJobId || !ACTIVE.includes(current.data.status)) return false;
      attach(id, current.data.plateJobId);
      return true;
    },
  };
}
