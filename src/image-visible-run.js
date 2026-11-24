import { orderQwenReferences } from './qwen-references.js';

const IMAGE_SETTINGS = {
  image: ['h3ImageResolution', 'flux3Resolution', 'imageLora', 'loraStrength'],
  qwenEdit: ['qwenSteps', 'qwenRefResolution', 'qwenCacheDevice', 'qwenSourceCrop', 'qwenMaskCrop',
    'qwenReferenceOrder', 'h3ImageResolution', 'flux3Resolution', 'imageLora', 'loraStrength'],
  identityEdit: ['imageLora', 'loraStrength', 'quadViewStrength'],
  imageUpscale: ['upscaleModel', 'imageScale'],
  localRealism: ['localRealismSteps', 'localRealismSize', 'localRealismDenoise'],
  characterSheet: ['characterSheetStage', 'characterSheetPortraitPrompt', 'characterSheetPortraitCrop',
    'characterSheetPanels', 'characterSheetIdentityMode', 'characterSheetLayout', 'characterSheetDeliveryCrop', 'characterSheetModel',
    'qwenSteps', 'qwenRefResolution', 'imageLora', 'loraStrength'],
  outfitEdit: ['outfitPanel', 'outfitPanels', 'outfitLayout', 'outfitModel', 'outfitUpscale',
    'outfitPreserve', 'museSteps', 'upscaleModel', 'imageLora', 'loraStrength', 'qwenSteps', 'qwenRefResolution'],
  mossPose: ['poseInput', 'poseResolution', 'poseSteps', 'poseCfg', 'poseLoraStrength'],
};

export function imageGenerationSeed(data, random = Math.random) {
  if (data.randomSeed) return Math.floor(random() * 2147483647);
  if (!Object.hasOwn(IMAGE_SETTINGS, data.mode)) return Number(data.seed || 42);
  return Number(data.seed === '' ? 42 : data.seed ?? 42);
}

export function imageInput(reference) {
  const data = reference.data || reference;
  return {
    nodeId: reference.id, slot: data.slot || null, title: data.title || reference.id,
    assetPath: data.assetPath || null,
    ...(data.rawAssetPath ? { rawAssetPath: data.rawAssetPath } : {}),
    ...(data.sourcePromptId ? { sourcePromptId: data.sourcePromptId } : {}),
    ...(data.remoteName ? { uploadedName: data.remoteName } : {}),
  };
}

export function imageGenerationEvidence(node, references, settings) {
  const mode = node.data.mode;
  if (!Object.hasOwn(IMAGE_SETTINGS, mode)) return null;
  const isQwen = mode === 'qwenEdit';
  const masks = isQwen ? references.filter(ref => ref.data.slot === 'mask') : [];
  const photos = isQwen ? orderQwenReferences(references.filter(ref => ref.data.slot !== 'mask'), settings.qwenReferenceOrder) : references;
  const supplied = settings.references || [];
  const inputs = [...photos, ...masks].map((reference, index) => {
    const source = imageInput(reference);
    const uploaded = supplied.find(item => item.id === reference.id && item.slot === source.slot)?.name;
    if (uploaded) source.uploadedName = uploaded;
    if (isQwen && index < photos.length) {
      source.order = index + 1;
      source.role = index === 0 ? 'base' : 'reference';
      if (index === 0 && settings.qwenSourceCrop) source.crop = settings.qwenSourceCrop;
    }
    if (isQwen && source.slot === 'mask') {
      source.role = 'mask';
      source.guideNodeId = reference.data.maskSourceId || photos[0]?.id || null;
      source.guideVersion = reference.data.maskSourceKey || null;
    }
    return source;
  });
  return {
    inputs,
    parameters: Object.fromEntries(IMAGE_SETTINGS[mode].filter(key => settings[key] !== undefined).map(key => [key, settings[key]])),
  };
}

const OPTIMIZER_MODES = new Set(['reference', 'text', 'frames', 'swap']);
const BUSY = new Set(['uploading', 'optimizing', 'queued', 'running', 'finishing']);
export const canOptimizeImageCanvasTarget = (target) => Boolean(target && OPTIMIZER_MODES.has(target.data.mode));

export function promptRunSnapshot(prompt, target, descriptors) {
  if (!prompt || !canOptimizeImageCanvasTarget(target)) throw new Error('仅支持已连接的 H3 视频提示词。');
  if (BUSY.has(target.data.status)) throw new Error('生成期间不能改写目标提示词。');
  const toTags = (text) => descriptors.reduce((result, { node, tag }) => result.split('@' + node.data.title).join(tag), text || '');
  const payload = {
    idea: prompt.data.idea || '', currentPrompt: toTags(target.data.prompt), mode: target.data.mode,
    duration: target.data.duration || 5, ratio: target.data.ratio || '16:9',
    references: descriptors.map(({ node, kind, tag }) => ({ title: node.data.title, kind, tag, slot: node.data.slot })),
  };
  const inputs = descriptors.map(({ node, tag }) => ({ ...imageInput(node), role: tag }));
  const version = JSON.stringify([prompt.id, target.id, target.data.prompt, payload, inputs, descriptors.map(({ node }) => node.data.url || null)]);
  const restore = (text) => target.data.mode === 'reference'
    ? descriptors.reduce((value, { node, tag }) => value.split(tag).join('@' + node.data.title), text) : text;
  return { payload, inputs, version, restore, targetId: target.id };
}

export function pageImageRun(kind, inputs, parameters, requestId = globalThis.crypto.randomUUID()) {
  return { kind, inputs, parameters, requestId, phase: 'prepared', recovery: 'page-only' };
}

// This boundary is shared by the two paid HTTP tools and the page-local worker.
// Saved drafts may be read on reopen, but a lost page must never replay an operation.
export async function preparePageImageRun({ stage, persist, assertCurrent }) {
  assertCurrent();
  stage();
  await persist();
  assertCurrent();
}

export function recoverInterruptedImageRuns(nodes) {
  return nodes.map((node) => {
    const { data } = node;
    if (!['prompt', 'artDirector', 'imageProcess'].includes(node.type) || !BUSY.has(data?.status)) return node;
    const run = data.imageRun;
    if (run && (run.recovery !== 'page-only' || !['prepared', 'running', 'saving'].includes(run.phase))) return node;
    return { ...node, data: { ...data, status: 'error', stage: '页面中断 · 未自动重跑',
      error: '上次操作随页面中断。请先查看已保存的结果，再决定是否重新执行。',
      ...(run ? { imageRun: { ...run, phase: 'interrupted' } } : {}) } };
  });
}

export function imageRunError(run, error, dispatched) {
  const phase = !dispatched ? 'rejected' : ['AbortError', 'TimeoutError'].includes(error?.name) ? 'interrupted' : 'error';
  return run && { ...run, phase };
}

export function imageRunSummary(node) {
  const run = node.data?.imageRun || node.data?.spriteRun;
  if (!run) return {};
  const { requestId, recovery, phase, kind, resultNodeId, jobId } = run;
  return { imageRun: { requestId, recovery, phase, kind: kind || 'sprite-atlas', resultNodeId, jobId } };
}
