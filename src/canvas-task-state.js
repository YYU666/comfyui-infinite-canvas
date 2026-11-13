// Which nodes may keep the user inside a project, and how saved "running"
// statuses are brought back in line with a real job. ComfyUI progress events
// are matched by prompt id; a missing id used to compare equal to every node
// that never stored one, so one sampling update marked media, notes and edit
// nodes as running and the launcher stayed disabled.

export const ACTIVE_TASK_STATUSES = Object.freeze(['uploading', 'queued', 'running', 'finishing', 'optimizing']);

const ACTIVE = new Set(ACTIVE_TASK_STATUSES);
const LOCAL_TASK_TYPES = new Set(['prompt', 'imageProcess', 'artDirector']);
const PASSIVE_TYPES = new Set(['media', 'note', 'image', 'video']);
const EXPORT_TYPES = new Set(['videoEdit', 'videoSpeed', 'videoTimeRemap', 'videoChromaKey', 'videoWhitePlate']);
const TASK_TYPES = new Set(['generator', ...LOCAL_TASK_TYPES, ...EXPORT_TYPES]);
const EXPORT_JOB_ID = /^(?:ved|vry|vck|vwp)_[a-f0-9]{32}$/;
const GENERATOR_STAGE = /基础采样|采精修|准备参考素材与模型|生成画面与声音|保存 MP4|读取成片|读取生成结果|本地 GPU 生成中|正在提交 ComfyUI/;

const EXPORT_JOB_SOURCES = [
  { types: ['videoEdit'], field: 'videoEditJobId', route: '/api/video-edit/jobs/' },
  { types: ['videoSpeed', 'videoTimeRemap'], field: 'rhythmJobId', route: '/api/video-rhythm/jobs/' },
  { types: ['videoChromaKey'], field: 'chromaJobId', route: '/api/video-chroma/jobs/' },
  { types: ['videoWhitePlate'], field: 'plateJobId', route: '/api/video-plate/jobs/' },
];

const MISSING_RUN_ERROR = '后台任务已不存在（工作台可能已重启），请重新运行。';
const MISSING_EXPORT_ERROR = '后台导出任务已不存在（工作台可能已重启），请重新导出。';

export function isActiveTaskStatus(status) {
  return ACTIVE.has(status);
}

export function isGeneratorStage(stage) {
  return typeof stage === 'string' && GENERATOR_STAGE.test(stage);
}

export function isTaskNode(node) {
  return TASK_TYPES.has(node?.type);
}

/** Launcher lock: in-memory flights, plus task nodes that are still marked active. */
export function canvasHasActiveTask(nodes, { pureRefBusy = false, videoImportBusy = false, localImageJobs = 0 } = {}) {
  if (pureRefBusy || videoImportBusy || localImageJobs > 0) return true;
  return (nodes || []).some((node) => isTaskNode(node) && isActiveTaskStatus(node.data?.status));
}

/**
 * Progress and executing events name one ComfyUI prompt. Only the generator
 * that submitted it is updated. A missing id must not match every node whose
 * promptId was never set.
 */
export function promptEventTargets(nodes, promptId) {
  if (typeof promptId !== 'string' || !promptId) return [];
  return (nodes || []).filter((node) => node?.type === 'generator' && node.data?.promptId === promptId);
}

export function promptProgressPatch(data = {}) {
  const refinePass = String(data.node || '').match(/^refine_sample_(\d+)$/)?.[1];
  const value = Number.isFinite(data.value) ? data.value : 0;
  const max = Number.isFinite(data.max) ? data.max : 0;
  return {
    status: 'running',
    progress: max ? Math.round(value / max * 100) : 0,
    stage: `${refinePass ? `第 ${refinePass} 采精修` : '基础采样'} ${value}/${max} 步`,
  };
}

export function promptExecutingPatch(data = {}) {
  if (!data.node) return { status: 'finishing', stage: '正在读取成片', progress: 100, done: true };
  const refinePass = String(data.node).match(/^refine_sample_(\d+)$/)?.[1];
  const stage = refinePass ? `正在第 ${refinePass} 采精修`
    : data.node === 'sample' ? '正在基础采样'
      : String(data.node).startsWith('save') ? '正在保存 MP4 对照'
        : data.node === '12' ? '正在生成画面与声音'
          : data.node === '16' ? '正在保存 MP4'
            : '正在准备参考素材与模型';
  return { status: 'running', stage };
}

export function backingJobId(node) {
  const data = node?.data || {};
  if (node?.type === 'generator') {
    if (typeof data.queueJobId === 'string' && data.queueJobId) return data.queueJobId;
    if (typeof data.promptId === 'string' && data.promptId) return data.promptId;
    return null;
  }
  const source = EXPORT_JOB_SOURCES.find((item) => item.types.includes(node?.type));
  const id = source ? data[source.field] : null;
  return typeof id === 'string' && EXPORT_JOB_ID.test(id) ? id : null;
}

export function exportJobRequest(node) {
  const source = EXPORT_JOB_SOURCES.find((item) => item.types.includes(node?.type));
  const id = backingJobId(node);
  if (!source || !id || node?.type === 'generator') return null;
  return { id, url: `${source.route}${encodeURIComponent(id)}` };
}

function interruptionError(node) {
  if (typeof node.data?.error === 'string' && node.data.error.trim()) return node.data.error;
  return EXPORT_TYPES.has(node?.type) ? MISSING_EXPORT_ERROR : MISSING_RUN_ERROR;
}

function missingJobPatch(node) {
  return {
    status: 'error',
    progress: 0,
    stage: EXPORT_TYPES.has(node.type) ? '导出失败' : '任务已中断',
    error: interruptionError(node),
  };
}

function hasExportResult(node) {
  const data = node?.data || {};
  return Boolean(data.editResultAssetPath || data.rhythmResultAssetPath || data.chromaResultAssetPath || data.plateResultAssetPath);
}

/** Saved canvas: drop active statuses that cannot belong to a live job. */
export function settleSavedNode(node) {
  if (!node?.data || !isActiveTaskStatus(node.data.status)) return node;
  const data = node.data;
  if (LOCAL_TASK_TYPES.has(node.type)) {
    return {
      ...node,
      data: { ...data, status: 'idle', progress: 0, ...(isGeneratorStage(data.stage) ? { stage: '' } : {}) },
    };
  }
  if (PASSIVE_TYPES.has(node.type)) {
    return { ...node, data: { ...data, status: 'idle', progress: 0, stage: '' } };
  }
  if (typeof data.error === 'string' && data.error.includes('已不存在')) {
    return { ...node, data: { ...data, ...missingJobPatch(node), error: data.error } };
  }
  if (isTaskNode(node) && !backingJobId(node)) return { ...node, data: { ...data, ...missingJobPatch(node) } };
  return node;
}

export function classifyExportJob(responseStatus, job) {
  if (responseStatus === 404) return { state: 'missing' };
  if (responseStatus !== 200) return { state: 'unknown' };
  const status = job?.status;
  if (status === 'queued' || status === 'running') return { state: 'live', job };
  if (status === 'completed' || status === 'done' || status === 'cancelled' || status === 'error') return { state: 'terminal', job };
  return { state: 'unknown' };
}

export function exportLookupPatch(node, outcome) {
  if (!node || !isActiveTaskStatus(node.data?.status) || !outcome || outcome.state === 'unknown' || outcome.state === 'live') return null;
  if (outcome.state === 'missing') return missingJobPatch(node);
  const job = outcome.job || {};
  if (job.status === 'cancelled') return { status: 'cancelled', stage: job.stage || '已取消', progress: 0, error: null };
  if (job.status === 'completed' || job.status === 'done') {
    if (hasExportResult(node)) return { status: 'done', progress: 1, stage: node.data.stage && !isGeneratorStage(node.data.stage) ? node.data.stage : '已导出', error: null };
    return { status: 'error', stage: '导出失败', progress: 0, error: node.data.error || '导出已结束，但结果没有写回画布，请重新导出。' };
  }
  return {
    status: 'error', progress: 0, stage: job.stage || '导出失败',
    error: node.data?.error || (typeof job.error === 'string' ? job.error : job.error?.message) || '导出失败。',
  };
}

export function patchNodes(nodes, patches) {
  if (!patches?.length) return nodes;
  const byId = new Map(patches.map((item) => [item.id, item.patch]));
  return (nodes || []).map((node) => (byId.has(node.id) ? { ...node, data: { ...node.data, ...byId.get(node.id) } } : node));
}

/** Queue jobs that were already on the canvas, then disappeared from a snapshot. */
export function absentQueueJobPatches(nodes, jobs, { loadedJobIds = new Set(), seenJobIds = new Set() } = {}) {
  if (!Array.isArray(jobs)) return [];
  const present = new Set(jobs.map((job) => job?.id).filter((id) => typeof id === 'string' && id));
  const patches = [];
  for (const node of nodes || []) {
    if (node?.type !== 'generator' || !isActiveTaskStatus(node.data?.status)) continue;
    const jobId = node.data?.queueJobId;
    if (typeof jobId !== 'string' || !jobId || present.has(jobId)) continue;
    if (!loadedJobIds.has(jobId) && !seenJobIds.has(jobId)) continue;
    patches.push({ id: node.id, jobId, patch: missingJobPatch(node) });
  }
  return patches;
}

export function comfyQueuePromptIds(queue) {
  const ids = new Set();
  for (const key of ['queue_running', 'queue_pending']) {
    for (const item of queue?.[key] || []) {
      const id = Array.isArray(item) ? item[1] : item?.prompt_id;
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

/** Direct Comfy prompts with nothing in the queue or history are not still running. */
export function absentPromptPatches(nodes, { livePromptIds = null, historyIds = null } = {}) {
  if (!livePromptIds || !historyIds) return [];
  const patches = [];
  for (const node of nodes || []) {
    if (node?.type !== 'generator' || !isActiveTaskStatus(node.data?.status) || node.data?.queueJobId) continue;
    const promptId = node.data?.promptId;
    if (typeof promptId !== 'string' || !promptId) continue;
    if (livePromptIds.has(promptId) || historyIds.has(promptId)) continue;
    patches.push({ id: node.id, patch: missingJobPatch(node) });
  }
  return patches;
}
