import { getGenerationJob } from './workbench-api.js';
import { imageRunSummary } from './image-visible-run.js';
import { CHARACTER_SHEET_SETTING_KEYS, validateCharacterSheetSettings } from './character-sheet-settings.js';
import { MOSS_POSE_DEFAULTS, validateMossPoseSettings } from './moss-pose.js';
import { normalizeVideoSuperResolutionSettings } from './video-super-resolution.js';
import { NATIVE3D_PRESETS } from './native3d.js';
import { useEffect, useRef } from 'react';
import { isVideoRhythm, normalizeSpeedDocument, normalizeRemapDocument, videoRhythmSummary } from './video-rhythm-document.js';
import { CHROMA_FIELDS, chromaDocumentFromNode, defaultChromaHandle, defaultChromaSettings, isVideoChroma, normalizePreviewTime, videoChromaSummary } from './video-chroma-document.js';
import { REPAIR_FIELDS, defaultRepairSettings, isVideoRepair, normalizeRepairDocument, normalizeRepairPreviewTime, videoRepairSummary } from './video-repair-document.js';
import { PLATE_FIELDS, PLATE_PORT, defaultPlateSettings, isVideoPlate, plateDocumentFromNode, videoPlateSummary } from './video-plate-document.js';
import { isVideoEdit, normalizeVideoEditDocument, nextVideoEditPort, videoEditSummary, videoEditInputView, VIDEO_EDIT_VIDEO_PORTS } from './video-edit-document.js';
import { submitVideoAnalysis, getVideoEditJob, cancelVideoEditJob } from './video-edit-runtime.js';
import { MOTION_CANVAS_MAX_CUES, normalizeMotionCanvasPreview } from './motion-canvas-pilot.js';
import { validateWorkflowParameters } from './workflow-extensions.js';
import { startCurrentCanvasPage, createProjectPageTools } from './canvas-current-page.js';
import { validateCharacterSheetAngleSeed, validateQwenCacheDevice, validateQwenSourceCrop } from './workbench-api.js';
import { DEFAULT_ADJUSTMENTS, BLEND_MODES, HSL_CHANNELS, LEVEL_CHANNELS } from './image-compositing.js';
import { isImageProcess, imageProcessSettings } from './image-process-graph.js';
import { PHOTO_ADJUSTMENTS, DEFAULT_PHOTO_SETTINGS, normalizePhotoAdjustment } from './photo-adjustments.js';
import { CHANNEL_KEYS, normalizeChannelPackSettings } from './channel-packing.js';
import { qwenCanvasReferences, bindQwenPrompt, displayQwenPrompt } from './qwen-references.js';
import { readImageModelInstall } from './image-model-install.js';
import { planImageModelPick } from './image-model-picker.js';
import { availableNodePresets } from './local-node-tools.js';
import { DEFAULT_SPRITE_OPTIONS, spriteSnapshot } from './sprite-atlas.js';
import { imageCompactArgs } from './image-inline-output.js';
import { publicDownloadError, validatePublicVideoUrl, videoDownloadState } from './video-download.js';
import {validPlanPreviews} from './native3d-runtime.js';
import {nativeOutputNode} from './native3d-output.js';

export const NODE_PRESETS = {
  ...NATIVE3D_PRESETS,

  moss_pose: ['generator', { ...MOSS_POSE_DEFAULTS, mode: 'mossPose', title: 'MOSS 姿势控制' }],
  sprite_atlas: ['spriteAtlas', { title: '3D 角色转多方向图集', spriteInputPath: '', spriteOptions: { ...DEFAULT_SPRITE_OPTIONS } }],
  art_director: ['artDirector', { title: '电子主美 · 图解分析', brief: '', preserve: '', referencePurposes: {} }],
  color_adjust: ['imageProcess', { ...DEFAULT_ADJUSTMENTS, mode: 'colorAdjust', title: '颜色调整' }],
  color_hsl: ['imageProcess', { mode: 'colorAdjust', adjustmentType: 'hsl', title: 'HSL 分色调整' }],
  color_levels: ['imageProcess', { mode: 'colorAdjust', adjustmentType: 'levels', title: '色阶 Levels' }],
  color_curves: ['imageProcess', { mode: 'colorAdjust', adjustmentType: 'curves', title: '曲线 Curves' }],
  image_blend: ['imageProcess', { mode: 'imageBlend', title: '图像混合', blendMode: 'normal', opacity: 100, fit: 'cover' }],
  rgba_pack: ['imageProcess', { mode: 'channelPack', title: 'RGBA 通道合并', packPreview: 'rgb' }],
  image_asset: ['image', {}],
  local_mask: ['image', { mediaRole: 'mask', title: '局部遮罩修改' }],
  video_asset: ['video', {}],
  video_speed: ['videoSpeed', { title: '恒定速度', speed: 0.5, rhythmAudio: 'preserve' }],
  video_time_remap: ['videoTimeRemap', { title: '时间重映射', remapKeyframes: [{ output: 0, source: 0, interpolation: 'linear' }, { output: 1, source: 1, interpolation: 'linear' }] }],
  video_chroma_key: ['videoChromaKey', { title: '绿幕扣像合成', ...defaultChromaSettings() }],
  video_local_repair: ['videoLocalRepair', { title: '局部水印修补', ...defaultRepairSettings() }],
  video_white_plate: ['videoWhitePlate', { title: '绿幕白模', ...defaultPlateSettings() }],
  video_edit: ['videoEdit', { title: '视频编辑' }],
  video_download: ['note', { title: '视频链接下载', noteRole: 'videoDownload' }],
  audio_asset: ['audio', {}],
  note: ['note', {}],
  prompt_optimizer: ['prompt', {}],
  reference_video: ['generator', { mode: 'reference', title: '视频生成' }],
  character_swap: ['generator', { mode: 'swap', title: '精准角色替换' }],
  text_video: ['generator', { mode: 'text', title: '文生视频' }],
  frames_video: ['generator', { mode: 'frames', title: '视频生成' }],
  h3_image: ['generator', { mode: 'image', title: 'H3-Image · 文生图', imageModel: 'h3_image', imageLora: 'none', h3ImageResolution: '4MP', ratio: '1:1' }],
  h3_image_edit: ['generator', { mode: 'qwenEdit', title: 'H3-Image · 多图编辑', qwenModel: 'h3_image', imageLora: 'none', h3ImageResolution: '4MP' }],
  krea_image: ['generator', { mode: 'image', title: '文生图', imageModel: 'krea2' }],
  moss_image: ['generator', { mode: 'image', title: '文生图', imageModel: 'moss' }],
  identity_edit: ['generator', { mode: 'identityEdit', title: '母图编辑 V2', ratio: '16:9', refBoost: 4, groundingPx: 1024, refPosition: 'beside (right of target)' }],
  qwen_edit: ['generator', { mode: 'qwenEdit', title: '图生图', randomSeed: true, qwenSteps: 40, qwenRefResolution: 1024 }],
  qwen_turbo_edit: ['generator', { mode: 'qwenEdit', title: 'Qwen 2.1 Turbo INT8 · 图生图', qwenModel: 'turbo', randomSeed: false, seed: 281306, qwenRefResolution: 1024 }],
  realism_edit: ['generator', { mode: 'qwenEdit', title: '真人化 · 漫转真', prompt: '将图中的风格化人物转换为真实摄影中的真人，保留人物身份特征、发型发色、姿势、景别和构图；真实自然的皮肤纹理、五官结构与摄影光影，不要 CG、3D 渲染、插画或塑料皮肤。', imageLora: 'qwen21Realism', loraStrength: 0.8, randomSeed: true, qwenSteps: 40, qwenRefResolution: 1024 }],
  character_sheet: ['generator', { mode: 'characterSheet', title: '角色四视图生成', randomSeed: false, seed: 281306, qwenSteps: 40, qwenRefResolution: 1536 }],
  local_realism: ['generator', { mode: 'localRealism', title: '局部写实修复', prompt: '只增强选中皮肤的自然纹理、细小毛孔和真实光影；保持人物身份、五官、妆容、表情及其他区域不变。', localRealismSteps: 25, localRealismSize: 768, localMaskExpand: 0, localMaskBlend: 16, randomSeed: false, seed: 78001 }],
  outfit_edit: ['generator', { mode: 'outfitEdit', title: '无抠图换装', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, qwenRefResolution: 1536 }],
  outfit_qwen21_turbo: ['generator', { mode: 'outfitEdit', title: 'Qwen 2.1 Turbo INT8 · 四视图 · 无高清', outfitModel: 'qwen21_turbo', outfitUpscale: 'off', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, qwenRefResolution: 1536 }],
  outfit_qwen21_turbo_7b: ['generator', { mode: 'outfitEdit', title: 'Qwen 2.1 Turbo INT8 · 四视图 + SeedVR2 7B', outfitModel: 'qwen21_turbo', outfitUpscale: 'seedvr2_7b', upscaleModel: 'seedvr2_7b', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, qwenRefResolution: 1536 }],
  outfit_muse_v4: ['generator', { mode: 'outfitEdit', title: 'Muse V4.0 INT8 · 四视图 · 无高清', outfitModel: 'muse_v4', outfitUpscale: 'off', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, museSteps: 16 }],
  image_upscale: ['generator', { mode: 'imageUpscale', title: '图片高清', imageScale: 1.5, randomSeed: false }],
  image_upscale_7b: ['generator', { mode: 'imageUpscale', title: 'SeedVR2 7B INT8 · 图片高清', upscaleModel: 'seedvr2_7b', imageScale: 1.5, randomSeed: false }],
  video_super_resolution: ['generator', { mode: 'videoSuperResolution', title: '视频超分', videoUpscaleModel: 'rtx', videoUpscaleScale: 2, rtxQuality: 'ULTRA', rtxStrength: 1, randomSeed: false }],
  video_upscale: ['generator', { mode: 'upscale', title: '视频高清二采', resolution: '720P', randomSeed: false }],
};

const EDITABLE_SETTINGS = new Set([
  'adapterId', 'nativeParameters',
  ...CHARACTER_SHEET_SETTING_KEYS,
  'poseInput', 'poseResolution', 'poseSteps', 'poseCfg', 'poseLoraStrength',
  'videoUpscaleModel', 'videoUpscaleScale', 'rtxQuality', 'rtxStrength',
  ...PLATE_FIELDS, ...REPAIR_FIELDS, ...CHROMA_FIELDS, 'speed', 'rhythmAudio', 'remapKeyframes', 'editDocument',
  'spriteInputPath', 'spriteOptions',
  'packChannels', 'packPreview',
  ...Object.keys(DEFAULT_PHOTO_SETTINGS), 'curvesChannel', 'colorBalanceRange', 'selectiveColorRange', 'channelMixerChannel',
  'adjustmentType', 'hsl', 'hslChannel', 'levels', 'levelsChannel', 'maskChannel', 'maskInvert',
  'brightness', 'contrast', 'saturation', 'hue', 'gamma', 'temperature', 'blendMode', 'opacity', 'fit',
  'workflowParameters', 'ratio', 'resolution', 'duration', 'turbo', 'seed', 'randomSeed', 'refImageSize', 'characterSheetAngleSeed',
  'qwenSteps', 'qwenRefResolution', 'localRealismSteps', 'localRealismSize', 'localRealismDenoise', 'localMaskMode', 'localMaskExpand', 'localMaskBlend', 'imageModel', 'imageLora', 'loraStrength', 'imageScale',
  'qwenModel', 'qwenCacheDevice', 'qwenSourceCrop', 'qwenMaskCrop', 'outfitModel', 'upscaleModel', 'outfitUpscale', 'outfitHdScale', 'museSteps', 'flux3Resolution', 'h3ImageResolution',
  'outfitPreset', 'outfitPanel', 'outfitLayout', 'outfitPanels', 'outfitDenoise', 'targetQuery', 'targetDescription', 'targetSelection', 'targetIndex',
]);

export function describeNodeModels(data = {}) {
  const outfitModel = data.outfitModel || 'qwen21';
  const outfitModelLabel = outfitModel === 'muse_v4' ? 'Muse V4.0 INT8 + Identity V2' : outfitModel === 'qwen21_turbo' ? 'Qwen 2.1 Turbo INT8' : 'Qwen 2.1 标准版 INT8';
  const outfitHdLabel = data.outfitUpscale === 'off' ? '不做高清修复' : data.outfitUpscale === 'seedvr2_7b' ? '逐视图 SeedVR2 7B INT8' : '低于 1K 才 SeedVR2 3B';
  return {
    outfitModelLabel, outfitHdLabel,
    outfitSteps: outfitModel === 'muse_v4' ? Number(data.museSteps || 16) : outfitModel === 'qwen21_turbo' ? 8 : Number(data.qwenSteps || 40),
    qwenModelLabel: data.qwenModel === 'h3_image' ? 'MiniMax H3 Image INT8' : data.qwenModel === 'flux3_klein' ? 'FLUX 3 Image Klein INT8' : data.qwenModel === 'turbo' ? 'Qwen 2.1 Turbo INT8' : 'Qwen 2.1 标准版 INT8',
    qwenSteps: data.qwenModel === 'h3_image' ? 6 : data.qwenModel === 'flux3_klein' ? 16 : data.qwenModel === 'turbo' ? 8 : Number(data.qwenSteps || 40),
    upscaleModelLabel: data.upscaleModel === 'seedvr2_7b' ? 'SeedVR2 7B INT8' : 'SeedVR2 3B INT8',
  };
}

export function validateModelSettings(settings, mode) {
  if (CHARACTER_SHEET_SETTING_KEYS.some(key => key in settings)) {
    if (mode !== undefined && mode !== 'characterSheet') throw new Error('角色表参数仅适用于角色四视图。');
    validateCharacterSheetSettings(settings);
  }
  if (mode === 'mossPose') validateMossPoseSettings(settings);
  if (['videoUpscaleModel', 'videoUpscaleScale', 'rtxQuality', 'rtxStrength'].some(key => key in settings)) {
    if (mode !== undefined && mode !== 'videoSuperResolution') throw new Error('视频超分参数只适用于视频超分节点。');
    normalizeVideoSuperResolutionSettings(settings);
  }
  const choices = { adjustmentType: PHOTO_ADJUSTMENTS.map((item) => item.value), maskChannel: ['luminance', 'red', 'green', 'blue', 'alpha'], hslChannel: HSL_CHANNELS.map((item) => item.value), levelsChannel: LEVEL_CHANNELS.map((item) => item.value), curvesChannel: LEVEL_CHANNELS.map((item) => item.value), colorBalanceRange: ['shadows', 'midtones', 'highlights'], selectiveColorRange: ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'], channelMixerChannel: ['red', 'green', 'blue'] };
  for (const [key, allowed] of Object.entries(choices)) if (key in settings && !allowed.includes(settings[key])) throw new Error(`不支持的 ${key}。`);
  if ('packPreview' in settings && !['rgb', 'rgba', ...CHANNEL_KEYS].includes(settings.packPreview)) throw new Error('不支持的通道预览。');
  const check = (supplied, normalized, path) => {
    if (Array.isArray(supplied)) {
      if (!Array.isArray(normalized) || supplied.length !== normalized.length) throw new Error(`无效的 ${path}。`);
      supplied.forEach((value, index) => check(value, normalized[index], `${path}[${index}]`));
    } else if (supplied && typeof supplied === 'object') {
      if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new Error(`无效的 ${path}。`);
      for (const [key, value] of Object.entries(supplied)) {
        if (!Object.hasOwn(normalized, key)) throw new Error(`不支持的 ${path}.${key}。`);
        check(value, normalized[key], `${path}.${key}`);
      }
    } else if (supplied !== normalized && !(typeof supplied === 'string' && /^#[0-9a-f]{6}$/i.test(supplied) && supplied.toLowerCase() === normalized)) throw new Error(`无效的 ${path}。`);
  };
  for (const key of Object.keys(DEFAULT_PHOTO_SETTINGS)) if (key in settings) {
    if (!settings[key] || typeof settings[key] !== 'object' || Array.isArray(settings[key])) throw new Error(`${key} 必须为参数对象。`);
    check(settings[key], normalizePhotoAdjustment({ adjustmentType: key, [key]: settings[key] })[key] || {}, key);
  }
  if ('packChannels' in settings) {
    if (!settings.packChannels || typeof settings.packChannels !== 'object' || Array.isArray(settings.packChannels)) throw new Error('packChannels 必须为通道参数对象。');
    check(settings.packChannels, normalizeChannelPackSettings(settings).channels, 'packChannels');
  }
  if ('maskInvert' in settings && typeof settings.maskInvert !== 'boolean') throw new Error('maskInvert 必须为布尔值。');
  for (const key of ['hsl', 'levels']) if (key in settings) {
    const channels = key === 'hsl' ? choices.hslChannel : choices.levelsChannel;
    const ranges = key === 'hsl' ? { hue: [-180, 180], saturation: [-100, 100], lightness: [-100, 100] } : { inputBlack: [0, 254], inputWhite: [1, 255], gamma: [0.1, 3], outputBlack: [0, 255], outputWhite: [0, 255] };
    const map = settings[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`${key} 必须为通道参数对象。`);
    for (const [channel, values] of Object.entries(map)) {
      if (!channels.includes(channel) || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`不支持的 ${key} 通道。`);
      for (const [parameter, value] of Object.entries(values)) {
        const range = ranges[parameter];
        if (!range || !Number.isFinite(value) || value < range[0] || value > range[1]) throw new Error(`无效的 ${key}.${channel}.${parameter}。`);
      }
      if (key === 'levels' && ((values.inputBlack ?? 0) + 1 > (values.inputWhite ?? 255) || (values.outputBlack ?? 0) > (values.outputWhite ?? 255))) throw new Error('色阶黑场必须小于输入白场，且不能大于输出白场。');
    }
  }
  const imageRanges = { brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], hue: [-180, 180], gamma: [0.1, 3], temperature: [-100, 100], opacity: [0, 100] };
  for (const [key, [min, max]] of Object.entries(imageRanges)) if (key in settings && (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max)) throw new Error(`${key} 必须在 ${min}–${max} 之间。`);
  if ('blendMode' in settings && !BLEND_MODES.some((item) => item.value === settings.blendMode)) throw new Error('不支持的混合模式。');
  if ('fit' in settings && !['cover', 'contain', 'stretch'].includes(settings.fit)) throw new Error('不支持的图片适配方式。');
  if ('qwenMaskCrop' in settings && (typeof settings.qwenMaskCrop !== 'boolean' || (mode !== undefined && mode !== 'qwenEdit'))) throw new Error('局部放大重绘仅支持图生图的布尔开关。');
  if ('qwenCacheDevice' in settings) {
    validateQwenCacheDevice(settings.qwenCacheDevice);
    if (mode !== undefined && !['qwenEdit', 'characterSheet'].includes(mode)) throw new Error('qwenCacheDevice 仅适用于 Qwen 图生图或角色四视图。');
  }
  if ('characterSheetAngleSeed' in settings) validateCharacterSheetAngleSeed(settings.characterSheetAngleSeed);
  if ('qwenSourceCrop' in settings) validateQwenSourceCrop(settings.qwenSourceCrop);
  const values = { qwenModel: ['standard', 'turbo', 'flux3_klein', 'h3_image'], h3ImageResolution: ['4MP', '16MP'], flux3Resolution: ['1MP', '2K', '4K'], outfitModel: ['qwen21', 'qwen21_turbo', 'muse_v4'], upscaleModel: ['seedvr2_3b', 'seedvr2_7b'], outfitUpscale: ['auto', 'off', 'seedvr2_7b'] };
  for (const [key, allowed] of Object.entries(values)) {
    if (key in settings && !allowed.includes(settings[key])) throw new Error(`不支持的 ${key}：${settings[key]}`);
  }
  if ('outfitHdScale' in settings && (!Number.isFinite(settings.outfitHdScale) || settings.outfitHdScale < 1 || settings.outfitHdScale > 4)) throw new Error('outfitHdScale 必须在 1–4 之间。');
  if ('museSteps' in settings && (!Number.isInteger(settings.museSteps) || settings.museSteps < 8 || settings.museSteps > 20)) throw new Error('museSteps 必须是 8–20 之间的整数。');
}

const nativeSummaryText = (value, limit = 192) => typeof value === 'string' ? value.slice(0, limit) : undefined;
function nativeSummaryScalars(value, keys, textLimit = 96) {
  const summary = {};
  for (const key of keys) {
    const item = value?.[key];
    if (typeof item === 'string') summary[key] = item.slice(0, textLimit);
    else if (item === null) summary[key] = null;
    else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) summary[key] = item;
  }
  return summary;
}
const nativeReceiptFields = ['status','triangles','vertices','mesh_hash','automatic_hole_caps','accepted_moves','passes','ambiguous_components','requested_triangles','actual_triangles','stopped_above_target','fixed_boundary_vertices','boundary_edges','duplicate_faces','inconsistent_winding_edges','signed_normal_dot_minimum'];
function nativeReceiptCounts(receipt) {
  const summary = nativeSummaryScalars(receipt, nativeReceiptFields);
  for (const key of ['operations','records','collapses','nonmanifold_edges','nonmanifold_vertices','degenerate_faces','intersection_pairs','boundary_components','unresolved_openings']) {
    if (Array.isArray(receipt?.[key])) summary[`${key}_count`] = receipt[key].length;
  }
  return summary;
}
function nativeReceiptSummary(receipt) {
  const summary = nativeReceiptCounts(receipt);
  for (const key of ['before','after','receipt']) {
    if (receipt?.[key] && typeof receipt[key] === 'object') summary[key] = nativeReceiptCounts(receipt[key]);
  }
  if (Array.isArray(receipt?.components)) {
    summary.component_count = receipt.components.length;
    summary.flipped_component_count = receipt.components.reduce((n, component) => n + (component?.flipped === true ? 1 : 0), 0);
  }
  return summary;
}

export function native3dNodeSummary(node) {
  const data = node.data || {}, metadata = data.metadata || {}, geometry = metadata.geometry;
  const diagnostic=data.nativeUVDiagnosticPreviews;
  const hasDiagnostic=Boolean(data.operation==='uv'&&['failed','error'].includes(data.status)&&diagnostic?.jobId===data.nativeJobId&&diagnostic.nodeId===node.id&&diagnostic.diagnosticOnly===true&&diagnostic.acceptedUV===false&&diagnostic.bakeAllowed===false&&/^assets\/[a-f0-9]{64}\.png$/i.test(diagnostic.layout||''));
  const stages = Array.isArray(geometry?.stages) ? geometry.stages : [];
  const artifacts = Array.isArray(data.nativeArtifacts) ? data.nativeArtifacts : [];
  const safeArtifacts = artifacts.slice(0, 256).filter(item => typeof item?.assetPath === 'string'
    && /^assets\/[a-f0-9]{64}\.(glb|obj|fbx|png|jpg|jpeg|webp|json|bin|npz)$/i.test(item.assetPath)
    && ['model','proxy','poster','texture','export','report','plan','evidence'].includes(item.role)
    && (item.role !== 'report' || item.assetPath.toLowerCase().endsWith('.json')));
  // Copies only: never sort or trim the project's live artifact/stage arrays.
  safeArtifacts.sort((a, b) => Number(b.role === 'report') - Number(a.role === 'report'));
  const result = {
    id: nativeSummaryText(node.id, 128), type: 'native3d', title: nativeSummaryText(data.title, 128) || '',
    nativeStageProvenance: data.nativeStageProvenance ? nativeSummaryScalars(data.nativeStageProvenance,['processorNodeId','referenceNodeId','parentStage','parentMeshHash','parentTriangles','stageIndex']) : undefined,
    nativeUVPreviews: data.nativeUVPreviews ? nativeSummaryScalars(data.nativeUVPreviews,['jobId','modelAssetPath','seamsAssetPath','checkerAssetPath','layoutAssetPath','aoAssetPath','aoSeamsAssetPath','aoUnavailable']) : undefined,
    nativeUVPreviewMode: nativeSummaryText(data.nativeUVPreviewMode, 24),
    ...(data.nativeUVPlan ? {nativeUVPlan:{...nativeSummaryScalars(data.nativeUVPlan,['jobId','planSha256','lowAssetPath','highAssetPath','overlayAssetPath','producerNodeId']),statistics:nativeSummaryScalars(data.nativeUVPlan.statistics,['lowFaces','highFaces','regionCount','candidateEdgeCount','unsupportedAreaFraction','unwrapExecuted']),reviewed:Boolean(data.nativeUVPlanViewed),confirmed:Boolean(data.nativeUVPlanConfirmation)}} : {}),
    ...nativeSummaryScalars(data,['nativeLODLevel','nativeNaniteCandidate']),
    ...nativeSummaryScalars(data, ['operation','adapterId','nativeJobId','sourceJobId','sourceNodeId','nativeStage','status','stage','progress','kind','name'], 128),
    error: nativeSummaryText(data.error, 384) || null,
    assetPath: nativeSummaryText(data.assetPath, 192),
    resultAssetPath: nativeSummaryText(data.resultAssetPath, 192),
    ...(data.nativeOutputRecords?.length?{nativeOutputRecordCount:data.nativeOutputRecords.length,nativeCurrentOutputId:nativeSummaryText(data.nativeCurrentOutputId,128)}:{}),
    nativeParameters: nativeSummaryScalars(data.nativeParameters, Object.keys(data.nativeParameters || {}).slice(0, 16)),
    metadata: {
      ...nativeSummaryScalars(metadata, ['operation','sourceSha256','highSourceSha256','sourceHash','highHash','source_mesh_hash','wallSeconds','sourceUV','sourceMaterials','sourceTransform']),
      source: nativeSummaryScalars(metadata.source, ['status','vertices','triangles','finite','degenerateTriangles','boundaryEdges','nonManifoldEdges','watertight','selfIntersection']),
      ...(geometry && typeof geometry === 'object' ? {geometry: {
        ...nativeSummaryScalars(geometry, ['status','source_mesh_hash','selectedLod']),
        blocker: nativeSummaryText(geometry.blocker, 384), stageCount: stages.length,
        stages: stages.slice(0, 16).map(stage => ({
          ...nativeSummaryScalars(stage, ['stage','name','parent_mesh_hash','mesh_hash','filename','lodLevel','visible','aliasOfStage']),
          receipt: nativeReceiptSummary(stage?.receipt),
        })),
        stagesTruncated: stages.length > 16,
      }} : {}),
      detailsOmitted: true,
    },
    quality: nativeSummaryScalars(data.quality, ['status','vertices','triangles','finite','degenerateTriangles','boundaryEdges','nonManifoldEdges','watertight','selfIntersection']),
    nativeArtifacts: safeArtifacts.slice(0, 16).map(item => ({role: item.role, name: nativeSummaryText(item.name, 96), assetPath: item.assetPath})),
    nativeArtifactCount: artifacts.length, nativeArtifactsTruncated: safeArtifacts.length > 16 || artifacts.length > 256,
    position: nativeSummaryScalars(node.position, ['x','y']), selected: Boolean(node.selected), pinned: Boolean(data.pinned),
    hasMedia: Boolean(data.assetPath),hasPlan:Boolean(data.nativeUVPlan),hasPreview:Boolean(data.posterAssetPath || data.nativeUVPreviews || hasDiagnostic || validPlanPreviews(data.nativeUVPlanPreviews,data.nativeUVPlan)), summaryVersion: 1,
    ...(hasDiagnostic?{nativeUVDiagnosticPreviews:nativeSummaryScalars(diagnostic,['jobId','projectId','nodeId','sourceSha256','diagnosticOnly','acceptedUV','bakeAllowed','layout','checker'],96)}:{}),
    ...(validPlanPreviews(data.nativeUVPlanPreviews,data.nativeUVPlan)?{nativeUVPlanPreviews:nativeSummaryScalars(data.nativeUVPlanPreviews,['schemaVersion','planSha256','overlaySha256','regions','convex','details','ao'],96),nativePlanPreviewMode:['regions','convex','details','ao'].includes(data.nativePlanPreviewMode)?data.nativePlanPreviewMode:'regions'}:{}),
  };
  const size = () => new TextEncoder().encode(JSON.stringify(result)).length;
  // An explicit transport budget also covers unusually long Unicode labels.
  if (size() > 12 * 1024) {
    delete result.nativeParameters;
    while (size() > 12 * 1024 && result.metadata.geometry?.stages.length) {
      result.metadata.geometry.stages.pop();
      result.metadata.geometry.stagesTruncated = true;
    }
    while (size() > 12 * 1024 && result.nativeArtifacts.length) {
      result.nativeArtifacts.pop();
      result.nativeArtifactsTruncated = true;
    }
  }
  return result;
}

function mediaLocation(data = {}) {
  const media = {};
  const text = (value, max = 500) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
  const assetPath = text(data.assetPath);
  const directUrl = typeof data.url === 'string' && !data.url.startsWith('blob:') ? data.url : undefined;
  const fallbackUrl = typeof data.resultUrl === 'string' ? data.resultUrl : undefined;
  const url = text(directUrl || fallbackUrl, 800);
  const filename = text(data.filename) || (data.output ? text(data.name) : undefined);
  const subfolder = text(data.subfolder);
  const type = ['output', 'input', 'temp'].includes(data.type) ? data.type : undefined;
  if (assetPath) media.assetPath = assetPath;
  if (url) media.url = url;
  if (filename) media.filename = filename;
  if (subfolder) media.subfolder = subfolder;
  if (type) media.type = type;
  return Object.keys(media).length ? media : null;
}

export function nodeSummary(node, includeContent = true, graph = {}) {
  if (!node) return null;
  if (node.type === 'native3d') return native3dNodeSummary(node);
  const media = mediaLocation(node.data);
  return {
    ...imageRunSummary(node),
    id: node.id,
    type: node.type,
    title: node.data.title || '',
    kind: node.data.kind,
    ...(node.type === 'spriteAtlas' ? { spriteInputPath: node.data.spriteInputPath, spriteOptions: node.data.spriteOptions, spriteJobId: node.data.spriteJobId, spriteFiles: node.data.spriteFiles } : {}),
    ...(node.data.mediaRole === 'mask' ? { mediaRole: 'mask', maskSourceId: node.data.maskSourceId } : {}),
    mode: node.data.mode,
    ...(isImageProcess(node) ? { processingSettings: imageProcessSettings(node.data), processedAssetPath: node.data.processedAssetPath, processedTgaAssetPath: node.data.processedTgaAssetPath, processedResultId: node.data.processedResultId } : {}),
    ...(node.data.mode === 'customWorkflow' ? { extensionDigest: node.data.extensionDigest, nodeDefinitionId: node.data.nodeDefinitionId, workflowDefinition: node.data.workflowDefinition, workflowParameters: node.data.workflowParameters } : {}),
    ...(node.data.mode === 'videoSuperResolution' ? { videoUpscaleModel: node.data.videoUpscaleModel || 'rtx', videoUpscaleScale: node.data.videoUpscaleScale ?? 2, rtxQuality: node.data.rtxQuality || 'ULTRA', rtxStrength: node.data.rtxStrength ?? 1 } : {}),
    status: node.data.status,
    stage: node.data.stage,
    ...(videoDownloadState(node.data) || {}),
    progress: node.data.progress,
    promptId: node.data.promptId,
    queueJobId: node.data.queueJobId,
    ...(includeContent ? { prompt: node.data.prompt, text: node.data.text } : {}),
    ...(node.data.mode === 'image' ? { imageModel: node.data.imageModel || 'krea2', ...(node.data.imageModel === 'h3_image' ? { h3ImageResolution: node.data.h3ImageResolution || '4MP' } : {}) } : {}),
    ...(node.data.mode === 'outfitEdit' ? { outfitLayout: node.data.outfitLayout || 'legacy', outfitPanel: node.data.outfitPanel || node.data.panelId || null, outfitPanels: node.data.outfitPanels || null } : {}),
    ...(['outfitEdit', 'qwenEdit', 'characterSheet', 'imageUpscale'].includes(node.data.mode) ? {
      qwenModel: node.data.qwenModel || 'standard', ...(node.data.qwenModel === 'h3_image' ? { h3ImageResolution: node.data.h3ImageResolution || '4MP' } : {}), ...(node.data.qwenModel === 'flux3_klein' ? { flux3Resolution: node.data.flux3Resolution || '1MP' } : {}), outfitModel: node.data.outfitModel || 'qwen21',
      outfitUpscale: node.data.outfitUpscale || 'auto', upscaleModel: node.data.upscaleModel || 'seedvr2_3b',
      models: describeNodeModels(node.data),
    } : {}),
    ...(node.data.mode === 'characterSheet' ? Object.fromEntries(CHARACTER_SHEET_SETTING_KEYS.filter(key => node.data[key] !== undefined && (includeContent || !['characterSheetBuild','characterSheetLegs','characterSheetTorso','characterSheetShoulders','characterSheetHips','characterSheetPosture','characterSheetPreserveTraits','characterSheetPortraitBrief'].includes(key))).map(key => [key, node.data[key]])) : {}),
    name: node.data.name || node.data.filename,
    position: node.position,
    selected: Boolean(node.selected),
    pinned: Boolean(node.data.pinned),
    hasMedia: Boolean(node.data.url || node.data.resultUrl || node.data.processedAssetPath || node.data.assetPath || node.data.editResultAssetPath || node.data.rhythmResultAssetPath || node.data.chromaResultAssetPath || node.data.repairResultAssetPath || node.data.plateResultAssetPath),
    ...(isVideoRhythm(node) ? videoRhythmSummary(node.data, node.type) : {}),
    ...(isVideoChroma(node) ? videoChromaSummary(node.data) : {}),
    ...(isVideoRepair(node) ? videoRepairSummary(node.data, { ...graph, nodeId: node.id }) : {}),
    ...(isVideoPlate(node) ? videoPlateSummary(node.data) : {}),
    ...(isVideoEdit(node) ? videoEditSummary(node.data) : {}),
    ...(media ? { media } : {}),
    ...(['image', 'qwenEdit'].includes(node.data.mode) ? {
      modelLockedByUser: Boolean(node.data.modelLockedByUser),
      ...(node.data.modelPickNote ? { modelPickNote: node.data.modelPickNote } : {}),
      ...(node.data.imageTaskType ? { imageTaskType: node.data.imageTaskType } : {}),
      ...(node.data.imageReview ? { imageReview: node.data.imageReview } : {}),
    } : {}),
  };
}

function edgeSummary(edge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  };
}

const isNativePlanSource = (source) => source?.type === 'native3d' && (Boolean(source.data.nativeUVPlan) || source.data.operation === 'uv_plan');
function defaultTargetHandle(target, source, edges = []) {
  if (target?.type === 'native3d') return isNativePlanSource(source) ? 'plan' : 'model';
  if (isVideoChroma(target)) return defaultChromaHandle(target, source, edges);
  if (isVideoRepair(target)) return 'video';
  if (isVideoPlate(target)) return PLATE_PORT;
  if (isVideoRhythm(target)) return 'v1';
  if (target.type === 'artDirector') return 'artwork';
  if (isImageProcess(target)) return target.data.mode === 'channelPack' ? 'red' : target.data.mode === 'imageBlend' ? 'base' : 'guide';
  if (source?.type === 'prompt') return 'prompt';
  if (target?.data.mediaRole === 'mask') return 'guide';
  if (source?.data.mediaRole === 'mask' && target?.data.mode === 'qwenEdit') return 'mask';
  const mode = target?.data.mode || 'reference';
  if (['reference', 'qwenEdit'].includes(mode)) return 'references';
  if (mode === 'frames') return source?.data.slot === 'last' ? 'last' : 'first';
  if (mode === 'videoSuperResolution') return 'guide';
  if (['swap', 'upscale'].includes(mode)) return source?.data.kind === 'video' || isVideoPlate(source) ? 'guide' : 'identity';
  if (['imageUpscale', 'identityEdit', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism', 'mossPose'].includes(mode)) return 'guide';
  throw new Error('这个生成模式不接受素材连线。');
}

async function waitFor(read, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('等待画布状态更新超时。');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const nodeIdProperty = { type: 'string', description: '画布节点的完整 ID，可从 canvas_get_state 获取。' };

function mcpNode(latest, id) {
  const node = latest.current.nodesRef.current.find((item) => item.id === id);
  if (!node) throw new Error(`找不到节点：${id}`);
  return node;
}

async function waitForVideoJob(latest, nodeId, jobKey, jobId, timeoutMs, waitImpl) {
  if (!jobId) throw new Error('这个视频编辑节点还没有提交导出。');
  const node = await waitImpl(() => {
    const current = mcpNode(latest, nodeId);
    if (current.data[jobKey] !== jobId) throw new Error('视频编辑任务已更换。');
    return ['done', 'error', 'cancelled'].includes(current.data.status) ? current : null;
  }, timeoutMs, 500);
  return { node: nodeSummary(node), resultNode: null };
}

async function waitForNative3D(latest, nodeId, timeoutMs, waitImpl) {
  const id = mcpNode(latest,nodeId).data.nativeJobId;
  if (!id) throw new Error('此3D节点尚未提交任务。');
  let node;
  try {
    node = await waitImpl(() => {
      const current=mcpNode(latest,nodeId);
      if (current.data.nativeJobId !== id) throw Error('3D任务已更换。');
      return ['completed','error','failed','cancelled','stale'].includes(current.data.status) ? current : null;
    },timeoutMs,500);
  } catch (error) {
    if (!/超时|timeout/i.test(error.message)) throw error;
    const current=mcpNode(latest,nodeId);
    if (current.data.nativeJobId !== id) throw Error('3D任务已更换。');
    return {pending:true,jobId:id,node:nodeSummary(current),resultNode:null};
  }
  if(node.data.status!=='completed') throw new Error(node.data.error || `3D任务状态：${node.data.status}`);
  const inline=node.data.nativeOutputRecords?.find(record=>record.jobId===id&&record.recordId===node.data.nativeCurrentOutputId);
  const result=inline?nativeOutputNode(node,inline.recordId):latest.current.nodesRef.current.find(n=>n.data.sourceJobId===id);
  return {pending:false,jobId:id,node:nodeSummary(node),resultNode:nodeSummary(result)};
}

export async function generateNodeForMcp(latest, { nodeId, wait = false, timeoutMs = 300000, expectedRevision }, waitImpl = waitFor, generation = {}) {
  generation.assertActive?.();
  if (expectedRevision !== undefined) {
    const save = latest.current.getAgentState?.().save;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw agentReceiptError('BAD_REQUEST', 'expectedRevision 无效。');
    if (save?.revision !== expectedRevision) throw agentReceiptError('REVISION_CONFLICT', '保存修订已变化，本次生成未提交。', { save });
    if (save.state !== 'saved') throw agentReceiptError('SAVE_PENDING', '当前页尚未保存，本次生成未提交。', { save });
  }
  const options = { ...generation, expectedRevision, origin: 'agent' };
  const initial = mcpNode(latest, nodeId);
  if (['uploading', 'queued', 'running', 'finishing'].includes(initial.data.status)) throw new Error('节点已经在生成，请使用 canvas_wait_for_node 等待，避免重复提交。');
  if (initial.type === 'spriteAtlas') {
    const result = await latest.current.actions.generateNode(nodeId, options);
    if (!result?.ok) throw new Error(result?.error || '精灵图提交失败。');
    if (!wait) return { node: nodeSummary(mcpNode(latest, nodeId)), jobId: result.jobId,
      requestId: result.requestId, execution: result.execution, status: result.status };
    const finished = await waitImpl(() => {
      const node = mcpNode(latest, nodeId);
      return node.data.spriteJobId === result.jobId && ['done', 'error', 'cancelled'].includes(node.data.status) ? node : null;
    }, timeoutMs, 500);
    if (finished.data.status !== 'done') throw new Error(finished.data.error || '精灵图未交付。');
    return { node: nodeSummary(finished) };
  }
  if (initial.type === 'artDirector') {
    const result = await latest.current.actions.generateNode(nodeId, options);
    if (!result?.ok) throw new Error(result?.error || '解析图输出失败。');
    return { node: nodeSummary(mcpNode(latest, nodeId)), resultNode: nodeSummary(mcpNode(latest, result.resultId)) };
  }
  if (isVideoEdit(initial) || isVideoRhythm(initial) || isVideoChroma(initial) || isVideoRepair(initial) || isVideoPlate(initial)) {
    const jobKey = isVideoEdit(initial) ? 'videoEditJobId' : isVideoRhythm(initial) ? 'rhythmJobId' : isVideoChroma(initial) ? 'chromaJobId' : isVideoRepair(initial) ? 'repairJobId' : 'plateJobId';
    const result = await latest.current.actions.generateNode(nodeId, options);
    if (!result?.ok) throw new Error(result?.error || '视频导出提交失败。');
    if (!wait) return { node: nodeSummary(mcpNode(latest, nodeId)), jobId: result.jobId };
    const finished = await waitForVideoJob(latest, nodeId, jobKey, result.jobId, timeoutMs, waitImpl);
    if (finished.node.status !== 'done') throw new Error(finished.node.error || '视频编辑未交付。');
    return finished;
  }
  if (isImageProcess(initial)) {
    const result = await latest.current.actions.generateNode(nodeId, options);
    if (!result?.ok) throw new Error(result?.error || '图片输出失败。');
    const finished = await waitImpl(() => {
      const node = mcpNode(latest, nodeId);
      return node.data.status === 'done' && node.data.processedResultId === result.resultId ? node : null;
    });
    return { node: nodeSummary(finished), resultNode: nodeSummary(mcpNode(latest, result.resultId)) };
  }
  if (initial.type === 'native3d') {
    const result = await latest.current.actions.generateNode(nodeId, options);
    if (!result?.jobId || result.ok === false) {
      throw agentReceiptError(result?.code || 'SUBMISSION_UNCONFIRMED', result?.error || '没有确认的 3D 后台任务。');
    }
    if (wait) return waitForNative3D(latest, nodeId, timeoutMs, waitImpl);
    return { ...result, requestId: result.opId || options.requestId, execution: 'accepted',
      node: { id: nodeId, type: 'native3d', nativeJobId: result.jobId, status: result.status } };
  }
  if (isImageProcess(initial)) {
    const result = await latest.current.actions.generateNode(nodeId, options);
    if (!result?.ok) throw new Error(result?.error || '图片输出失败。');
    const finished = await waitImpl(() => {
      const node = mcpNode(latest, nodeId);
      return node.data.status === 'done' && node.data.processedResultId === result.resultId ? node : null;
    });
    return { node: nodeSummary(finished), resultNode: nodeSummary(mcpNode(latest, result.resultId)) };
  }
  const before = initial.data.queueJobId;
  const receipt = await latest.current.actions.generateNode(nodeId, options);
  if (receipt?.ok === false) throw agentReceiptError(receipt.code || 'SUBMISSION_FAILED', receipt.error, receipt.requestId ? { requestId: receipt.requestId } : {});
  if (!wait && receipt?.jobId) return { ...receipt, node: { id: nodeId, queueJobId: receipt.jobId, status: receipt.status } };
  const submitted = await waitImpl(() => {
    const node = mcpNode(latest, nodeId);
    if (node.data.status === 'error') throw new Error(node.data.error || '生成提交失败。');
    return node.data.queueJobId && node.data.queueJobId !== before ? node : null;
  }, 30000);
  if (!wait) return { node: nodeSummary(submitted), ...(submitted.data.modelPickNote ? { announcement: submitted.data.modelPickNote } : {}) };
  const finished = await waitImpl(() => {
    const node = mcpNode(latest, nodeId);
    if (node.data.queueJobId !== submitted.data.queueJobId) return null;
    if (['done', 'error', 'cancelled'].includes(node.data.status)) return node;
    return null;
  }, timeoutMs, 500);
  if (finished.data.status !== 'done') throw new Error(finished.data.error || `生成结束状态：${finished.data.status}`);
  const resultEdges = latest.current.edgesRef.current.filter((edge) => edge.source === nodeId && edge.targetHandle === 'preview');
  const resultEdge = resultEdges.find((edge) => mcpNode(latest, edge.target).data.sourcePromptId === submitted.data.promptId) || resultEdges.at(-1);
  const resultNode = resultEdge ? mcpNode(latest, resultEdge.target) : null;
  return { node: nodeSummary(finished), resultNode: nodeSummary(resultNode), ...(finished.data.modelPickNote ? { announcement: finished.data.modelPickNote } : {}) };
}

export async function waitForNodeForMcp(latest, { nodeId, jobId, attempt, timeoutMs = 300000 }, waitImpl = waitFor) {
  const initial = mcpNode(latest, nodeId);
  if (isVideoEdit(initial) || isVideoRhythm(initial) || isVideoChroma(initial) || isVideoRepair(initial) || isVideoPlate(initial)) {
    const jobKey = isVideoEdit(initial) ? 'videoEditJobId' : isVideoRhythm(initial) ? 'rhythmJobId' : isVideoChroma(initial) ? 'chromaJobId' : isVideoRepair(initial) ? 'repairJobId' : 'plateJobId';
    try {
      return { pending: false, ...await waitForVideoJob(latest, nodeId, jobKey, initial.data[jobKey], timeoutMs, waitImpl) };
    } catch (error) {
      if (!/超时|timeout/i.test(error.message)) throw error;
      return { pending: true, node: nodeSummary(mcpNode(latest, nodeId)), resultNode: null };
    }
  }
  if (initial.type === 'spriteAtlas') {
    if (!initial.data.spriteJobId) throw new Error('精灵图节点尚未提交任务。');
    try {
      const finished = await waitImpl(() => {
        const node = mcpNode(latest, nodeId);
        if (node.data.spriteJobId !== initial.data.spriteJobId) throw new Error('精灵图任务已更换。');
        return ['done', 'error', 'cancelled'].includes(node.data.status) ? node : null;
      }, timeoutMs, 500);
      return { pending: false, node: nodeSummary(finished), resultNode: null };
    } catch (error) {
      if (!/超时|timeout/i.test(error.message)) throw error;
      return { pending: true, node: nodeSummary(mcpNode(latest, nodeId)), resultNode: null };
    }
  }
  if (initial.type === 'native3d') {
    if (jobId && jobId !== initial.data.nativeJobId) throw Error('3D任务已更换。');
    return waitForNative3D(latest, nodeId, timeoutMs, waitImpl);
  }
  const promptId = initial.data.promptId;
  const queueJobId = initial.data.queueJobId;
  if (jobId && jobId !== queueJobId) throw agentReceiptError('JOB_CHANGED', '节点当前任务与原 jobId 不同。');
  if (!promptId && !queueJobId) throw new Error('这个节点还没有提交生成任务。');
  const assertAttempt = async () => {
    if (attempt === undefined) return;
    if (!queueJobId || !Number.isSafeInteger(attempt) || attempt < 1) throw agentReceiptError('BAD_REQUEST', '查询原轮次需要有效的作业 ID 和 attempt。');
    if ((await getGenerationJob(queueJobId)).attempts !== attempt) {
      throw agentReceiptError('ATTEMPT_CHANGED', '该作业已重新执行，不能把新轮次当作原任务。');
    }
  };
  await assertAttempt();
  let finished;
  try {
    finished = await waitImpl(() => {
      const node = mcpNode(latest, nodeId);
      const sameJob = queueJobId ? node.data.queueJobId === queueJobId : node.data.promptId === promptId;
      return sameJob && ['done', 'error', 'cancelled'].includes(node.data.status) ? node : null;
    }, timeoutMs, 500);
  } catch (error) {
    const message = String(error?.message || error);
    if (!message.includes('超时') && !/timeout/i.test(message)) throw error;
    const current = mcpNode(latest, nodeId);
    const pendingEdge = latest.current.edgesRef.current.find((edge) => edge.source === nodeId && edge.targetHandle === 'preview');
    return { pending: true, node: nodeSummary(current), resultNode: pendingEdge ? nodeSummary(mcpNode(latest, pendingEdge.target)) : null };
  }
  await assertAttempt();
  const resultEdge = latest.current.edgesRef.current.find((edge) => edge.source === nodeId && edge.targetHandle === 'preview');
  return { pending: false, node: nodeSummary(finished), resultNode: resultEdge ? nodeSummary(mcpNode(latest, resultEdge.target)) : null };
}

function patchDownloadNode(latest, nodeId, patch) {
  const apply = latest.current.actions.patchNode || latest.current.actions.updateNode;
  if (!apply) throw new Error('当前画布不能更新下载节点。');
  apply(nodeId, patch);
}

function newDownloadJobId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function rememberDownloadFailure(latest, nodeId, error) {
  const node = latest.current.nodesRef.current.find((item) => item.id === nodeId);
  if (!node || node.data.downloadStatus === 'done' || node.data.downloadStatus === 'failed') return Promise.resolve();
  const message = publicDownloadError(error);
  patchDownloadNode(latest, nodeId, {
    downloadStatus: 'failed', status: 'failed', downloadMessage: message, stage: message, error: message,
  });
  return Promise.resolve(latest.current.actions.persistProject?.()).catch(() => {});
}

// Runs the page's importVideoReference path. wait:false returns as soon as the
// download node shows the link and a queued job; the video node is created later
// by that same path. wait:true resolves with the new video node id.
export async function downloadVideoForMcp(latest, args = {}, waitImpl = waitFor) {
  const url = validatePublicVideoUrl(args?.url);
  const wait = args.wait === true;
  if (latest.current.actions.isVideoDownloadBusy?.()) throw new Error('另一段视频正在下载或保存，请完成后再导入。');
  const hasX = args.x !== undefined && args.x !== null;
  const hasY = args.y !== undefined && args.y !== null;
  let nodeId = args.nodeId;
  if (!nodeId && (hasX !== hasY || (hasX && !Number.isFinite(Number(args.x))) || (hasY && !Number.isFinite(Number(args.y))))) {
    throw new Error('新建下载节点时请同时提供有效的 x 和 y。');
  }
  if (nodeId) {
    const node = mcpNode(latest, nodeId);
    if (node.type !== 'note' || node.data.noteRole !== 'videoDownload') throw new Error('nodeId 必须是视频链接下载节点。');
  } else {
    const position = hasX ? { x: Number(args.x), y: Number(args.y) } : null;
    nodeId = latest.current.actions.addNode('note', { title: '视频链接下载', noteRole: 'videoDownload' }, position, false);
    await waitImpl(() => latest.current.nodesRef.current.find((node) => node.id === nodeId) || null);
  }
  const jobId = newDownloadJobId();
  patchDownloadNode(latest, nodeId, {
    downloadUrl: url,
    sourceUrl: url,
    downloadStatus: 'queued',
    status: 'queued',
    downloadMessage: '已排队，准备下载',
    stage: '已排队，准备下载',
    downloadJobId: jobId,
    videoNodeId: null,
    error: null,
  });
  try {
    await latest.current.actions.persistProject?.();
  } catch (error) {
    const message = publicDownloadError(error);
    patchDownloadNode(latest, nodeId, { downloadStatus: 'failed', status: 'failed', downloadMessage: message, stage: message, error: message });
    throw new Error(message || '下载节点尚未保存。');
  }
  if (!latest.current.actions.importVideoReference) {
    const message = '当前页面没有视频下载流程。';
    patchDownloadNode(latest, nodeId, { downloadStatus: 'failed', status: 'failed', downloadMessage: message, stage: message, error: message });
    throw new Error(message);
  }
  const task = Promise.resolve().then(() => latest.current.actions.importVideoReference(url, nodeId)).catch(async (error) => {
    await rememberDownloadFailure(latest, nodeId, error);
    throw new Error(publicDownloadError(error));
  });
  if (!wait) {
    task.catch(() => {});
    return { nodeId, jobId, status: 'queued', message: '已排队，准备下载' };
  }
  const videoNodeId = await task;
  return { nodeId, jobId, status: 'done', videoNodeId, message: '下载完成' };
}

function agentReceiptError(code, message, fields = {}) {
  return Object.assign(new Error(message), { agentReceipt: { code, ...fields } });
}

function sameAgentValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && sameAgentValue(left[key], right[key]));
}

export function useCanvasMcp({ nodesRef, edgesRef, projectName, projectId, readOnly = false, server, actions, getAgentState, commitAgentEdit }) {
  const latest = useRef(null);
  latest.current = { nodesRef, edgesRef, projectName, projectId, readOnly, server, actions, getAgentState, commitAgentEdit };

  useEffect(() => registerCanvasMcp(latest), [projectId, readOnly]);
}

// Registration is shared by the mounted page and isolated protocol tests.
export function registerCanvasMcp(latest, { context = document.modelContext, startPage = startCurrentCanvasPage } = {}) {
    const controller = new AbortController();
    const ownedAnalyses = new Map();
    const getNode = (id) => {
      const node = latest.current.nodesRef.current.find((item) => item.id === id);
      if (!node) throw new Error(`找不到节点：${id}`);
      return node;
    };
    const getAgentState = () => {
      const state = latest.current.getAgentState?.();
      if (!state) throw agentReceiptError('STATE_UNAVAILABLE', '当前页面尚未提供保存与视口状态。');
      return state;
    };
    const requireSavedRevision = (expectedRevision) => {
      const { save } = getAgentState();
      if (save.revision !== expectedRevision) {
        throw agentReceiptError('REVISION_CONFLICT', '保存修订已变化，请重新读取当前页。', { save });
      }
      if (save.state !== 'saved') {
        throw agentReceiptError('SAVE_PENDING', '当前页尚未保存或暂不可编辑。', { save });
      }
    };
    const respond = (callback) => async (args = {}, options = {}) => {
      try {
        const result = await callback(args, options);
        return JSON.stringify({ ok: true, ...result });
      } catch (error) {
        const glbError = ['NATIVE3D_GLB_LAYOUT_UNSUPPORTED','NATIVE3D_GLB_INVALID'].includes(error?.code);
        return JSON.stringify({ ok: false, error: error?.message || String(error),
          ...(glbError ? {code:error.code,details:error.details} : {}), ...error?.agentReceipt });
      }
    };
    const analysisSource = (nodeId) => {
      if (!isVideoEdit(getNode(nodeId))) throw new Error('请先选择视频编辑节点。');
      const { projectId, nodesRef, edgesRef } = latest.current;
      return { projectId, inputs: videoEditInputView(nodeId, nodesRef.current, edgesRef.current, (path) => path) };
    };
    const ownsAnalysis = ({ projectId, nodeId, slot, assetPath }) => {
      if (controller.signal.aborted || latest.current.readOnly || latest.current.projectId !== projectId) return false;
      if (!latest.current.nodesRef.current.some((node) => node.id === nodeId && isVideoEdit(node))) return false;
      return analysisSource(nodeId).inputs[slot]?.assetPath === assetPath;
    };
    const releaseAnalysis = (jobId, cancel = false) => {
      const owner = ownedAnalyses.get(jobId);
      if (!owner) return;
      clearTimeout(owner.timer);
      ownedAnalyses.delete(jobId);
      if (cancel) cancelVideoEditJob(jobId, owner.projectId, { keepalive: true }).catch(() => {});
    };
    const cancelOwnedAnalyses = () => {
      for (const jobId of ownedAnalyses.keys()) releaseAnalysis(jobId, true);
    };
    function watchAnalysis(jobId, owner) {
      owner.timer = setTimeout(async () => {
        if (!ownsAnalysis(owner)) { releaseAnalysis(jobId, true); return; }
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
          const job = await getVideoEditJob(jobId, { signal });
          if (!['queued', 'running'].includes(job.status)) { releaseAnalysis(jobId); return; }
        } catch (error) {
          if (error.status === 404) { releaseAnalysis(jobId); return; }
        }
        if (ownedAnalyses.has(jobId)) watchAnalysis(jobId, owner);
      }, 2000);
    }
    const readAnalysis = async (nodeId, jobId) => {
      if (typeof jobId !== 'string' || !/^ved_[a-f0-9]{32}$/.test(jobId)) throw new Error('分析任务 ID 无效。');
      const { projectId } = analysisSource(nodeId);
      const job = await getVideoEditJob(jobId, { signal: controller.signal });
      if (!job.mode || job.nodeId !== nodeId || job.projectId !== projectId || latest.current.projectId !== projectId) {
        throw new Error('分析任务不属于当前画布节点。');
      }
      if (!['queued', 'running'].includes(job.status)) releaseAnalysis(jobId);
      return job;
    };
    const imagePickInput = (node, prompt) => ({
      data: node.data,
      mode: node.data.mode,
      prompt,
      referenceCount: node.data.mode === 'qwenEdit' ? qwenCanvasReferences(node, latest.current.nodesRef.current, latest.current.edgesRef.current).length : 0,
      hasMask: latest.current.edgesRef.current.some((edge) => edge.target === node.id && edge.targetHandle === 'mask'),
      hasSourceCrop: Boolean(node.data.qwenSourceCrop),
      hasMaskCrop: Boolean(node.data.qwenMaskCrop),
      history: latest.current.actions.getImageModelHistory?.() || [],
    });
    const tools = [
      {
        name:'canvas_move_nodes',description:'仅移动指定的1至30个当前节点，保留其余节点位置。',
        inputSchema:schema({nodes:{type:'array',minItems:1,maxItems:30,items:schema({nodeId:nodeIdProperty,x:{type:'number'},y:{type:'number'}},['nodeId','x','y'])}},['nodes']),
        execute:respond(async ({nodes})=>({nodes:(await latest.current.actions.moveNodes(nodes)).map(nodeSummary)})),
      },
      {
        name:'canvas_native3d_diagnostic_preview',description:'将同一失败UV任务的真实临时图集/棋盘诊断保存到原卡片供检查；不清除失败、不创建合格模型、不允许烘焙。',
        inputSchema:schema({nodeId:nodeIdProperty},['nodeId']),execute:respond(async({nodeId})=>latest.current.actions.native3dDiagnosticPreview(nodeId)),
      },
      {
        name:'canvas_native3d_viewer_close',description:'关闭当前共享3D审阅面板，回到画布卡片，不修改模型或执行生成。',
        inputSchema:schema(),execute:respond(async()=>latest.current.actions.native3dViewerClose()),
      },
      {
        name:'canvas_link_native3d_process',description:'仅为已保存诊断图和模型记录非执行流程证据，固定虚线图例，不改变真实模型输入、不运行生成。',
        inputSchema:schema({edges:{type:'array',minItems:1,maxItems:24,items:schema({sourceId:nodeIdProperty,targetId:nodeIdProperty,kind:{type:'string',enum:['source','partition','ao_review','mapping','uv_evidence']}},['sourceId','targetId','kind'])}},['edges']),
        execute:respond(async request=>latest.current.actions.linkNativeProcess(request)),
      },
      {
        name:'canvas_link_native3d_diagnostic',description:'将当前页已上传诊断图关联到1至4个已保存模型素材，添加标明诊断参考的来源线；不是生成或UV验收。',
        inputSchema:schema({imageId:nodeIdProperty,sourceIds:{type:'array',minItems:1,maxItems:4,items:nodeIdProperty}},['imageId','sourceIds']),
        execute:respond(async request=>latest.current.actions.linkNativeDiagnostic(request)),
      },
      {
        name:'canvas_native3d_plan_review',description:'在当前画布共享3D面板打开真实低模、切缝候选、分区与AO；不展开UV。',
        inputSchema:schema({nodeId:nodeIdProperty},['nodeId']),
        execute:respond(async({nodeId})=>latest.current.actions.native3dPlanReview(nodeId)),
      },
      {
        name:'canvas_native3d_plan_confirm',description:'确认已在当前页3D面板成功加载且身份未变化的切缝方案。绑定planSha256，不运行UV。',
        inputSchema:schema({nodeId:nodeIdProperty,planSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},['nodeId','planSha256']),
        execute:respond(async({nodeId,planSha256})=>latest.current.actions.native3dPlanConfirm(nodeId,planSha256)),
      },
      {
        name: 'canvas_native3d_uv_preview', description: '为已完成UV节点及其对应结果保存真实切缝、表面棋盘预览；AO任务另读取原始AO依据和候选缝。不改模型、不重跑UV，通过当前页面保存。',
        inputSchema: schema({nodeId:nodeIdProperty},['nodeId']),
        execute: respond(async ({nodeId}) => latest.current.actions.native3dUVPreview(nodeId)),
      },
      {
        name: 'canvas_recover_native3d', description: '从同一项目备份恢复缺失3D节点及连线，保留当前所有已有节点与编辑，不执行生成，通过当前页面正常保存。',
        inputSchema: schema({projectId:{type:'string'},backupRevision:{type:'integer',minimum:1,maximum:999999999}},['projectId','backupRevision']),
        execute: respond(async fragment => latest.current.actions.recoverNative3D(fragment)),
      },
      {
        name: 'canvas_native3d_capabilities', description: '读取本机3D操作与执行器的就绪状态和精确参数schema。',
        inputSchema: schema(), annotations: { readOnlyHint: true },
        execute: respond(async () => latest.current.actions.native3dCapabilities()),
      },
      {
        name:'canvas_native3d_retry_stage',description:'仅从当前LOD结果节点重试该单档LOD，保留旧结果；运行时验证原任务与已通过父档并自动选新seed，不接受路径或seed覆盖。',
        inputSchema:schema({nodeId:nodeIdProperty},['nodeId']),
        execute:respond(async (request, options)=>{
          if(!request||Object.keys(request).some(key=>key!=='nodeId')||typeof request.nodeId!=='string')throw new Error('仅允许指定LOD结果nodeId。');
          const node=nativeOutputNode(latest.current.nodesRef.current.find(n=>n.id===request.nodeId));
          if(node?.type!=='native3d'||node.data?.operation!=='analyze'||node.data.metadata?.operation!=='source_lod')throw new Error('必须选择真实LOD结果节点。');
          return latest.current.actions.native3dRetryStage(request.nodeId,{...options.generation,origin:'agent'});
        }),
      },
      {
        name:'canvas_native3d_stage',description:'从已接受修复减面结果创建fit或lod_N的真实阶段模型节点；同任务同阶段幂等更新标题、处理来源和真实阶段缩略图；实线为阶段输出、虚线为高模参考，不重新分析模型。diagnostic=true仅展示已登记失败阶段，保留blocked状态且禁止下游。',
        inputSchema:schema({diagnostic:{type:'boolean'},sourceId:nodeIdProperty,stage:{type:'string',pattern:'^(fit|lod_[1-9][0-9]{0,5}|lod[0-4])$'},title:{type:'string',maxLength:160},x:{type:'number'},y:{type:'number'}},['sourceId','stage']),
        execute:respond(async request=>{
          const result=await latest.current.actions.native3dStage(request);
          return {node:nodeSummary(result.node),existing:result.existing};
        }),
      },
      {
        name:'canvas_move_nodes',description:'仅移动指定的1至30个当前节点，保留其余节点位置。',
        inputSchema:schema({nodes:{type:'array',minItems:1,maxItems:30,items:schema({nodeId:nodeIdProperty,x:{type:'number'},y:{type:'number'}},['nodeId','x','y'])}},['nodes']),
        execute:respond(async ({nodes})=>({nodes:(await latest.current.actions.moveNodes(nodes)).map(nodeSummary)})),
      },
      {
        name: 'canvas_get_state',
        description: '读取当前 H3 画布的真实节点 ID、连线和生成状态。默认省略长提示词以避免大画布占用过多上下文；需要提示词时设 includePrompt 为 true，也可用 nodeId 只读取一个节点。compact:true 只读保存修订、本地视口、节点数及可选目标节点摘要。',
        inputSchema: schema({
          nodeId: { type: 'string', description: '可选，只返回这个节点及其相关连线。' },
          includePrompt: { type: 'boolean', description: '是否包含完整提示词和备注，默认 false。' },
          compact: { type: 'boolean', description: '回传简明状态，省略拓扑和正文。' },
        }),
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: respond(async ({ nodeId, includePrompt = false, compact = false }) => {
          if (compact) {
            const node = nodeId ? getNode(nodeId) : null;
            const { projectId, nodesRef } = latest.current;
            return { projectId, ...getAgentState(), nodeCount: nodesRef.current.length,
              ...(node ? { node: { id: node.id, type: node.type, title: String(node.data.title ?? '').slice(0, 120),
                status: typeof node.data.status === 'string' ? node.data.status.slice(0, 64) : null } } : {}) };
          }
          const nodes = nodeId ? [getNode(nodeId)] : latest.current.nodesRef.current;
          const ids = new Set(nodes.map((node) => node.id));
          return {
            projectName: latest.current.projectName,
            server: latest.current.server,
            nodeCount: latest.current.nodesRef.current.length,
            nodes: nodes.map((node) => {
              const summary = nodeSummary(node, includePrompt, { nodes: latest.current.nodesRef.current, edges: latest.current.edgesRef.current });
              if (node.data.mode !== 'qwenEdit') return summary;
              const references = qwenCanvasReferences(node, latest.current.nodesRef.current, latest.current.edgesRef.current);
              return { ...summary, maskNodeId: latest.current.edgesRef.current.find((edge) => edge.target === node.id && edge.targetHandle === 'mask')?.source || null, referenceNodeIds: references.map((ref) => ref.id), referenceCount: references.length,
                ...(includePrompt ? { prompt: displayQwenPrompt(node.data.prompt, references) } : {}) };
            }),
            edges: latest.current.edgesRef.current.filter((edge) => !nodeId || ids.has(edge.source) || ids.has(edge.target)).map(edgeSummary),
          };
        }),
      },
      {
        name: 'canvas_open_reference_library',
        description: '在当前画布内打开衣装、姿势或 Refmuse 参考库。不下载、不生成、不改项目。返回容器及首页来源，不能确认外站内容加载成功。',
        inputSchema: schema({ library: { type: 'string', enum: ['costume', 'pose', 'refmuse'] } }, ['library']),
        annotations: { readOnlyHint: true },
        execute: respond(async ({ library }) => latest.current.actions.openReferenceLibrary(library)),
      },
      {
        name: 'canvas_inspect_node',
        description: '在当前画布内打开节点的 ComfyUI 工作流查看副本；可指定 stage。读取真实任务记录，不生成、不保存参数，只有图导入确认后才返回 opened。',
        inputSchema: schema({ nodeId: nodeIdProperty, stage: { type: 'string', description: '可选阶段，如 front_portrait、three_quarter_portrait、back_body、front_body、stitch。' } }, ['nodeId']),
        annotations: { readOnlyHint: true },
        execute: respond(async ({ nodeId, stage }) => {
          getNode(nodeId);
          return latest.current.actions.inspectNode(nodeId, stage);
        }),
      },
      {
        name: 'canvas_create_extension',
        description: '从已导入的本地工作流包创建单个生成节点，固定摘要与节点定义；通过当前页面保存。',
        inputSchema: schema({ digest: { type: 'string' }, nodeDefinitionId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, focus: { type: 'boolean' } }, ['digest', 'nodeDefinitionId']),
        execute: respond(async ({ digest, nodeDefinitionId, x, y, focus = false }) => {
          const id = await latest.current.actions.createExtensionNode(digest, nodeDefinitionId, Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null, focus);
          return { node: nodeSummary(await waitFor(() => latest.current.nodesRef.current.find((node) => node.id === id))) };
        }),
      },
      {
        name: 'canvas_create_node',
        description: '在当前可见画布创建一个真实节点，使用与用户界面相同的节点和持久化逻辑。可用于准备图生图、视频、素材或备注测试。',
        inputSchema: schema({
          preset: { type: 'string', enum: Object.keys(availableNodePresets(NODE_PRESETS)), description: '当前已启用的节点预设。图生图用 qwen_edit，素材用 image_asset；本机实验工具仅在本机注册后可用。' },
          title: { type: 'string', description: '可选节点标题。' },
          prompt: { type: 'string', description: '可选初始提示词。' },
          text: { type: 'string', description: '备注节点的可选正文。' },
          x: { type: 'number', description: '可选画布世界坐标 X。' },
          y: { type: 'number', description: '可选画布世界坐标 Y。' },
          focus: { type: 'boolean', description: '是否移动视口到新节点，默认 false。' },
        }, ['preset']),
        execute: respond(async ({ preset, title, prompt, text, x, y, focus = false }) => {
          const definition = availableNodePresets(NODE_PRESETS)[preset];
          if (!definition) throw new Error(`未知节点预设：${preset}`);
          const [type, defaults] = definition;
          const extra = { ...defaults };
          if (title !== undefined) extra.title = title;
          if (prompt !== undefined) extra.prompt = prompt;
          if (text !== undefined) extra.text = text;
          const position = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
          const id = latest.current.actions.addNode(type, extra, position, focus);
          const node = await waitFor(() => latest.current.nodesRef.current.find((item) => item.id === id));
          return { node: nodeSummary(node) };
        }),
      },
      {
        name: 'canvas_start_video_analysis',
        description: '分析当前视频编辑节点已连线的项目视频。transcript 本地转写旁白并返回源时间码，black 和 silence 提议剪口。先取得 jobId，再调用 canvas_get_video_analysis 获取结果。',
        inputSchema: schema({ nodeId: nodeIdProperty, slot: { type: 'string', enum: VIDEO_EDIT_VIDEO_PORTS },
          mode: { type: 'string', enum: ['black', 'silence', 'transcript'] } }, ['nodeId', 'slot', 'mode']),
        execute: respond(async ({ nodeId, slot, mode }) => {
          if (!VIDEO_EDIT_VIDEO_PORTS.includes(slot) || !['black', 'silence', 'transcript'].includes(mode)) throw new Error('分析端口或方式无效。');
          const { projectId, inputs } = analysisSource(nodeId);
          const assetPath = inputs[slot]?.assetPath;
          if (!assetPath) throw new Error('请先将该端口的视频导入项目素材。');
          const owner = { projectId, nodeId, slot, assetPath };
          const job = await submitVideoAnalysis({ ...owner, mode });
          if (!ownsAnalysis(owner)) {
            await cancelVideoEditJob(job.id, projectId, { keepalive: true }).catch(() => {});
            throw new Error('当前画布或素材已更换，分析已取消。');
          }
          ownedAnalyses.set(job.id, owner);
          watchAnalysis(job.id, owner);
          return { jobId: job.id, status: job.status, mode, slot };
        }),
      },
      {
        name: 'canvas_get_video_analysis',
        description: '查询素材分析。转写分页返回源时间毫秒与讲解原文。includeWords:true 时返回模型实际识别的词或短语时间，用于安排口播动效。缺失时序的词应复核原片。',
        inputSchema: schema({ nodeId: nodeIdProperty, jobId: { type: 'string' },
          offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 30 },
          includeWords: { type: 'boolean' } }, ['nodeId', 'jobId']),
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: respond(async ({ nodeId, jobId, offset = 0, limit = 20, includeWords = false }) => {
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30 || typeof includeWords !== 'boolean') throw new Error('转写分页参数无效。');
          const job = await readAnalysis(nodeId, jobId);
          const { inputs } = analysisSource(nodeId);
          if (!Object.entries(job.inputs).every(([slot, path]) => inputs[slot]?.assetPath === path)) {
            throw new Error('分析后输入素材已更换，请重新分析。');
          }
          const summary = { jobId, status: job.status, stage: job.stage, mode: job.mode, progress: job.progress, error: job.error };
          if (!job.result || job.mode !== 'transcript') return { ...summary, result: job.result };
          const { segments, source, language, durationMs, wordTimingsTruncated } = job.result;
          const page = [];
          const encoder = new TextEncoder();
          let bytes = 0;
          for (const { startMs, endMs, text, words } of segments.slice(offset, offset + limit)) {
            const segment = { startMs, endMs, text, ...(includeWords && words?.length ? { words } : {}) };
            bytes += encoder.encode(JSON.stringify(segment)).length + 1;
            if (bytes > 64 * 1024 && page.length) break;
            page.push(segment);
          }
          const nextOffset = offset + page.length < segments.length ? offset + page.length : null;
          return { ...summary, result: { segments: page, source, language, durationMs, segmentCount: segments.length, nextOffset,
            ...(includeWords && wordTimingsTruncated ? { wordTimingsTruncated: true } : {}) } };
        }),
      },
      {
        name: 'canvas_cancel_video_analysis',
        description: '取消当前视频编辑节点指定的素材分析，不影响其他导出作业。',
        inputSchema: schema({ nodeId: nodeIdProperty, jobId: { type: 'string' } }, ['nodeId', 'jobId']),
        execute: respond(async ({ nodeId, jobId }) => {
          const job = await readAnalysis(nodeId, jobId);
          const cancelled = await cancelVideoEditJob(jobId, job.projectId);
          releaseAnalysis(jobId);
          return { jobId, status: cancelled.status, stage: cancelled.stage };
        }),
      },
      {
        name: 'canvas_set_motion_canvas_preview',
        description: '通过可见视频编辑节点保存 Motion Canvas 流程动效预览。完整保留所选区间的原声。根据 canvas_get_video_analysis 的词或短语时间选择触发点。时间为源视频绝对毫秒，Agent 只提交内容和时间数据。',
        inputSchema: schema({ nodeId: nodeIdProperty, slot: { type: 'string', enum: VIDEO_EDIT_VIDEO_PORTS },
          transcriptJobId: { type: 'string', description: '用于核对转写时间与当前素材的已完成转写任务。' },
          sourceInMs: { type: 'integer', minimum: 0 }, sourceOutMs: { type: 'integer', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 42 },
          cues: { type: 'array', minItems: 1, maxItems: MOTION_CANVAS_MAX_CUES, items: schema({
            atMs: { type: 'integer', minimum: 0 }, label: { type: 'string', minLength: 1, maxLength: 24 },
            detail: { type: 'string', minLength: 1, maxLength: 52 },
          }, ['atMs', 'label', 'detail']) },
        }, ['nodeId', 'slot', 'transcriptJobId', 'sourceInMs', 'sourceOutMs', 'title', 'cues']),
        execute: respond(async ({ nodeId, transcriptJobId, ...plan }) => {
          const preview = normalizeMotionCanvasPreview(plan);
          const job = await readAnalysis(nodeId, transcriptJobId);
          if (job.mode !== 'transcript' || job.status !== 'completed') throw new Error('请先完成该素材的语音转写。');
          const { inputs } = analysisSource(nodeId);
          const assetPath = inputs[preview.slot]?.assetPath;
          if (!assetPath) throw new Error('请先将该端口的视频导入项目素材。');
          if (latest.current.readOnly || job.inputs[preview.slot] !== assetPath) throw new Error('画布或素材已更换，请重新分析。');
          const { durationMs, source } = job.result;
          if (source?.audioOffset?.num !== 0) throw new Error('试验仅支持首帧与音轨同时开始的素材，请先导出一份已对齐的片段。');
          if (!Number.isSafeInteger(durationMs) || preview.sourceOutMs > durationMs) throw new Error('动效预览结束时间超出源视频。');
          const motionCanvasPreview = { ...preview, assetPath };
          latest.current.actions.updateNode(nodeId, { motionCanvasPreview });
          await waitFor(() => getNode(nodeId).data.motionCanvasPreview === motionCanvasPreview);
          return { nodeId, cueCount: motionCanvasPreview.cues.length };
        }),
      },
      {
        name: 'canvas_set_video_presentation',
        description: '为当前视频编辑节点设置可编辑的演示轨，按成片帧落位，保留剪辑和原声。根据转写的讲解分段安排页标题和要点。传空数组可清空演示轨。',
        inputSchema: schema({ nodeId: nodeIdProperty, pages: { type: 'array', maxItems: 48, items: schema({
          id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
          startFrame: { type: 'integer', minimum: 0 }, endFrame: { type: 'integer', minimum: 1, description: '结束帧不含。页面按起始帧顺序排列，区间不能重叠。' },
          title: { type: 'string', minLength: 1, maxLength: 80 },
          bullets: { type: 'array', maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 96 } },
          layout: { type: 'string', enum: ['fullscreen', 'side'], description: '全屏演示或右侧要点卡。' },
          motion: { type: 'string', enum: ['none', 'fade', 'reveal'], description: '直接出现、淡入淡出或逐项显示。' },
        }, ['id', 'startFrame', 'endFrame', 'title', 'bullets', 'layout', 'motion']) } }, ['nodeId', 'pages']),
        execute: respond(async ({ nodeId, pages }) => {
          const node = getNode(nodeId);
          if (!isVideoEdit(node)) throw new Error('演示轨只用于视频编辑节点。');
          if (['queued', 'running'].includes(node.data.status)) throw new Error('正在导出，请在结束后修改演示轨。');
          const editDocument = normalizeVideoEditDocument({ ...node.data.editDocument, presentation: pages });
          latest.current.actions.updateNode(nodeId, { editDocument, error: null });
          await waitFor(() => getNode(nodeId).data.editDocument === editDocument);
          return { nodeId, pageCount: editDocument.presentation?.length || 0 };
        }),
      },
      {
        name: 'canvas_update_node',
        description: '修改当前画布节点的标题、提示词、备注或受支持的生成参数。只允许白名单参数，不会绕过节点校验。',
        inputSchema: schema({
          nodeId: nodeIdProperty,
          expectedRevision: { type: 'integer', minimum: 1, description: '从 compact 状态读取的保存修订。提供时仅在修订一致且页面已保存时修改，并回传简明保存结果。' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          text: { type: 'string' },
          settings: { type: 'object', description: '自定义工作流使用 workflowParameters 对象，键来自 workflowDefinition.parameters.properties；仅支持声明的标量参数。内置节点可选参数包含 qwenModel（standard/turbo/flux3_klein/h3_image）、h3ImageResolution（4MP/16MP，仅H3-Image）、flux3Resolution（1MP/2K/4K，仅 FLUX 3）、qwenCacheDevice（auto/cpu，仅 Qwen 图生图和角色四视图，默认 auto；cpu 使用 default 精度参考缓存）、outfitModel（qwen21/qwen21_turbo/muse_v4）、outfitUpscale（auto/off/seedvr2_7b）、upscaleModel（seedvr2_3b/seedvr2_7b）、outfitHdScale、museSteps，以及 ratio、resolution、duration、turbo、seed、characterSheetAngleSeed（45° 头像独立种子，默认 2096285145，非负安全整数）、randomSeed、refImageSize、qwenSteps、qwenRefResolution、imageLora、loraStrength、imageScale、outfitPreset、outfitPanel、outfitLayout、outfitPanels、outfitDenoise、targetQuery、targetDescription、targetSelection、targetIndex。outfitLayout 支持 legacy、mixedGrid、equalGrid、horizontal、custom；custom 时 outfitPanels 为 4 个含 id、role、view、x、y、width、height 的面板，坐标使用 0–1 比例。' },
        }, ['nodeId']),
        execute: respond(async ({ nodeId, title, prompt, text, settings = {}, expectedRevision }) => {
          const projectId = latest.current.projectId;
          if (expectedRevision !== undefined) {
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
              throw agentReceiptError('BAD_REQUEST', 'expectedRevision 必须为正整数。');
            }
            requireSavedRevision(expectedRevision);
          }
          const current = getNode(nodeId);
          if (current.data.noteRole === 'videoDownload') {
            if (latest.current.actions.isVideoDownloadBusy?.() && ['queued', 'downloading'].includes(current.data.downloadStatus)) throw new Error('节点正在下载，请完成后再修改。');
          } else if (['uploading', 'queued', 'running', 'finishing'].includes(current.data.status)) throw new Error('节点正在生成，请先完成或取消后再修改。');
          if (current.type !== 'native3d' && ('adapterId' in settings || 'nativeParameters' in settings)) throw new Error('3D参数仅支持3D节点。');
          if ('nativeParameters' in settings && (!settings.nativeParameters || typeof settings.nativeParameters !== 'object' || Array.isArray(settings.nativeParameters))) throw new Error('nativeParameters 必须为参数对象。');
          const unknown = Object.keys(settings).filter((key) => !EDITABLE_SETTINGS.has(key));
          if (unknown.length) throw new Error(`不支持的参数：${unknown.join(', ')}`);
          if ('spriteInputPath' in settings || 'spriteOptions' in settings) {
            if (current.type !== 'spriteAtlas') throw new Error('精灵图参数仅用于精灵图节点。');
            spriteSnapshot({ ...current.data, ...settings });
          }
          if ('speed' in settings || 'rhythmAudio' in settings) {
            if (current.type !== 'videoSpeed') throw new Error('速度参数仅用于恒定速度节点。');
            normalizeSpeedDocument({ schemaVersion: 1, speed: settings.speed ?? current.data.speed, audio: settings.rhythmAudio ?? current.data.rhythmAudio });
          }
          if ('remapKeyframes' in settings) { if (current.type !== 'videoTimeRemap') throw new Error('曲线参数仅用于时间重映射节点。'); normalizeRemapDocument({ schemaVersion: 1, keyframes: settings.remapKeyframes }); }
          if (CHROMA_FIELDS.some(key => key in settings && !(key === 'previewTime' && isVideoRepair(current)))) { if (!isVideoChroma(current)) throw new Error('绿幕参数仅用于绿幕合成节点。'); chromaDocumentFromNode({ ...current.data, ...settings }); if ('previewTime' in settings) normalizePreviewTime(settings.previewTime); }
          if ('editDocument' in settings && !isVideoEdit(current)) throw new Error('editDocument 仅适用于视频编辑节点。');
          validateModelSettings(settings, current.data.mode ?? '');
          const patch = { ...settings };
          if (PLATE_FIELDS.some(key => key in settings)) { if (!isVideoPlate(current)) throw new Error('绿幕白模参数仅用于白模节点。'); const normalized = plateDocumentFromNode({ ...current.data, ...settings }); for (const key of PLATE_FIELDS) if (key in settings) patch[key] = normalized[key]; }
          if ('repairSettings' in settings && !isVideoRepair(current)) throw new Error('repairSettings 仅用于局部修补。');
          if (isVideoRepair(current)) { if ('repairSettings' in settings) patch.repairSettings = normalizeRepairDocument(settings.repairSettings); if ('previewTime' in settings) patch.previewTime = normalizeRepairPreviewTime(settings.previewTime); }
          if (current.type === 'videoChromaKey' && CHROMA_FIELDS.some((key) => key in settings)) {
            const merged = chromaDocumentFromNode({ ...current.data, ...settings });
            const exported = {
              keyColor: merged.keyColor, similarity: merged.similarity, blend: merged.blend, despill: merged.despill,
              choke: merged.choke, feather: merged.feather,
              secondKey: merged.secondKey, secondKeyColor: merged.secondKeyColor, secondSimilarity: merged.secondSimilarity, secondBlend: merged.secondBlend,
              scale: merged.scale, offsetX: merged.offsetX, offsetY: merged.offsetY,
              anchor: merged.anchor, backgroundFit: merged.backgroundFit, outputSize: merged.outputSize,
              chromaAudio: merged.audio, startOffset: merged.startOffset,
            };
            for (const [key, value] of Object.entries(exported)) if (key in settings) patch[key] = value;
            if ('previewTime' in settings) patch.previewTime = normalizePreviewTime(settings.previewTime);
          }

          if ('editDocument' in settings) patch.editDocument = normalizeVideoEditDocument(settings.editDocument);
          if ('workflowParameters' in settings) patch.workflowParameters = validateWorkflowParameters(current.data, settings.workflowParameters);
          if (title !== undefined) patch.title = title;
          if (prompt !== undefined) { patch.prompt = current.data.mode === 'qwenEdit' ? bindQwenPrompt(prompt, qwenCanvasReferences(current, latest.current.nodesRef.current, latest.current.edgesRef.current)) : prompt; patch.outfitPreset = null; }
          if (text !== undefined) patch.text = text;
          const activeField = current.data.mode === 'image' ? 'imageModel' : current.data.mode === 'qwenEdit' ? 'qwenModel' : null;
          if (activeField && Object.hasOwn(settings, activeField)) {
            const decision = planImageModelPick({ ...imagePickInput(current, prompt ?? current.data.prompt), requestedModel: settings[activeField], install: await readImageModelInstall(), data: { ...current.data, modelLockedByUser: false } });
            if (!decision.ok) throw new Error(decision.error);
            Object.assign(patch, decision.patch);
          }
          if (expectedRevision !== undefined) {
            if (controller.signal.aborted || latest.current.projectId !== projectId) {
              throw agentReceiptError('PROJECT_CHANGED', '页面已切换，修改未提交。');
            }
            requireSavedRevision(expectedRevision);
            if (getNode(nodeId) !== current) {
              throw agentReceiptError('NODE_CHANGED', '节点状态已变化，请重新读取当前页。');
            }
            const fields = Object.keys(patch);
            const changedFields = fields.filter((key) => !sameAgentValue(current.data[key], patch[key]));
            const receipt = { projectId, nodeId, changedFields, execution: 'not_requested' };
            if (!changedFields.length) return { ...receipt, save: { state: 'unchanged', revision: expectedRevision } };
            let saved;
            try {
              saved = await latest.current.commitAgentEdit(nodeId, patch);
            } catch (error) {
              const currentPage = !controller.signal.aborted && latest.current.projectId === projectId;
              const data = currentPage && latest.current.nodesRef.current.find((node) => node.id === nodeId)?.data;
              throw agentReceiptError(error.code || 'SAVE_FAILED', error.message, {
                ...(currentPage ? { save: getAgentState().save } : {}),
                localChangesRetained: Boolean(data && fields.every((key) => sameAgentValue(data[key], patch[key]))),
              });
            }
            if (controller.signal.aborted || latest.current.projectId !== projectId) {
              throw agentReceiptError('PROJECT_CHANGED', '页面已切换，请核对原项目的保存结果。');
            }
            if (!saved?.node?.data || !Number.isSafeInteger(saved.revision) || saved.revision <= expectedRevision
                || !fields.every((key) => sameAgentValue(saved.node.data[key], patch[key]))) {
              throw agentReceiptError('SAVE_UNVERIFIED', '保存响应未确认这些目标字段。', { save: getAgentState().save });
            }
            return { ...receipt, save: { state: 'saved', revision: saved.revision } };
          }
          latest.current.actions.updateNode(nodeId, patch);
          const node = await waitFor(() => {
            const current = getNode(nodeId);
            return Object.entries(patch).every(([key, value]) => current.data[key] === value) ? current : null;
          });
          return { node: nodeSummary(node) };
        }),
      },
      {
        name: 'canvas_pick_image_model',
        description: '为文生图或图生图节点自动选择已安装且兼容的模型，并写入现有 imageModel 或 qwenModel。用户点名或该节点已手动锁定时不改下拉。点名的模型未安装时返回缺项，不会换成别的模型。',
        inputSchema: schema({
          nodeId: nodeIdProperty,
          model: { type: 'string', description: '可选。点名 krea2、moss、h3_image、flux3_klein、standard 或 turbo；未安装时失败且不替换。' },
          prompt: { type: 'string', description: '可选。只用于判断任务类型，不改节点提示词。省略时用节点上的提示词。' },
        }, ['nodeId']),
        execute: respond(async ({ nodeId, model, prompt }) => {
          const node = getNode(nodeId);
          if (!['image', 'qwenEdit'].includes(node.data.mode)) throw new Error('自动选模只用于文生图或图生图节点。');
          const decision = planImageModelPick({ ...imagePickInput(node, prompt === undefined ? node.data.prompt || '' : prompt), requestedModel: model, install: await readImageModelInstall() });
          if (!decision.ok) throw new Error(decision.error);
          if (decision.patch && Object.keys(decision.patch).length) {
            latest.current.actions.updateNode(nodeId, decision.patch);
            await waitFor(() => {
              const current = getNode(nodeId);
              return Object.entries(decision.patch).every(([key, value]) => current.data[key] === value) ? current : null;
            });
          }
          const current = getNode(nodeId);
          return {
            announcement: decision.announcement, field: decision.field, model: decision.model || current.data[decision.field] || null,
            taskType: decision.taskType, locked: Boolean(current.data.modelLockedByUser), changed: Boolean(decision.changed), offline: Boolean(decision.offline),
          };
        }),
      },
      {
        name: 'canvas_review_image',
        description: '记录文生图或图生图结果的收下或否掉。写入节点 imageReview，并追加到项目 settings.imageModelHistory，供之后自动选模按 30 天半衰期使用。',
        inputSchema: schema({
          nodeId: nodeIdProperty,
          accepted: { type: 'boolean', description: 'true 为收下，false 为否掉。' },
        }, ['nodeId', 'accepted']),
        execute: respond(async ({ nodeId, accepted }) => {
          if (typeof accepted !== 'boolean') throw new Error('accepted 必须是布尔值。');
          const reviewed = latest.current.actions.reviewImageNode(nodeId, accepted);
          const node = await waitFor(() => {
            const current = getNode(reviewed.id);
            return current.data.imageReview?.accepted === accepted ? current : null;
          });
          return { node: nodeSummary(node), review: reviewed.review, historyCount: (latest.current.actions.getImageModelHistory?.() || []).length };
        }),
      },
      {
        name: 'canvas_connect_nodes',
        description: '在当前画布连接两个真实节点。素材到千问图生图默认使用 references（最多10张），其他单图编辑使用 guide，到全能参考默认使用 references，提示词节点默认使用 prompt；无效类型会被现有画布规则拒绝。',
        inputSchema: schema({
          sourceId: nodeIdProperty,
          targetId: nodeIdProperty,
          sourceHandle: { type: 'string', description: '可选源端口，如保存的 GLB 使用 model。' },
          targetHandle: { type: 'string', description: '目标端口。自定义工作流必须指定定义中的输入 id；内置节点通常留空自动判断。' },
        }, ['sourceId', 'targetId']),
        execute: respond(async ({ sourceId, targetId, sourceHandle, targetHandle }) => {
          const source = getNode(sourceId);
          const target = getNode(targetId);
          const handle = target.data.mode === 'qwenEdit' && source.type !== 'prompt' && source.data.mediaRole !== 'mask' && ['guide', 'identity', undefined].includes(targetHandle) ? 'references' : targetHandle || (isVideoEdit(target) ? nextVideoEditPort(target, source, latest.current.edgesRef.current) : defaultTargetHandle(target, source, latest.current.edgesRef.current));
          const connected = latest.current.actions.onConnect({ source: sourceId, target: targetId, sourceHandle: sourceHandle || ((source.type === 'native3d' || (source.type === 'media' && source.data.kind === 'model')) ? (isNativePlanSource(source) ? 'plan' : 'model') : source.type === 'prompt' ? 'prompt' : source.data.mediaRole === 'mask' ? 'mask' : 'ref'), targetHandle: handle });
          if (connected?.error) throw new Error(connected.error);
          const edge = await waitFor(() => {
            return latest.current.edgesRef.current.find((item) => connected?.edgeId ? item.id === connected.edgeId : item.source === sourceId && item.target === targetId && item.targetHandle === handle) || null;
          }, 2500);
          return { edge: edgeSummary(edge) };
        }),
      },
      {
        name: 'canvas_generate_node',
        description: '由当前可写画布保存生成准备记录后提交，返回真实任务身份。页桥使用 wait:false。可用 expectedRevision 检查此前读取的保存修订。',
        inputSchema: schema({
          nodeId: nodeIdProperty,
          expectedRevision: { type: 'integer', minimum: 1 },
          wait: { type: 'boolean', description: '是否等待生成结束，默认 false。' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 1500000, description: 'wait 为 true 时的等待上限，默认 300000 毫秒。' },
        }, ['nodeId']),
        execute: respond(async (args, options) => generateNodeForMcp(latest, args, waitFor, options.generation)),
      },
      {
        name: 'canvas_retry_generation',
        description: '在当前可写画布按原工作流重新执行已结束的作业，返回同 jobId 的新 attempt。查询原任务不使用本工具。',
        inputSchema: schema({ nodeId: nodeIdProperty, jobId: { type: 'string' },
          expectedAttempt: { type: 'integer', minimum: 1 }, expectedRevision: { type: 'integer', minimum: 1 },
        }, ['nodeId', 'jobId', 'expectedAttempt']),
        execute: respond(async ({ nodeId, ...args }, options) => latest.current.actions.retryGeneration(nodeId, {
          ...args, ...options.generation, origin: 'agent',
        })),
      },
      {
        name: 'canvas_wait_for_node',
        description: '只读等待当前画布上已经提交的任务进入完成、失败或取消状态，并返回自动生成结果节点。不会重复提交任务。',
        inputSchema: schema({
          nodeId: nodeIdProperty,
          jobId: { type: 'string', description: '传入原任务标识，防止读到新任务。' },
          attempt: { type: 'integer', minimum: 1, description: '可选，只查询指定队列轮次。' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 1500000, description: '等待上限，默认 300000 毫秒。当前页通道最长 20000 毫秒；到时返回 pending:true，不重新提交。' },
        }, ['nodeId']),
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: respond(async ({ nodeId, jobId, attempt, timeoutMs = 300000 }) => waitForNodeForMcp(latest, { nodeId, jobId, attempt, timeoutMs })),
      },
      {
        name: 'canvas_cancel_node',
        description: '取消当前画布节点上正在进行的生成，走与界面取消按钮相同的逻辑。不删除节点，不提交新任务。',
        inputSchema: schema({ nodeId: nodeIdProperty }, ['nodeId']),
        execute: respond(async ({ nodeId }) => {
          getNode(nodeId);
          if (!latest.current.actions.cancelNode) throw new Error('当前页面不能取消生成。');
          await latest.current.actions.cancelNode(nodeId);
          const node = getNode(nodeId);
          return { node: nodeSummary(node), cancelled: node.data.status === 'cancelled' };
        }),
      },
      {
        name: 'canvas_delete_node',
        description: '从当前画布删除指定节点及其连线；运行中的任务会按现有界面逻辑取消。用于清理 Agent 创建的临时测试节点。',
        inputSchema: schema({ nodeId: nodeIdProperty }, ['nodeId']),
        execute: respond(async ({ nodeId }) => {
          getNode(nodeId);
          latest.current.actions.removeNode(nodeId);
          await waitFor(() => !latest.current.nodesRef.current.some((node) => node.id === nodeId) || null);
          return { deletedNodeId: nodeId };
        }),
      },
      {
        name: 'canvas_focus_node',
        description: '将当前画布视口居中到指定真实节点，不移动节点、不修改内容，也不会重新生成。',
        inputSchema: schema({ nodeId: nodeIdProperty }, ['nodeId']),
        execute: respond(async ({ nodeId }) => {
          const node = getNode(nodeId);
          const projectId = latest.current.projectId;
          const focused = await latest.current.actions.focusNode(nodeId);
          if (controller.signal.aborted || latest.current.projectId !== projectId || focused !== true) {
            throw agentReceiptError('VIEW_NOT_APPLIED', '当前页面未确认视口聚焦。');
          }
          return { focusedNodeId: nodeId, title: node.data.title, view: getAgentState().view, execution: 'not_requested' };
        }),
      },
      {
        name: 'canvas_tidy',
        description: '默认自动重排全部节点。仅显式 mode=native3d_compact 时整理本地3D重复结果到处理卡片；默认 dryRun=true，只预览，不移动其他节点，不删除文件。使用此模式前应读取 capabilities.uiFeatures.inlineResultsVersion。',
        inputSchema: schema({mode:{type:'string',enum:['native3d_compact']},dryRun:{type:'boolean',default:true},cleanupFailedIds:{type:'array',items:nodeIdProperty,maxItems:100}}),
        execute: respond(async ({mode,dryRun=true,cleanupFailedIds=[]}) => {
          if(mode==='native3d_compact')return latest.current.actions.native3dCompact({dryRun,cleanupFailed:cleanupFailedIds.length>0,cleanupIds:cleanupFailedIds});
          if(mode!==undefined||cleanupFailedIds.length||dryRun===false)throw Error('3D整理必须显式指定 mode=native3d_compact。');
          latest.current.actions.tidyCanvas();
          return { message: '已整理当前画布。' };
        }),
      },
    ];
    tools.push({name:'canvas_publish_extension',description:'显式发布已安装的精确工作流包或新版本到当前登录用户的节点库。同一requestId固定同一包，查询/重放不重复上传；提交不代表发布成功，使用状态工具查询。不会更新画布已固定版本。',inputSchema:schema({requestId:nodeIdProperty,digest:{type:'string',pattern:'^[a-f0-9]{64}$'},packageId:{type:'string'},version:{type:'string'},mode:{type:'string',enum:['update','publish'],default:'update'}},['requestId','digest','packageId','version']),execute:respond(args=>latest.current.actions.publishExtension(args))});
    tools.push({name:'canvas_get_extension_publish_status',description:'只读查询发布请求状态；不重试上传，不返回节点包或媒体。',inputSchema:schema({requestId:nodeIdProperty},['requestId']),execute:respond(({requestId})=>latest.current.actions.getExtensionPublishStatus(requestId))});
    tools.push({
      name: 'canvas_image_compact',
      description: '整理指定已完成图片生成节点的重复结果卡，保留媒体身份、文件、历史及下游引用；多输出保留独立卡。默认 dryRun:true 仅预览，执行需显式 false。当前画布忙碌、只读或保存异常时拒绝。',
      inputSchema: schema({ nodeIds: { type: 'array', items: nodeIdProperty, minItems: 1, maxItems: 100 }, dryRun: { type: 'boolean', default: true } }, ['nodeIds']),
      execute: respond(args => latest.current.actions.imageCompact(imageCompactArgs(args))),
    });
    tools.push({
      name: 'canvas_retry_save',
      description: '显式重试当前页面保存，保留未保存修改及版本冲突保护；不会重新生成或刷新页面。',
      inputSchema: schema(),
      execute: async () => {
        try { return JSON.stringify({ ok: true, ...await latest.current.actions.retryProjectSave() }); }
        catch (error) { return JSON.stringify({ ok: false, error: error.message, code: error.code, status: error.status, localChangesRetained: true }); }
      },
    });
    tools.push({name:'canvas_native3d_compact',description:'显式整理本地3D重复结果；默认只预览，清理仅限指定且无依赖的失败节点，不删除素材文件。',inputSchema:schema({dryRun:{type:'boolean',default:true},cleanupFailed:{type:'boolean',default:false},cleanupIds:{type:'array',items:nodeIdProperty,maxItems:100}}),execute:respond(async({dryRun=true,cleanupFailed=false,cleanupIds=[]})=>latest.current.actions.native3dCompact({dryRun,cleanupFailed,cleanupIds}))});
    tools.push({name:'canvas_native3d_sync_task',description:'核对当前节点已提交任务并重试保存或交付，不重新计算。',inputSchema:schema({nodeId:nodeIdProperty},['nodeId']),execute:respond(async({nodeId})=>latest.current.actions.native3dSyncTask(nodeId))});
    tools.push({name:'canvas_native3d_retry_lod',description:'从确切已验收父LOD单档重试，保留原失败档比例并换新种子；局部修复追溯原失败任务。',inputSchema:schema({nodeId:nodeIdProperty},['nodeId']),execute:respond(async({nodeId}, options)=>latest.current.actions.native3dRetryLOD(nodeId,{...options.generation,origin:'agent'}))});
    tools.push({name:'canvas_native3d_repair_lod',description:'保存并提交当前未通过LOD候选的局部修复；保留原结果，重复调用查看同一修复。',inputSchema:schema({nodeId:nodeIdProperty,settings:{type:'object',properties:{localRepairMaxPatches:{type:'integer',minimum:1,maximum:4},localRepairDisplacementFraction:{type:'number',minimum:.0001,maximum:.01},localRepairCorrectionFraction:{type:'number',minimum:.1,maximum:1}},additionalProperties:false}},['nodeId']),execute:respond(async ({nodeId,settings}, options)=>latest.current.actions.native3dRepairLOD(nodeId,settings,{...options.generation,origin:'agent'}))});
    tools.push({name:'canvas_native3d_create_resolution',description:'为外轮廓未通过的LOD创建保留更多面的同档草稿，不启动生成；沿用确切父模型和质量门。',inputSchema:schema({nodeId:nodeIdProperty,keepPercent:{type:'number',exclusiveMinimum:0,maximum:100}},['nodeId','keepPercent']),execute:respond(async ({nodeId,keepPercent})=>latest.current.actions.native3dCreateResolution(nodeId,keepPercent))});
    tools.push({
      name:'canvas_native3d_next_step',
      description:'在当前结果旁创建并连接下一步可编辑节点，不运行生成；重复点击复用未修改草稿。',
      inputSchema:schema({nodeId:nodeIdProperty,action:{type:'string',enum:['next_lod','uv_plan','uv_plan_reviewed','unwrap','bake']}},['nodeId','action']),
      execute:respond(async ({nodeId,action})=>latest.current.actions.native3dNextStep(nodeId,action)),
    });
    tools.push({
      name: 'canvas_retry_save',
      description: '显式重试当前页面保存，保留未保存修改及版本冲突保护；不会重新生成或刷新页面。',
      inputSchema: schema(),
      execute: async () => {
        try { return JSON.stringify({ ok: true, ...await latest.current.actions.retryProjectSave() }); }
        catch (error) { return JSON.stringify({ ok: false, error: error.message, code: error.code, status: error.status, localChangesRetained: true }); }
      },
    });
    tools.push(...createProjectPageTools({
      prepare: (id, name) => latest.current.actions.prepareProjectSwitch(id, name),
      commit: (target) => latest.current.actions.commitProjectSwitch(target),
      abandon: (target) => latest.current.actions.abandonProjectSwitch(target),
    }));
    tools.push({
      name: 'canvas_import_asset',
      description: '在当前页面素材节点复用已保存素材，可用 sourceProjectId 指定来源项目；通过原生上传与版本保存复制到当前项目。',
      inputSchema: schema({ nodeId: nodeIdProperty, assetPath: { type: 'string' }, name: { type: 'string' }, sourceProjectId: { type: 'string' } }, ['nodeId', 'assetPath']),
      execute: respond(async ({ nodeId, assetPath, name, sourceProjectId }) => {
        const node = getNode(nodeId);
        if (!['media','native3d'].includes(node.type) || !/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(assetPath)) throw new Error('需要当前项目的有效素材路径和素材节点。');
        if (sourceProjectId && !/^prj_[a-zA-Z0-9_-]+$/.test(sourceProjectId)) throw new Error('来源项目 ID 无效。');
        await latest.current.actions.importAsset(nodeId, assetPath, name, sourceProjectId);
        return { node: nodeSummary(getNode(nodeId)) };
      }),
    });
    tools.push({
      name: 'canvas_download_video',
      description: '在当前页把 http/https 分享链接下载为视频素材。复用视频链接下载节点和页面已有的下载流程：写入链接、下载、在旁边创建视频节点并保存。wait 默认 false，立即返回下载节点与 queued 任务；wait 为 true 时返回新视频节点。进度与错误用 canvas_get_state 读取该下载节点的 downloadStatus（queued/downloading/done/failed）和 message。',
      inputSchema: schema({
        nodeId: { ...nodeIdProperty, description: '可选。已有「视频链接下载」节点的 ID。省略则新建。' },
        x: { type: 'number', description: '新建下载节点时的画布坐标 X，需与 y 同时提供。' },
        y: { type: 'number', description: '新建下载节点时的画布坐标 Y，需与 x 同时提供。' },
        url: { type: 'string', description: 'http 或 https 视频链接，或包含一个该链接的分享文字。不能包含账号或密码。' },
        wait: { type: 'boolean', description: '是否等待下载结束，默认 false。' },
      }, ['url']),
      execute: respond((args) => downloadVideoForMcp(latest, args)),
    });
    for (const tool of tools) {
      const original = tool.execute;
      tool.execute = async (args = {}, executionOptions) => {
        const compactPreview = tool.name === 'canvas_image_compact' && args?.dryRun !== false;
        const nativePreview = ['canvas_native3d_compact', 'canvas_tidy'].includes(tool.name) && (tool.name !== 'canvas_tidy' || args?.mode === 'native3d_compact') && args?.dryRun !== false;
        const mutation = !nativePreview && !compactPreview && !['canvas_get_extension_publish_status', 'canvas_get_state', 'canvas_native3d_viewer_close', 'canvas_native3d_capabilities', 'canvas_get_video_analysis', 'canvas_wait_for_node', 'canvas_focus_node', 'canvas_inspect_node', 'canvas_open_reference_library'].includes(tool.name);
        const conditionalEdit = tool.name === 'canvas_update_node' && args.expectedRevision !== undefined;
        if (mutation && latest.current.readOnly) return JSON.stringify({ ok: false, error: '当前画布为只读。',
          ...(conditionalEdit ? { code: 'READ_ONLY' } : {}) });
        const result = JSON.parse(await original(args, executionOptions));
        const admittedGeneration = ['canvas_generate_node', 'canvas_retry_generation'].includes(tool.name)
          && result.jobId && result.execution === 'accepted';
        if (mutation && result.ok && !admittedGeneration && !conditionalEdit && !['canvas_download_video', 'canvas_publish_extension', 'canvas_create_project', 'canvas_open_project', 'canvas_retry_save'].includes(tool.name)) {
          try { await latest.current.actions.persistProject?.(); }
          catch (error) { return JSON.stringify({ ...result, ok: false, error: error.message, localChangesRetained: true }); }
        }
        return JSON.stringify(result);
      };
      if (context?.registerTool) Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch((error) => {
        console.warn(`[WebMCP] ${tool.name} 注册失败`, error);
      });
    }
    // A backgrounded tab is still the user's current canvas. Visibility is
    // handled by the single-page bridge lease, not by document.visibilityState:
    // the user may switch to another app while this same canvas keeps running.
    const stop = startPage({ tools, getPage: () => ({ projectId: latest.current.projectId,
      readOnly: latest.current.readOnly, visible: !latest.current.readOnly }) });
    globalThis.addEventListener?.('pagehide', cancelOwnedAnalyses);
    return () => {
      stop();
      controller.abort();
      cancelOwnedAnalyses();
      globalThis.removeEventListener?.('pagehide', cancelOwnedAnalyses);
    };
}
