// Page-side runtime for the green-screen node.
// Jobs stay on /api/video-chroma inside the workbench process. The page commits
// the file through the normal versioned asset channel; the backend does not edit project.json.
import { videoStreamAsset, videoStreamKind } from './video-stream.js';
import { CHROMA_BG, CHROMA_FG, chromaDocumentFromNode, isVideoChroma, normalizePreviewTime } from './video-chroma-document.js';

const ACTIVE = ['queued', 'running'];

async function request(path, body, { signal } = {}) {
  const response = await fetch(`/api/video-chroma${path}`, body === undefined
    ? { credentials: 'same-origin', cache: 'no-store', signal }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.message || `绿幕扣像服务不可用（HTTP ${response.status}）。若刚更新代码，需要重启工作台后端。`);
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}

export const submitVideoChromaJob = (payload) => request('/jobs', payload);
export const getVideoChromaJob = (jobId, options) => request(`/jobs/${encodeURIComponent(jobId)}`, undefined, options);
export const cancelVideoChromaJob = (jobId, projectId) => request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { projectId });
export const commitVideoChromaJob = (jobId, projectId, revision) => request(`/jobs/${encodeURIComponent(jobId)}/commit`, { projectId, revision });
export const previewVideoChroma = (payload) => request('/preview', payload);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }, { once: true });
});

function fileNameFor(source, handle, kind) {
  const fromName = source.data.name || source.data.filename || '';
  if (/\.(png|jpe?g|webp|mp4|mov|webm)$/i.test(fromName)) return fromName;
  const match = String(source.data.url || '').split('?')[0].match(/\.(png|jpe?g|webp|mp4|mov|webm)$/i);
  if (match) return `${handle}${match[0].toLowerCase()}`;
  return kind === 'image' ? `${handle}.png` : `${handle}.mp4`;
}

function settingsPayload(document) {
  return {
    schemaVersion: 1,
    keyColor: document.keyColor,
    similarity: document.similarity,
    blend: document.blend,
    despill: document.despill,
    choke: document.choke,
    feather: document.feather,
    secondKey: document.secondKey,
    secondKeyColor: document.secondKeyColor,
    secondSimilarity: document.secondSimilarity,
    secondBlend: document.secondBlend,
    scale: document.scale,
    offsetX: document.offsetX,
    offsetY: document.offsetY,
    anchor: document.anchor,
    backgroundFit: document.backgroundFit,
    outputSize: document.outputSize,
    audio: document.audio,
    startOffset: document.startOffset,
  };
}

export function createVideoChromaRunner(deps) {
  const node = (id) => deps.getNodes().find((item) => item.id === id);
  const register = (id, controller) => { deps.jobs.set(id, controller); deps.onJobsChange?.(); };
  const unregister = (id, controller) => { if (deps.jobs.get(id) === controller) { deps.jobs.delete(id); deps.onJobsChange?.(); } };

  async function resolvePort(id, handle, signal, { quiet = false } = {}) {
    const edge = deps.getEdges().find((item) => item.target === id && item.targetHandle === handle);
    const source = deps.getNodes().find((item) => item.id === edge?.source);
    const label = handle === CHROMA_FG ? '前景 fg' : '背景 bg';
    if (!source) throw new Error(`请先连接${label}。`);
    const cache = node(id)?.data.chromaInputCache || {};
    const resolved = videoStreamAsset(source, cache);
    if (resolved.needsExport) throw new Error(`请先导出上游「${resolved.needsExport}」。`);
    const kind = videoStreamKind(source) === 'image' ? 'image' : 'video';
    if (resolved.assetPath) return resolved.assetPath;
    if (!resolved.pendingUrl) throw new Error(`「${resolved.missing || label}」还没有可用的文件。`);
    if (!quiet) deps.updateNode(id, { stage: `正在导入${label}到项目素材` });
    const response = await fetch(resolved.pendingUrl.data.url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`无法读取「${resolved.pendingUrl.data.title || label}」。`);
    const blob = await response.blob();
    const file = new File([blob], fileNameFor(resolved.pendingUrl, handle, kind), { type: blob.type || (kind === 'image' ? 'image/png' : 'video/mp4') });
    const saved = await deps.saveCanvasMedia((revision, storageId) => deps.saveProjectFile(storageId, file, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
    if (!saved?.ok) throw new Error(saved?.error?.message || '输入素材保存失败。');
    signal?.throwIfAborted();
    deps.updateNode(id, { chromaInputCache: { ...(node(id)?.data.chromaInputCache || {}), [resolved.pendingUrl.id]: { url: resolved.pendingUrl.data.url, assetPath: saved.assetPath } } });
    return saved.assetPath;
  }

  async function follow(id, jobId, controller) {
    const projectId = deps.getProjectId();
    try {
      for (;;) {
        await sleep(700, controller.signal);
        const job = await getVideoChromaJob(jobId, { signal: controller.signal });
        if (node(id)?.data.chromaJobId !== jobId) return;
        if (ACTIVE.includes(job.status)) { deps.updateNode(id, { status: 'running', stage: job.stage, progress: job.progress }); continue; }
        if (job.status !== 'completed') {
          deps.updateNode(id, { status: job.status === 'cancelled' ? 'cancelled' : 'error', stage: job.stage, error: job.status === 'cancelled' ? null : job.error || '导出失败。' });
          return;
        }
        deps.updateNode(id, { status: 'running', stage: '正在保存到项目素材', progress: 0.99 });
        const saved = await deps.saveCanvasMedia((revision) => commitVideoChromaJob(jobId, projectId, revision), (result) => ({ ok: true, assetPath: result.asset.path }));
        if (!saved?.ok) throw new Error(saved?.error?.message || '成片保存失败。');
        if (node(id)?.data.chromaJobId !== jobId) return;
        deps.updateNode(id, {
          status: 'done', stage: '已导出', progress: 1, error: null,
          chromaResultAssetPath: saved.assetPath, chromaResult: job.result,
          chromaResultSettings: node(id)?.data.chromaSubmittedSettings ?? null, chromaResultJobId: jobId,
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
    controller.signal.addEventListener('abort', () => { cancelVideoChromaJob(jobId, deps.getProjectId()).catch(() => {}); }, { once: true });
    register(id, controller);
    follow(id, jobId, controller);
    return controller;
  }

  return {
    async run(id) {
      const current = node(id);
      if (!isVideoChroma(current)) return { ok: false, error: '找不到绿幕扣像节点。' };
      if (deps.jobs.has(id) || ACTIVE.includes(current.data.status)) return { ok: false, error: '此节点正在导出，请等待或取消。' };
      let document;
      try { document = chromaDocumentFromNode(current.data); }
      catch (error) { deps.updateNode(id, { status: 'error', error: error.message }); return { ok: false, error: error.message }; }
      const preparing = new AbortController();
      register(id, preparing);
      try {
        deps.updateNode(id, { status: 'running', stage: '正在准备素材', progress: 0, error: null });
        const foreground = await resolvePort(id, CHROMA_FG, preparing.signal);
        const background = await resolvePort(id, CHROMA_BG, preparing.signal);
        preparing.signal.throwIfAborted();
        const job = await submitVideoChromaJob({
          projectId: deps.getProjectId(), nodeId: id, foreground, background, settings: settingsPayload(document),
        });
        unregister(id, preparing);
        deps.updateNode(id, { status: 'running', stage: job.stage, progress: job.progress, chromaJobId: job.id, chromaSubmittedSettings: JSON.stringify(document) });
        attach(id, job.id);
        return { ok: true, jobId: job.id };
      } catch (error) {
        unregister(id, preparing);
        const cancelled = preparing.signal.aborted;
        if (node(id)) deps.updateNode(id, { status: cancelled ? 'cancelled' : 'error', stage: cancelled ? '已取消' : '提交失败', error: cancelled ? null : error.message });
        return { ok: false, error: cancelled ? '已取消。' : error.message };
      }
    },
    async preview(id, { mode = 'composite', time } = {}) {
      const current = node(id);
      if (!isVideoChroma(current)) return { ok: false, error: '找不到绿幕扣像节点。' };
      let document;
      let previewTime;
      try {
        document = chromaDocumentFromNode(current.data);
        previewTime = normalizePreviewTime(time ?? current.data.previewTime ?? 0);
      } catch (error) {
        return { ok: false, error: error.message };
      }
      try {
        const foreground = await resolvePort(id, CHROMA_FG, undefined, { quiet: true });
        const background = await resolvePort(id, CHROMA_BG, undefined, { quiet: true });
        const frame = await previewVideoChroma({
          projectId: deps.getProjectId(), nodeId: id, foreground, background,
          settings: settingsPayload(document), time: previewTime, mode,
        });
        return { ok: true, ...frame };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    cancel(id) { deps.jobs.get(id)?.abort(); },
    resume(id) {
      const current = node(id);
      if (!isVideoChroma(current) || deps.jobs.has(id) || !current.data.chromaJobId || !ACTIVE.includes(current.data.status)) return false;
      attach(id, current.data.chromaJobId);
      return true;
    },
  };
}
