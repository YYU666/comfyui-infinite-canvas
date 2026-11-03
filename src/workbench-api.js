import { orderQwenReferences, compileQwenPrompt, validateQwenReferences } from './qwen-references.js';
import { buildFlux3KleinWorkflow, scaleFlux3Dimensions } from './flux3-klein.js';
import { LOCAL_RECONNECTED } from './local-connection.js';
export const COMFY_ORIGIN = '/api/comfy';

export function normalizeMediaUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.port === '8188' && url.pathname === '/view') {
      return `${COMFY_ORIGIN}${url.pathname}${url.search}${url.hash}`;
    }
  } catch { /* Relative, blob and data URLs need no migration. */ }
  return value;
}
export const MODEL_INFO = {
  unet: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  referenceUnet: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  clip: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
  videoVae: 'minimax_h3_video_vae_int8_convrot.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
  turboLora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  referenceTurboLora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
};

export const RATIOS = {
  '16:9': [832, 480],
  '9:16': [480, 832],
  '1:1': [640, 640],
  '4:3': [736, 544],
  '3:4': [544, 736],
  '21:9': [960, 416],
};
export const RESOLUTION_SCALES = { '480P': 1, '720P': 1.5, '1080P': 2.25 };

export const IMAGE_MODEL = {
  unet: 'Krea2-MuseByStable_v30Turbo_fp8.safetensors',
  clip: 'qwen3vl_4b_fp8_scaled.safetensors',
  vae: 'qwen_image_vae.safetensors',
  hdUnet: 'seedvr2_3b_int8_convrot.safetensors',
  hdVae: 'seedvr2_ema_vae_fp16.safetensors',
};
export const IMAGE_RATIOS = {
  '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024],
  '4:3': [1152, 864], '3:4': [864, 1152], '21:9': [1536, 640],
};
export const IMAGE_LORAS = {
  none: null,
  realism: 'Krea2-N\\Krea2-realism_engine_v2.safetensors',
  asian: 'Krea2-功能\\Krea2-亚洲asianMix_v1-bf16.safetensors',
  fantasy: 'Krea2-风格\\Krea2-奇幻现实FantasyRealism.safetensors',
  watercolor: 'Krea2-风格\\krea2_装饰艺术柔和水彩softwatercolor.safetensors',
  retroAnime: 'Krea2-风格\\krea2_紫调复古旧动漫retroanime.safetensors',
};

export function resolveImageDimensions(ratio = '16:9', flux3Resolution) {
  const dimensions = IMAGE_RATIOS[ratio] || IMAGE_RATIOS['16:9'];
  return flux3Resolution ? scaleFlux3Dimensions(dimensions, flux3Resolution) : dimensions;
}

export function resolveDimensions(ratio = '16:9', resolution = '480P') {
  const [baseWidth, baseHeight] = RATIOS[ratio] || RATIOS['16:9'];
  const scale = RESOLUTION_SCALES[resolution] || RESOLUTION_SCALES['480P'];
  const snap = (value) => Math.max(32, Math.round(value * scale / 32) * 32);
  return [snap(baseWidth), snap(baseHeight)];
}

export function durationToFrames(seconds) {
  return Math.max(5, Math.min(362, 5 + 17 * Math.round((Number(seconds) * 24 - 5) / 17)));
}

export function createClientId() {
  return globalThis.crypto?.randomUUID?.() || `h3-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildWorkflow(options) {
  const [width, height] = resolveDimensions(options.ratio, options.resolution);
  const turbo = options.turbo !== false;
  const modelOutput = turbo ? ['2', 0] : ['1', 0];
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: MODEL_INFO.unet, weight_dtype: 'default' } },
    '3': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: modelOutput, shift_video: 12, shift_audio: 3 } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: MODEL_INFO.clip, type: 'minimax', device: 'default' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: MODEL_INFO.videoVae } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: MODEL_INFO.audioVae } },
    '7': { class_type: 'MiniMaxH3ImageToVideo', inputs: {
      clip: ['4', 0], vae: ['5', 0], prompt: options.prompt.trim(), width, height,
      length: durationToFrames(options.duration || 5),
    } },
    '8': { class_type: 'BasicGuider', inputs: { model: ['3', 0], conditioning: ['7', 0] } },
    '9': { class_type: 'RandomNoise', inputs: { noise_seed: Number(options.seed) } },
    '10': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '11': { class_type: 'BasicScheduler', inputs: { model: ['3', 0], scheduler: 'beta', steps: turbo ? 8 : 20, denoise: 1 } },
    '12': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['9', 0], guider: ['8', 0], sampler: ['10', 0], sigmas: ['11', 0], latent_image: ['7', 1] } },
    '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['5', 0] } },
    '14': { class_type: 'VAEDecodeAudio', inputs: { samples: ['12', 0], vae: ['6', 0] } },
    '15': { class_type: 'CreateVideo', inputs: { images: ['13', 0], fps: 24, audio: ['14', 0], codec: 'h264' } },
    '16': { class_type: 'SaveVideo', inputs: { video: ['15', 0], filename_prefix: 'video/H3_Workbench', format: 'mp4', codec: 'auto' } },
  };
  if (turbo) graph['2'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: MODEL_INFO.turboLora, strength_model: 1 } };
  if (options.firstFrame) graph['7'].inputs.first_frame = ['17', 0];
  if (options.lastFrame) graph['7'].inputs.last_frame = ['18', 0];
  if (options.firstFrame) graph['17'] = { class_type: 'LoadImage', inputs: { image: options.firstFrame } };
  if (options.lastFrame) graph['18'] = { class_type: 'LoadImage', inputs: { image: options.lastFrame } };
  return graph;
}

export function compileReferencePrompt(prompt, references = []) {
  const counters = { image: 0, video: 0, audio: 0 };
  let compiled = prompt.trim();
  for (const reference of references) {
    const kind = reference.kind || 'image';
    counters[kind] += 1;
    const label = kind === 'image' ? 'Picture' : kind === 'video' ? 'Video' : 'Audio';
    reference.tag = `<${label} ${counters[kind]}>`;
    if (reference.title) compiled = compiled.split(`@${reference.title}`).join(reference.tag);
  }
  return compiled;
}

export function buildReferenceWorkflow(options) {
  const [width, height] = resolveDimensions(options.ratio, options.resolution);
  const turbo = options.turbo !== false;
  const references = options.references || [];
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: MODEL_INFO.referenceUnet, weight_dtype: 'default' } },
    '3': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: turbo ? ['2', 0] : ['1', 0], shift_video: 12, shift_audio: 3 } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: MODEL_INFO.clip, type: 'minimax', device: 'default' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: MODEL_INFO.videoVae } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: MODEL_INFO.audioVae } },
    '7': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
      clip: ['4', 0], vae: ['5', 0], audio_vae: ['6', 0],
      prompt: compileReferencePrompt(options.prompt, references), width, height,
      length: durationToFrames(options.duration || 5), ref_image_size: options.refImageSize || 'max',
    } },
    '8': { class_type: 'BasicGuider', inputs: { model: ['3', 0], conditioning: ['7', 0] } },
    '9': { class_type: 'RandomNoise', inputs: { noise_seed: Number(options.seed) } },
    '10': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '11': { class_type: 'BasicScheduler', inputs: { model: ['3', 0], scheduler: 'beta', steps: turbo ? 4 : 20, denoise: 1 } },
    '12': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['9', 0], guider: ['8', 0], sampler: ['10', 0], sigmas: ['11', 0], latent_image: ['7', 1] } },
    '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['5', 0] } },
    '14': { class_type: 'VAEDecodeAudio', inputs: { samples: ['12', 0], vae: ['6', 0] } },
    '15': { class_type: 'CreateVideo', inputs: { images: ['13', 0], fps: 24, audio: ['14', 0], codec: 'h264' } },
    '16': { class_type: 'SaveVideo', inputs: { video: ['15', 0], filename_prefix: 'video/H3_Workbench', format: 'mp4', codec: 'auto' } },
  };
  if (turbo) graph['2'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: MODEL_INFO.referenceTurboLora, strength_model: 1 } };
  const counters = { image: 0, video: 0, audio: 0 };
  const autoGrow = { images: {}, videos: {}, videoAudios: {}, audios: {} };
  references.forEach((reference, index) => {
    const kind = reference.kind || 'image';
    const nodeId = String(100 + index);
    const kindIndex = counters[kind]++;
    if (kind === 'image') {
      graph[nodeId] = { class_type: 'LoadImage', inputs: { image: reference.name } };
      autoGrow.images[`ref_image_${kindIndex}`] = [nodeId, 0];
    } else if (kind === 'video') {
      graph[nodeId] = { class_type: 'LoadVideo', inputs: { file: reference.name } };
      const componentsId = String(200 + index);
      graph[componentsId] = { class_type: 'GetVideoComponents', inputs: { video: [nodeId, 0] } };
      autoGrow.videos[`ref_video_${kindIndex}`] = [componentsId, 0];
      autoGrow.videoAudios[`ref_video_audio_${kindIndex}`] = [componentsId, 1];
    } else {
      graph[nodeId] = { class_type: 'LoadAudio', inputs: { audio: reference.name } };
      autoGrow.audios[`ref_audio_${kindIndex}`] = [nodeId, 0];
    }
  });
  if (Object.keys(autoGrow.images).length) graph['7'].inputs.ref_images = autoGrow.images;
  if (Object.keys(autoGrow.videos).length) graph['7'].inputs.ref_videos = autoGrow.videos;
  if (Object.keys(autoGrow.videoAudios).length) graph['7'].inputs.ref_video_audios = autoGrow.videoAudios;
  if (Object.keys(autoGrow.audios).length) graph['7'].inputs.ref_audios = autoGrow.audios;
  return graph;
}

export const MOSS_IMAGE_MODEL = {
  unet: 'Moss_image\\moss_image_sft_int8_convrot.safetensors',
  clip: 'qwen3.5_9b_int8_convrot.safetensors',
  vae: 'flux2-vae_small.safetensors',
};

export function buildImageWorkflow(options) {
  const [width, height] = resolveImageDimensions(options.ratio);
  if (options.imageModel === 'flux3_klein') return buildFlux3KleinWorkflow(options, [width, height]);
  if (options.imageModel === 'moss') {
    return {
      model: { class_type: 'UNETLoader', inputs: { unet_name: MOSS_IMAGE_MODEL.unet, weight_dtype: 'default' } },
      accelerate: { class_type: 'SpectrumMOSSImageAdaptive', inputs: {
        model: ['model', 0], warmup_steps: 7, detail_guard_steps: 1, tail_actual_steps: 1,
        post_guard_horizon_cap: 2, window_size: 2, flex_window: 0.5,
        cache_device: 'main_device', error_tolerance: 1, debug: false, warn_unverified_sampler: false,
      } },
      text: { class_type: 'CLIPLoader', inputs: { clip_name: MOSS_IMAGE_MODEL.clip, type: 'moss_image', device: 'default' } },
      vae: { class_type: 'VAELoader', inputs: { vae_name: MOSS_IMAGE_MODEL.vae } },
      positive: { class_type: 'CLIPTextEncode', inputs: { clip: ['text', 0], text: options.prompt.trim() } },
      negative: { class_type: 'CLIPTextEncode', inputs: { clip: ['text', 0], text: 'worst quality, bad anatomy, watermark, jpeg artifact' } },
      latent: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
      sample: { class_type: 'KSampler', inputs: {
        model: ['accelerate', 0], seed: Number(options.seed), steps: 25, cfg: 2.5,
        sampler_name: 'er_sde', scheduler: 'simple', positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0], denoise: 1,
      } },
      decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
      save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'image/H3_MOSS_Image' } },
    };
  }
  const loraName = IMAGE_LORAS[options.imageLora || 'none'];
  const graph = {
    model: { class_type: 'UNETLoader', inputs: { unet_name: IMAGE_MODEL.unet, weight_dtype: 'default' } },
    text: { class_type: 'CLIPLoader', inputs: { clip_name: IMAGE_MODEL.clip, type: 'krea2', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: IMAGE_MODEL.vae } },
    positive: { class_type: 'CLIPTextEncode', inputs: { clip: ['text', 0], text: options.prompt.trim() } },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive', 0] } },
    latent: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    sample: { class_type: 'KSampler', inputs: {
      model: [loraName ? 'lora' : 'model', 0], seed: Number(options.seed), steps: 8, cfg: 1,
      sampler_name: 'euler', scheduler: 'simple', positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0], denoise: 1,
    } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'image/H3_Image' } },
  };
  if (loraName) graph.lora = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: loraName, strength_model: Number(options.loraStrength ?? 0.8) } };
  return graph;
}

export const IDENTITY_EDIT_MODEL = {
  unet: 'krea2_turbo_fp8_scaled.safetensors',
  lora: 'krea2_identity_edit_v2.safetensors',
  quadViewLora: 'Krea2-四视图QuadView_krea2_v1.safetensors',
};

export function buildIdentityEditWorkflow(options) {
  const source = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  if (!source) throw new Error('母图编辑需要连接一张人物或场景母图。');
  const [width, height] = resolveImageDimensions(options.ratio || '16:9');
  const useQuadView = options.quadView === true;
  return {
    model: { class_type: 'UNETLoader', inputs: { unet_name: IDENTITY_EDIT_MODEL.unet, weight_dtype: 'default' } },
    identity: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: IDENTITY_EDIT_MODEL.lora, strength_model: 1 } },
    text: { class_type: 'CLIPLoader', inputs: { clip_name: IMAGE_MODEL.clip, type: 'krea2', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: IMAGE_MODEL.vae } },
    source: { class_type: 'LoadImage', inputs: { image: source.name } },
    encode: { class_type: 'VAEEncode', inputs: { pixels: ['source', 0], vae: ['vae', 0] } },
    latent: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
    positive: { class_type: 'Krea2EditGroundedEncode', inputs: { clip: ['text', 0], prompt: options.prompt.trim(), image: ['source', 0], grounding_px: Number(options.groundingPx || 1024) } },
    negative: { class_type: 'Krea2EditGroundedEncode', inputs: { clip: ['text', 0], prompt: '', image: ['source', 0], grounding_px: Number(options.groundingPx || 1024) } },
    patch: { class_type: 'Krea2EditModelPatch', inputs: {
      model: [useQuadView ? 'quadview' : 'identity', 0], source_latent: ['encode', 0], vae: ['vae', 0], source_image: ['source', 0], target_latent: ['latent', 0],
      ref_boost: Number(options.refBoost ?? 4), ref_boost_a: 1, fit_mode: 'fit', ref_position: options.refPosition || 'beside (right of target)', ref_position_a: 'aligned (trained)',
    } },
    sample: { class_type: 'KSampler', inputs: {
      model: ['patch', 0], seed: Number(options.seed), steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
      positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0], denoise: 1,
    } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'image/H3_IdentityV2' } },
    ...(useQuadView ? { quadview: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['identity', 0], lora_name: IDENTITY_EDIT_MODEL.quadViewLora, strength_model: Number(options.quadViewStrength ?? 0.7) } } } : {}),
  };
}

export const QWEN21_EDIT_MODEL = {
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_int8_convrot.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
  realismLora: 'Qwen2.1_Anything2RealCharacters.safetensors',
};

export const VERSIONED_IMAGE_MODELS = {
  qwenTurbo: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
  seedvr7b: 'seedvr2_7b_int8_convrot.safetensors',
  museV4: 'museByStableYogi_v40INT8Extended.safetensors',
};
export const QWEN21_TURBO_SIGMAS = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0';

function qwenModelName(options) {
  const variant = options.qwenModel || 'standard';
  if (!['standard', 'turbo'].includes(variant)) throw new Error('未知的 Qwen 2.1 模型版本。');
  return variant === 'turbo' ? VERSIONED_IMAGE_MODELS.qwenTurbo : QWEN21_EDIT_MODEL.unet;
}

function addQwenTurboSampling(graph, model, seed) {
  graph.cache = { class_type: 'QwenImage21Cache', inputs: { model, device: 'auto', dtype: 'default' } };
  graph.noise = { class_type: 'RandomNoise', inputs: { noise_seed: seed } };
  graph.sampler = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
  graph.sigmas = { class_type: 'ManualSigmas', inputs: { sigmas: QWEN21_TURBO_SIGMAS } };
  graph.guider = { class_type: 'CFGGuider', inputs: { model: ['cache', 0], positive: ['encode', 0], negative: ['encode', 1], cfg: 1 } };
  graph.sample = { class_type: 'SamplerCustomAdvanced', inputs: {
    noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['encode', 2],
  } };
}

export function validateQwenCacheDevice(device) {
  if (!['auto', 'cpu'].includes(device)) throw new Error('qwenCacheDevice 仅支持 auto 或 cpu；参考缓存保持 default 精度。');
  return device;
}

function addQwenCpuReferenceCache(graph, model) {
  // Optional diagnostic: move the reference cache without quantizing it.
  // Reuse the Turbo cache node instead of stacking a second cache patch.
  graph.cache = { class_type: 'QwenImage21Cache', inputs: { model, device: 'cpu', dtype: 'default' } };
  return ['cache', 0];
}

export function validateQwenSourceCrop(crop) {
  const keys = ['x', 'y', 'width', 'height'];
  if (!crop || typeof crop !== 'object' || Array.isArray(crop)
    || Object.keys(crop).length !== keys.length
    || keys.some((key) => !Object.hasOwn(crop, key) || !Number.isInteger(crop[key]))
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 16384 || crop.y + crop.height > 16384) {
    throw new Error('qwenSourceCrop 必须包含整数 x、y、width、height；坐标非负，宽高大于 0，裁剪范围不超过 16384。');
  }
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

// Qwen Image 2.1 native editing: its encoder supplies the reference-matched latent.
export function buildQwen21EditWorkflow(options) {
  if (options.qwenModel === 'flux3_klein') return buildFlux3KleinWorkflow({ ...options, mode: 'qwenEdit' });
  const cacheDevice = validateQwenCacheDevice(options.qwenCacheDevice === undefined ? 'auto' : options.qwenCacheDevice);
  if (options.qwenMaskCrop !== undefined && typeof options.qwenMaskCrop !== 'boolean') {
    throw new Error('qwenMaskCrop 必须是布尔值。');
  }
  const inputs = options.references || [];
  const masks = inputs.filter((ref) => (ref.data?.slot ?? ref.slot) === 'mask');
  if (masks.length > 1) throw new Error('局部遮罩修改最多连接一张遮罩图片。');
  const customMask = masks[0];
  if (customMask && ((customMask.kind || customMask.data?.kind) !== 'image' || !customMask.name)) {
    throw new Error('局部遮罩修改需要有效的遮罩图片。');
  }
  const references = orderQwenReferences(inputs.filter((ref) => (ref.data?.slot ?? ref.slot) !== 'mask'), options.qwenReferenceOrder);
  validateQwenReferences(references);
  const source = references[0], makeup = references[1];
  const prompt = compileQwenPrompt(options.prompt?.trim() || '', references);
  if (!prompt) throw new Error('请先输入要保留和要修改的画面内容。');
  const instruction = prompt.includes('<image1>') ? prompt : `Edit <image1>: ${prompt}`;
  const useRealism = options.imageLora === 'qwen21Realism';
  const sourceCrop = 'qwenSourceCrop' in options ? validateQwenSourceCrop(options.qwenSourceCrop) : null;
  if (customMask && sourceCrop) throw new Error('局部遮罩修改暂不支持 qwenSourceCrop；请使用完整图1以保持遮罩对齐。');
  const graph = {
    model: { class_type: 'UNETLoader', inputs: { unet_name: qwenModelName(options), weight_dtype: 'default' } },
    ...(useRealism ? { realism: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: QWEN21_EDIT_MODEL.realismLora, strength_model: Number(options.loraStrength ?? 0.6) } } } : {}),
    text: { class_type: 'CLIPLoader', inputs: { clip_name: QWEN21_EDIT_MODEL.clip, type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: QWEN21_EDIT_MODEL.vae } },
    source: { class_type: 'LoadImage', inputs: { image: source.name } },
    ...(sourceCrop ? { reference_crop: { class_type: 'ImageCrop', inputs: { image: ['source', 0], ...sourceCrop } } } : {}),
    ...(makeup ? { makeup: { class_type: 'LoadImage', inputs: { image: makeup.name } } } : {}),
    encode: { class_type: 'TextEncodeQwenImage21', inputs: {
      clip: ['text', 0], prompt: instruction, negative_prompt: '', resolution: Number(options.qwenRefResolution || 1024),
      'images.image_1': [sourceCrop ? 'reference_crop' : 'source', 0], ...(makeup ? { 'images.image_2': ['makeup', 0] } : {}), vae: ['vae', 0],
    } },
    sample: { class_type: 'KSampler', inputs: {
      model: [useRealism ? 'realism' : 'model', 0], seed: Number(options.seed), steps: Number(options.qwenSteps || 40), cfg: 1,
      sampler_name: 'euler', scheduler: 'simple', positive: ['encode', 0], negative: ['encode', 1], latent_image: ['encode', 2], denoise: 1,
    } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'image/H3_Qwen21Edit' } },
  };
  references.slice(2).forEach((reference, offset) => {
    const index = offset + 3;
    graph[`reference_${index}`] = { class_type: 'LoadImage', inputs: { image: reference.name } };
    graph.encode.inputs[`images.image_${index}`] = [`reference_${index}`, 0];
  });
  if (options.qwenModel === 'turbo') addQwenTurboSampling(graph, [useRealism ? 'realism' : 'model', 0], Number(options.seed));
  if (cacheDevice === 'cpu') {
    const cachedModel = addQwenCpuReferenceCache(graph, [useRealism ? 'realism' : 'model', 0]);
    if (options.qwenModel !== 'turbo') graph.sample.inputs.model = cachedModel;
  }
  if (customMask) addQwenEditMask(graph, customMask, options.qwenMaskCrop === true);
  return graph;
}

function addQwenEditMask(graph, customMask, cropToMask = false) {
  graph.mask_image = { class_type: 'LoadImage', inputs: { image: customMask.name } };
  graph.mask_source_size = { class_type: 'GetImageSize', inputs: { image: ['source', 0] } };
  const width = ['mask_source_size', 0], height = ['mask_source_size', 1];
  // Align the mask to the full original first. Nearest-neighbour resizing keeps
  // black pixels black; neither alpha inversion nor skin/feather defaults apply.
  graph.mask_original_image = { class_type: 'ImageScale', inputs: {
    image: ['mask_image', 0], upscale_method: 'nearest-exact', width, height, crop: 'disabled',
  } };
  graph.mask_original = { class_type: 'ImageToMask', inputs: { image: ['mask_original_image', 0], channel: 'red' } };
  if (cropToMask) {
    const targetSize = graph.encode.inputs.resolution;
    graph.mask_crop = { class_type: 'InpaintCropImproved', inputs: {
      image: ['source', 0], mask: ['mask_original', 0], downscale_algorithm: 'bilinear', upscale_algorithm: 'bicubic',
      preresize: false, preresize_mode: 'ensure minimum resolution', preresize_min_width: 1024, preresize_min_height: 1024,
      preresize_max_width: 16384, preresize_max_height: 16384,
      mask_fill_holes: false, mask_expand_pixels: 0, mask_invert: false, mask_blend_pixels: 0, mask_hipass_filter: 0,
      extend_for_outpainting: false, extend_up_factor: 1, extend_down_factor: 1, extend_left_factor: 1, extend_right_factor: 1,
      context_from_mask_extend_factor: 1.3, output_resize_to_target_size: true,
      output_target_width: targetSize, output_target_height: targetSize, output_padding: '32', device_mode: 'cpu (compatible)',
    } };
    // Only image1 becomes the enlarged local context; other reference images
    // retain their numbering and complete contents.
    graph.encode.inputs['images.image_1'] = ['mask_crop', 1];
    graph.mask_crop_image = { class_type: 'MaskToImage', inputs: { mask: ['mask_crop', 2] } };
  }
  // The native Qwen 2.1 encoder returns an EMPTY latent, compressed by 16.
  // Use its actual dimensions so image1's aspect/rounding and sampling agree.
  graph.mask_latent_size = { class_type: 'GetLatentSize', inputs: { latent: ['encode', 2] } };
  for (const [axis, index] of [['width', 0], ['height', 1]]) {
    graph[`mask_sample_${axis}`] = { class_type: 'SimpleMath+', inputs: { a: ['mask_latent_size', index], value: 'a * 16' } };
  }
  const sampleWidth = ['mask_sample_width', 0], sampleHeight = ['mask_sample_height', 0];
  graph.mask_sample_source = { class_type: 'ImageScale', inputs: {
    image: cropToMask ? ['mask_crop', 1] : ['source', 0], upscale_method: 'lanczos', width: sampleWidth, height: sampleHeight, crop: 'disabled',
  } };
  graph.mask_sample_image = { class_type: 'ImageScale', inputs: {
    image: [cropToMask ? 'mask_crop_image' : 'mask_original_image', 0], upscale_method: 'nearest-exact', width: sampleWidth, height: sampleHeight, crop: 'disabled',
  } };
  graph.mask_sample = { class_type: 'ImageToMask', inputs: { image: ['mask_sample_image', 0], channel: 'red' } };
  graph.mask_source_latent = { class_type: 'VAEEncode', inputs: { pixels: ['mask_sample_source', 0], vae: ['vae', 0] } };
  graph.mask_latent = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['mask_source_latent', 0], mask: ['mask_sample', 0] } };
  // Run after Turbo replaces the sampler, so both variants receive noise_mask.
  graph.sample.inputs.latent_image = ['mask_latent', 0];
  if (cropToMask) {
    // The encoder may round crop dimensions to a multiple of 32. Restore the
    // exact crop dimensions before the stitcher maps pixels into the original.
    graph.mask_crop_size = { class_type: 'GetImageSize', inputs: { image: ['mask_crop', 1] } };
    graph.mask_crop_decode_resize = { class_type: 'ImageScale', inputs: {
      image: ['decode', 0], upscale_method: 'lanczos', width: ['mask_crop_size', 0], height: ['mask_crop_size', 1], crop: 'disabled',
    } };
    graph.mask_stitch = { class_type: 'InpaintStitchImproved', inputs: {
      stitcher: ['mask_crop', 0], inpainted_image: ['mask_crop_decode_resize', 0],
    } };
  }
  graph.mask_output_resize = { class_type: 'ImageScale', inputs: {
    image: [cropToMask ? 'mask_stitch' : 'decode', 0], upscale_method: 'lanczos', width, height, crop: 'disabled',
  } };
  graph.mask_output = { class_type: 'ImageCompositeMasked', inputs: {
    destination: ['source', 0], source: ['mask_output_resize', 0], x: 0, y: 0, resize_source: false, mask: ['mask_original', 0],
  } };
  graph.save.inputs.images = ['mask_output', 0];
}

export const CHARACTER_SHEET_PANEL = Object.freeze({ width: 1152, height: 2048 });
// Empirical baseline from the controlled male 45-degree test, not a universal fix.
const CHARACTER_SHEET_ANGLE_SEED = 2096285145;

export function validateCharacterSheetAngleSeed(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('characterSheetAngleSeed 必须是非负安全整数。');
  return seed;
}

export const CHARACTER_SHEET_VIEWS = Object.freeze([
  { id: 'front_portrait', label: '正面头像', seedOffset: 0 },
  { id: 'three_quarter_portrait', label: '45 度侧面头像', seedOffset: 0 },
  { id: 'back_body', label: '无头背面全身', seedOffset: 0 },
  { id: 'front_body', label: '无头正面全身', seedOffset: 0 },
]);

export const CHARACTER_SHEET_BODY_CROP = Object.freeze({ x: 108, y: 384, width: 936, height: 1664 });

// Fixed templates: establish the front portrait from the reference, then inherit
// its framing for the turn. Only body views receive the full outfit/proportion brief.
export const CHARACTER_SHEET_PROMPT_VERSION = 'fixed-views-v1';
const CHARACTER_SHEET_SHARED = 'Create ONE photographic image with exactly ONE INSTANCE of the same adult person, in ONE pose, from ONE camera angle, on a 9:16 canvas. Preserve the recognizable facial identity, hairstyle, hair length and accessories from <image1>. Use a neutral light-gray seamless studio background (#D9D9D9), soft even studio lighting and clear natural skin detail. No collage, split screen, inset portrait, extra person, text, border or watermark. ';

export function buildCharacterSheetPanelPrompt(brief, viewId) {
  const shared = CHARACTER_SHEET_SHARED;
  if (viewId === 'front_portrait') return `Edit <image1> only. Create a FRONT-FACING CHEST-UP IDENTITY PORTRAIT of the same person. Use the reference for identity, complete hairstyle and visible upper garment. Reframe the source as needed to show the complete hair silhouette, neck, both shoulders and a short band of upper chest; leave a small clear margin above the topmost hair and crop the bottom at the upper chest. The head is upright without tilt, the face is centered and facing directly into the camera, and both eyes look into the camera. Preserve the visible garment and accessories. ${shared}Do not show the waist or hands, and do not turn this portrait into a half-body or full-body shot.`;
  // This short edit instruction is the generic form of the successful standalone
  // male 45-degree test. Do not impose fresh landmark positions on its input.
  if (viewId === 'three_quarter_portrait') return 'Edit <image1> only. 只修改头部和视线方向：将人物的脸和视线从正面转为向角色左侧45度，头部保持直立，不歪头。严格保持输入图的胸以上特写景别、头部在画面中的大小和位置、五官身份、发型、可见上衣、浅灰背景、光线和画质不变。不要拉远，不要生成全身像或半身像，不要改变画幅。输出仍然是一张单人的9:16胸以上头像。';
  // Full heads establish anatomy before the existing deterministic body crop.
  // Position hints remain tied to that crop; the model is not asked to crop itself.
  const bodyFraming = 'Show one complete natural head and the entire body down to the soles. Keep 5% clear background above the hair, the base of the neck near 18% of frame height, and both feet fully visible near 95% of frame height. Both arms, hands, legs and feet remain fully inside the frame, with arms relaxed at the sides. ';
  if (viewId === 'back_body') return `Edit <image1> only. Create a HEAD-TO-TOE FULL-BODY BACK VIEW of the same person standing naturally. The head, shoulders, torso and feet face directly away from the camera; do not look back or show the face. ${bodyFraming}${shared}Use the following outfit and body-proportion specification for this one person, keeping natural anatomy and consistent garment colors, materials and fit: ${brief.trim()}`;
  if (viewId === 'front_body') return `Edit <image1> only. Create a HEAD-TO-TOE FULL-BODY FRONT VIEW of the same person standing naturally, facing directly toward the camera. ${bodyFraming}${shared}Use the following outfit and body-proportion specification for this one person, keeping natural anatomy and consistent garment colors, materials and fit: ${brief.trim()}`;
  throw new Error('未知的角色四视图面板。');
}

// One self-contained ComfyUI API graph: one reference, four native Qwen edits,
// then a lossless 2×2 stitch. No intermediate SaveImage and no HD/refine stage.
export function buildCharacterSheetWorkflow(options) {
  const cacheDevice = validateQwenCacheDevice(options.qwenCacheDevice === undefined ? 'auto' : options.qwenCacheDevice);
  const angleSeed = validateCharacterSheetAngleSeed(options.characterSheetAngleSeed === undefined ? CHARACTER_SHEET_ANGLE_SEED : options.characterSheetAngleSeed);
  const source = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  if (!source) throw new Error('角色四视图生成需要连接一张单人角色参考图。');
  const brief = options.prompt?.trim();
  if (!brief) throw new Error('请先输入角色身份、穿搭和身材比例等创作要求。');
  const useRealism = options.imageLora === 'qwen21Realism';
  const graph = {
    model: { class_type: 'UNETLoader', inputs: { unet_name: QWEN21_EDIT_MODEL.unet, weight_dtype: 'default' } },
    ...(useRealism ? { realism: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: QWEN21_EDIT_MODEL.realismLora, strength_model: Number(options.loraStrength ?? 0.6) } } } : {}),
    text: { class_type: 'CLIPLoader', inputs: { clip_name: QWEN21_EDIT_MODEL.clip, type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: QWEN21_EDIT_MODEL.vae } },
    source: { class_type: 'LoadImage', inputs: { image: source.name } },
    // Qwen derives its output latent from this reference canvas. Normalizing it
    // fixes all four native outputs to 9:16 without a generative HD redraw.
    reference: { class_type: 'ImageScale', inputs: { image: ['source', 0], upscale_method: 'lanczos', width: CHARACTER_SHEET_PANEL.width, height: CHARACTER_SHEET_PANEL.height, crop: 'center' } },
  };
  const sampledModel = cacheDevice === 'cpu' ? addQwenCpuReferenceCache(graph, [useRealism ? 'realism' : 'model', 0]) : [useRealism ? 'realism' : 'model', 0];
  for (const view of CHARACTER_SHEET_VIEWS) {
    graph[`${view.id}_encode`] = { class_type: 'TextEncodeQwenImage21', inputs: {
      clip: ['text', 0], prompt: buildCharacterSheetPanelPrompt(brief, view.id), negative_prompt: '',
      resolution: Number(options.qwenRefResolution || 1536),
      'images.image_1': view.id === 'three_quarter_portrait' ? ['front_portrait_decode', 0] : ['reference', 0],
      vae: ['vae', 0],
    } };
    graph[`${view.id}_sample`] = { class_type: 'KSampler', inputs: {
      model: sampledModel, seed: view.id === 'three_quarter_portrait' ? angleSeed : Number(options.seed) + view.seedOffset,
      steps: Number(options.qwenSteps || 40), cfg: 1, sampler_name: 'euler', scheduler: 'simple',
      positive: [`${view.id}_encode`, 0], negative: [`${view.id}_encode`, 1], latent_image: [`${view.id}_encode`, 2], denoise: 1,
    } };
    graph[`${view.id}_decode`] = { class_type: 'VAEDecode', inputs: { samples: [`${view.id}_sample`, 0], vae: ['vae', 0] } };
    if (view.id.endsWith('_body')) {
      graph[`${view.id}_crop`] = { class_type: 'ImageCrop', inputs: { image: [`${view.id}_decode`, 0], ...CHARACTER_SHEET_BODY_CROP } };
      graph[`${view.id}_output`] = { class_type: 'ImageScale', inputs: {
        image: [`${view.id}_crop`, 0], upscale_method: 'lanczos',
        width: CHARACTER_SHEET_PANEL.width, height: CHARACTER_SHEET_PANEL.height, crop: 'disabled',
      } };
    }
  }
  graph.top_row = { class_type: 'ImageStitch', inputs: { image1: ['front_portrait_decode', 0], image2: ['three_quarter_portrait_decode', 0], direction: 'right', match_image_size: false, spacing_width: 0, spacing_color: 'white' } };
  graph.bottom_row = { class_type: 'ImageStitch', inputs: { image1: ['back_body_output', 0], image2: ['front_body_output', 0], direction: 'right', match_image_size: false, spacing_width: 0, spacing_color: 'white' } };
  graph.quad = { class_type: 'ImageStitch', inputs: { image1: ['top_row', 0], image2: ['bottom_row', 0], direction: 'down', match_image_size: false, spacing_width: 0, spacing_color: 'white' } };
  graph.save = { class_type: 'SaveImage', inputs: { images: ['quad', 0], filename_prefix: 'image/H3_CharacterSheet' } };
  return graph;
}

export const LOCAL_REALISM_PROMPT = 'Edit <image1>: enhance only the selected skin with subtle natural photographic microtexture, realistic fine pores and softly varied skin tones. Keep the original person, identity, facial features, makeup colors, expression, lighting, hair and all unselected pixels unchanged. Avoid beauty filtering, waxy skin, airbrushing, contour changes and age changes.';

// Derive each persisted stage from the comparison graph so model, prompt,
// sampling and body-crop settings have one source of truth.
export function buildCharacterSheetQueuePlan(options) {
  const graph = buildCharacterSheetWorkflow(options);
  const panelInput = (id) => `__H3_CHARACTER_SHEET_PANEL_${id}__`;
  const collect = (source, output) => {
    const result = {};
    const visit = (id) => {
      if (result[id]) return;
      result[id] = structuredClone(source[id]);
      for (const input of Object.values(source[id].inputs)) {
        if (Array.isArray(input) && input.length === 2 && typeof input[0] === 'string' && source[input[0]] && Number.isInteger(input[1])) visit(input[0]);
      }
    };
    visit(output);
    return result;
  };
  const panels = CHARACTER_SHEET_VIEWS.map((view) => {
    const source = structuredClone(graph);
    const angle = view.id === 'three_quarter_portrait';
    if (angle) {
      // SaveImage -> upload -> LoadImage uses the same RGB boundary as a
      // standalone edit, rather than retaining the prior decoded tensor.
      source.angle_source = { class_type: 'LoadImage', inputs: { image: panelInput('front_portrait') } };
      source[`${view.id}_encode`].inputs['images.image_1'] = ['angle_source', 0];
    }
    const output = `${view.id}_${view.id.endsWith('_body') ? 'output' : 'decode'}`;
    source.save = { class_type: 'SaveImage', inputs: { images: [output, 0], filename_prefix: `image/H3_CharacterSheetPanel_${view.id}` } };
    return { id: view.id, label: view.label, dependsOn: angle ? ['front_portrait'] : [], single: collect(source, 'save') };
  });
  const stitch = {};
  for (const view of CHARACTER_SHEET_VIEWS) stitch[`${view.id}_load`] = { class_type: 'LoadImage', inputs: { image: panelInput(view.id) } };
  for (const id of ['top_row', 'bottom_row', 'quad', 'save']) stitch[id] = structuredClone(graph[id]);
  stitch.top_row.inputs.image1 = ['front_portrait_load', 0];
  stitch.top_row.inputs.image2 = ['three_quarter_portrait_load', 0];
  stitch.bottom_row.inputs.image1 = ['back_body_load', 0];
  stitch.bottom_row.inputs.image2 = ['front_body_load', 0];
  return { kind: 'characterSheet', memoryPolicy: 'preserve', panels, stitch };
}

export function buildLocalRealismWorkflow(options) {
  const source = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  const customMask = options.references?.find((ref) => ref.slot === 'identity' && ref.kind === 'image');
  if (!source) throw new Error('局部写实修复需要连接一张正面人像。');
  const prompt = options.prompt?.trim() || LOCAL_REALISM_PROMPT;
  const targetSize = Number(options.localRealismSize || 768);
  const useRealism = options.imageLora === 'qwen21Realism';
  return {
    model: { class_type: 'UNETLoader', inputs: { unet_name: QWEN21_EDIT_MODEL.unet, weight_dtype: 'default' } },
    ...(useRealism ? { realism: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: QWEN21_EDIT_MODEL.realismLora, strength_model: Number(options.loraStrength ?? 0.45) } } } : {}),
    text: { class_type: 'CLIPLoader', inputs: { clip_name: QWEN21_EDIT_MODEL.clip, type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: QWEN21_EDIT_MODEL.vae } },
    source: { class_type: 'LoadImage', inputs: { image: source.name } },
    ...(customMask ? {
      mask_image: { class_type: 'LoadImage', inputs: { image: customMask.name } },
      mask_channel: { class_type: 'ImageToMask', inputs: { image: ['mask_image', 0], channel: 'red' } },
    } : {
      skin: { class_type: 'H3PortraitSkinMask', inputs: { image: ['source', 0], mode: options.localMaskMode || 'front' } },
    }),
    crop: { class_type: 'InpaintCropImproved', inputs: {
      image: ['source', 0], mask: [customMask ? 'mask_channel' : 'skin', 0], downscale_algorithm: 'bilinear', upscale_algorithm: 'bicubic',
      preresize: false, preresize_mode: 'ensure minimum resolution', preresize_min_width: 1024, preresize_min_height: 1024,
      preresize_max_width: 16384, preresize_max_height: 16384, mask_fill_holes: false,
      mask_expand_pixels: Number(options.localMaskExpand ?? 0), mask_invert: false,
      mask_blend_pixels: Number(options.localMaskBlend ?? 16), mask_hipass_filter: 0.1,
      extend_for_outpainting: false, extend_up_factor: 1, extend_down_factor: 1, extend_left_factor: 1, extend_right_factor: 1,
      context_from_mask_extend_factor: 1.2, output_resize_to_target_size: true,
      output_target_width: targetSize, output_target_height: targetSize, output_padding: '32', device_mode: 'cpu (compatible)',
    } },
    encode: { class_type: 'TextEncodeQwenImage21', inputs: {
      clip: ['text', 0], prompt: prompt.includes('<image1>') ? prompt : `Edit <image1>: ${prompt}`,
      negative_prompt: '', resolution: targetSize, 'images.image_1': ['crop', 1], vae: ['vae', 0],
    } },
    // Qwen 2.1's third text-encoder output is an empty latent, not the source
    // image. Partial denoising must start from the encoded crop or the masked
    // area drifts in colour and loses identity.
    latent: { class_type: 'VAEEncode', inputs: { pixels: ['crop', 1], vae: ['vae', 0] } },
    mask: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['latent', 0], mask: ['crop', 2] } },
    sample: { class_type: 'KSampler', inputs: {
      model: [useRealism ? 'realism' : 'model', 0], seed: Number(options.seed), steps: Number(options.localRealismSteps || 25), cfg: 1,
      sampler_name: 'euler', scheduler: 'simple', positive: ['encode', 0], negative: ['encode', 1], latent_image: ['mask', 0], denoise: Number(options.localRealismDenoise ?? 0.2),
    } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    stitch: { class_type: 'InpaintStitchImproved', inputs: { stitcher: ['crop', 0], inpainted_image: ['decode', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['stitch', 0], filename_prefix: 'image/H3_LocalRealism' } },
  };
}

export const OUTFIT_PRESETS = {
  blackSatin: {
    label: '黑缎蕾丝',
    prompt: 'an elegant sexy black satin camisole crop top with delicate thin black straps and subtle black lace trim, paired with matching high-waisted black satin tailored shorts',
  },
  burgundyVelvet: {
    label: '酒红丝绒',
    prompt: 'an elegant sexy burgundy velvet camisole crop top with delicate thin straps and a tasteful sweetheart neckline, paired with matching high-waisted burgundy velvet tailored shorts',
  },
  emeraldSilk: {
    label: '墨绿缎面',
    prompt: 'an elegant sexy emerald-green silk halter crop top with a draped neckline, paired with a matching high-waisted emerald satin mini skirt',
  },
  ivoryTailoring: {
    label: '象牙白裤装',
    prompt: 'an elegant sexy ivory satin off-shoulder draped crop top, paired with high-waisted ivory wide-leg tailored trousers',
  },
};

const QWEN_QUAD_PRESERVE = 'Edit <image1>: preserve the exact original four-panel composition: top-left front-face close-up portrait, top-right side-profile close-up portrait, bottom-left full-body back view, bottom-right full-body front view; do not change any panel crop, camera distance or viewing direction. Preserve the exact same adult woman, facial identity, facial proportions, purple butterfly hair accessory, forehead ornament, necklace, very long black half-up hairstyle, body proportions, poses and gray studio background. ';

// Tested on the current heroine sheet with Qwen 2.1 at 40 steps and 1024 reference resolution.
export const QWEN_OUTFIT_PRESETS = {
  butterPolo: {
    label: '奶黄 Polo 牛仔裙',
    prompt: `${QWEN_QUAD_PRESERVE}Change only the clothing and footwear to this complete coordinated summer outfit from a real Taobao product reference: a pale butter-yellow fine-ribbed knit short-sleeve Polo top with a neat small pointed collar, a short three-button placket, a tiny subtle dark embroidered motif on the left chest, a fitted cropped waist; paired with a high-waisted pale light-blue washed denim A-line mini skirt with a button fly and clean simple seams. Fresh youthful 2026 summer styling, attractive slim proportions, breathable fine knit, clear pale-yellow and light-blue color blocking. Complete the look with one matching pair of elegant ivory-white women's open-toe sandals in both full-body panels: delicate thin straps across the toes and instep, a slim adjustable ankle strap, a low comfortable block heel, simple refined summer design, correctly fitted on both feet. Both shoes must be fully visible in the front and back full-body views; no bare feet. Completely remove the original pale-blue camisole, denim shorts and the pale-blue fabric bow at the left shoulder and left chest; replace those areas naturally with black hair, skin or the new outfit. No jacket, no trousers, no leather clothing, no metallic fabric, no office wear, no old bows, no extra jewelry, no extra people, no text, no logos, no sneakers, no boots, no platform soles, no high stiletto heels. Photorealistic studio photography.`,
  },
  mistBlueLace: {
    label: '雾蓝蕾丝白裙',
    prompt: `${QWEN_QUAD_PRESERVE}Change only the clothing and footwear to this complete coordinated summer outfit from a real Taobao product reference: a misty sky-blue faux-two-piece short-sleeve top, with an ivory lace-trimmed camisole visible inside the low scoop neckline, a fitted dusty-blue button-front outer layer, delicate small fabric-covered buttons, subtle vertical seams and gently shaped short sleeves; paired with a high-waisted airy white mini skirt with soft gathers and a light flowing hem. Feminine French-inspired summer styling, layered neckline detail, breathable lightweight fabric, clear mist-blue, ivory and white palette, sexy but not formal. Complete the look with one matching pair of elegant ivory-white women's open-toe sandals in both full-body panels: delicate thin straps across the toes and instep, a slim adjustable ankle strap, a low comfortable block heel, simple refined summer design, correctly fitted on both feet. Both shoes must be fully visible in the front and back full-body views; no bare feet. Completely remove the original pale-blue camisole, denim shorts and the pale-blue fabric bow at the left shoulder and left chest; replace those areas naturally with black hair, skin or the new outfit. No jacket, no trousers, no leather clothing, no metallic fabric, no office wear, no old bows, no extra jewelry, no extra people, no text, no logos, no sneakers, no boots, no platform soles, no high stiletto heels. Photorealistic studio photography.`,
  },
  blushDraped: {
    label: '雾粉荡领白裙',
    prompt: `${QWEN_QUAD_PRESERVE}Change only the clothing and footwear to this complete coordinated summer outfit from a real Taobao product reference: a muted blush-pink fitted short-sleeve top with an elegant asymmetric draped cowl neckline, one side gently gathered at the shoulder, diagonal soft ruching across the bodice and a neatly shaped waist; paired with a high-waisted white lightweight flowing mini skirt with soft layered movement and an opaque simple lining. Soft romantic 2026 summer styling, detailed draping rather than a plain T-shirt, breathable fine fabric, clear blush-pink and white palette, feminine and sexy without looking like evening wear. Complete the look with one matching pair of elegant ivory-white women's open-toe sandals in both full-body panels: delicate thin straps across the toes and instep, a slim adjustable ankle strap, a low comfortable block heel, simple refined summer design, correctly fitted on both feet. Both shoes must be fully visible in the front and back full-body views; no bare feet. Completely remove the original pale-blue camisole, denim shorts and the pale-blue fabric bow at the left shoulder and left chest; replace those areas naturally with black hair, skin or the new outfit. No jacket, no trousers, no leather clothing, no metallic fabric, no office wear, no old bows, no extra jewelry, no extra people, no text, no logos, no sneakers, no boots, no platform soles, no high stiletto heels. Photorealistic studio photography.`,
  },
};

export const OUTFIT_PANELS = [
  { id: 'tl', label: '正面近景', x: 0, y: 0, width: 382, height: 590, outputWidth: 768, outputHeight: 1184, preserve: true },
  { id: 'tr', label: '侧面近景', x: 386, y: 0, width: 382, height: 590, outputWidth: 768, outputHeight: 1184, preserve: true },
  { id: 'bl', label: '背面全身', view: 'full-body back view', x: 0, y: 600, width: 382, height: 744, outputWidth: 768, outputHeight: 1488 },
  { id: 'br', label: '正面全身', view: 'full-body front view', x: 386, y: 600, width: 382, height: 744, outputWidth: 768, outputHeight: 1488 },
];

const OUTFIT_PANEL_IDS = ['tl', 'tr', 'bl', 'br'];
const OUTFIT_PANEL_SEED_OFFSETS = [18, 24, 0, 6];
const OUTFIT_VIEWS = {
  front: { label: '正面', prompt: 'front view' },
  side: { label: '侧面', prompt: 'side view' },
  back: { label: '背面', prompt: 'back view' },
  threeQuarter: { label: '三分之四', prompt: 'three-quarter view' },
};
const outfitLayoutPanel = (id, role, view, x, y, width, height, headless = false) => ({
  id, role, view, x, y, width, height, headless,
  label: `${OUTFIT_VIEWS[view].label}${role === 'portrait' ? '近景' : '全身'}`,
  outputWidth: 768,
  outputHeight: role === 'portrait' ? 1184 : 1488,
});

// Generic layouts crop the original image with normalized bounds. They never
// assume that a character sheet uses the same pixel size or a 2×2 arrangement.
export const OUTFIT_LAYOUTS = {
  equalGrid: [
    outfitLayoutPanel('tl', 'portrait', 'front', 0, 0, 0.5, 0.5),
    outfitLayoutPanel('tr', 'portrait', 'side', 0.5, 0, 0.5, 0.5),
    outfitLayoutPanel('bl', 'body', 'back', 0, 0.5, 0.5, 0.5, true),
    outfitLayoutPanel('br', 'body', 'front', 0.5, 0.5, 0.5, 0.5, true),
  ],
  mixedGrid: [
    outfitLayoutPanel('tl', 'portrait', 'front', 0, 0, 1074 / 2160, 1708 / 3840),
    outfitLayoutPanel('tr', 'portrait', 'side', 1087 / 2160, 0, 1073 / 2160, 1708 / 3840),
    outfitLayoutPanel('bl', 'body', 'back', 0, 1900 / 3840, 1074 / 2160, 1940 / 3840, true),
    outfitLayoutPanel('br', 'body', 'front', 1087 / 2160, 1720 / 3840, 1073 / 2160, 2120 / 3840, true),
  ],
  horizontal: [
    outfitLayoutPanel('tl', 'body', 'front', 0, 0, 0.25, 1),
    outfitLayoutPanel('tr', 'body', 'side', 0.25, 0, 0.25, 1),
    outfitLayoutPanel('bl', 'body', 'back', 0.5, 0, 0.25, 1),
    outfitLayoutPanel('br', 'body', 'threeQuarter', 0.75, 0, 0.25, 1),
  ],
};

export function resolveOutfitPanelSeed(options, panel, panels = resolveOutfitPanels(options)) {
  const index = Math.max(0, panels.findIndex((item) => item.id === panel.id));
  return Number(options.seed) + (OUTFIT_PANEL_SEED_OFFSETS[index] || 0);
}

// Fixed four-view framing. These are applied to the final composition, not
// left to the diffusion model: a portrait is cropped above the chest, and a
// headless body panel keeps its source top band so no head can be painted in.
export const OUTFIT_PORTRAIT_CROP = [0, 0, 1, 0.72];
export const OUTFIT_HEADLESS_GUARD = 0.12;

function applyOutfitFraming(panel) {
  const next = { ...panel };
  if (next.role === 'portrait') {
    if (!next.presentationCrop) next.presentationCrop = [...OUTFIT_PORTRAIT_CROP];
    if (next.preserveOutsideRegion === undefined) next.preserveOutsideRegion = true;
    if (!next.editRegion) next.editRegion = [0, 0.72, 1, 0.28];
  } else {
    if (next.preserveOutsideRegion === undefined) next.preserveOutsideRegion = true;
    if (!next.editRegion) next.editRegion = [0, OUTFIT_HEADLESS_GUARD, 1, 1 - OUTFIT_HEADLESS_GUARD];
  }
  return next;
}

function normalizeCustomOutfitPanels(value) {
  let input = value;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new Error('自定义面板配置不是有效的 JSON。'); }
  }
  if (!Array.isArray(input) || input.length !== 4) throw new Error('自定义换装版面需要 4 个面板配置。');
  const ids = new Set();
  return input.map((panel, index) => {
    const id = String(panel?.id || OUTFIT_PANEL_IDS[index]);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(id) || ids.has(id)) throw new Error(`第 ${index + 1} 个面板的 ID 无效或重复。`);
    ids.add(id);
    const role = panel?.role || 'body';
    const view = panel?.view || 'front';
    if (!['portrait', 'body'].includes(role) || !OUTFIT_VIEWS[view]) throw new Error(`第 ${index + 1} 个面板的景别或视角无效。`);
    const bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(panel?.[key])]));
    if (Object.values(bounds).some((number) => !Number.isFinite(number)) || bounds.width <= 0 || bounds.height <= 0 || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > 1.000001 || bounds.y + bounds.height > 1.000001) {
      throw new Error(`第 ${index + 1} 个面板边界无效：x/y/width/height 使用 0–1 比例，且不能超出原图。`);
    }
    if (panel.preserveOutsideRegion !== undefined && typeof panel.preserveOutsideRegion !== 'boolean') throw new Error(`第 ${index + 1} 个面板的 preserveOutsideRegion 必须为布尔值。`);
    if (panel.presentationCrop !== undefined && (!Array.isArray(panel.presentationCrop) || panel.presentationCrop.length !== 4 || panel.presentationCrop.some((n) => typeof n !== 'number' || !Number.isFinite(n)) || panel.presentationCrop[0] < 0 || panel.presentationCrop[1] < 0 || panel.presentationCrop[2] <= 0 || panel.presentationCrop[3] <= 0 || panel.presentationCrop[0] + panel.presentationCrop[2] > 1 || panel.presentationCrop[1] + panel.presentationCrop[3] > 1)) {
      throw new Error(`第 ${index + 1} 个面板的 presentationCrop 必须为 [x, y, width, height]，使用 0–1 比例。`);
    }
    if (panel.editRegion !== undefined && (!Array.isArray(panel.editRegion) || panel.editRegion.length !== 4 || panel.editRegion.some((n) => typeof n !== 'number' || !Number.isFinite(n)) || panel.editRegion[0] < 0 || panel.editRegion[1] < 0 || panel.editRegion[2] <= 0 || panel.editRegion[3] <= 0 || panel.editRegion[0] + panel.editRegion[2] > 1 || panel.editRegion[1] + panel.editRegion[3] > 1)) {
      throw new Error(`第 ${index + 1} 个面板的 editRegion 必须为面板内的 [x, y, width, height]，使用 0–1 比例。`);
    }
    // Missing editRegion is filled by applyOutfitFraming below (portrait:
    // lower garment band; headless body: preserve the top neck/collar band).
    if (panel.garmentPrompt !== undefined && (typeof panel.garmentPrompt !== 'string' || !panel.garmentPrompt.trim())) throw new Error(`第 ${index + 1} 个面板的 garmentPrompt 必须为非空文字，仅描述该面板可见的衣物。`);
    return {
      ...outfitLayoutPanel(id, role, view, bounds.x, bounds.y, bounds.width, bounds.height, Boolean(panel?.headless)),
      label: typeof panel?.label === 'string' && panel.label.trim() ? panel.label.trim() : `${OUTFIT_VIEWS[view].label}${role === 'portrait' ? '近景' : '全身'}`,
      ...(panel.editRegion !== undefined ? { editRegion: [...panel.editRegion] } : {}),
      ...(panel.preserveOutsideRegion !== undefined ? { preserveOutsideRegion: panel.preserveOutsideRegion } : {}),
      ...(panel.presentationCrop !== undefined ? { presentationCrop: [...panel.presentationCrop] } : {}),
      ...(panel.garmentPrompt !== undefined ? { garmentPrompt: panel.garmentPrompt.trim() } : {}),
    };
  });
}

export function resolveOutfitPanels(options = {}) {
  const layout = options.outfitLayout || 'legacy';
  if (layout === 'legacy') return OUTFIT_PANELS.map(applyOutfitFraming);
  if (layout === 'custom') return normalizeCustomOutfitPanels(options.outfitPanels).map(applyOutfitFraming);
  if (!OUTFIT_LAYOUTS[layout]) throw new Error('未知的母图版面。');
  return OUTFIT_LAYOUTS[layout].map((panel) => applyOutfitFraming({ ...panel }));
}

function addNormalizedImageCrop(graph, image, crop, prefix = 'frame_') {
  const key = (name) => `${prefix}${name}`;
  const [x, y, width, height] = crop;
  graph[key('size')] = { class_type: 'GetImageSize', inputs: { image } };
  graph[key('x')] = { class_type: 'SimpleMath+', inputs: { a: [key('size'), 0], value: `round(a * ${x})` } };
  graph[key('y')] = { class_type: 'SimpleMath+', inputs: { a: [key('size'), 1], value: `round(a * ${y})` } };
  graph[key('width')] = { class_type: 'SimpleMath+', inputs: { a: [key('size'), 0], value: `max(1, round(a * ${width}))` } };
  graph[key('height')] = { class_type: 'SimpleMath+', inputs: { a: [key('size'), 1], value: `max(1, round(a * ${height}))` } };
  graph[key('crop')] = { class_type: 'ImageCrop', inputs: {
    image,
    x: [key('x'), 0], y: [key('y'), 0], width: [key('width'), 0], height: [key('height'), 0],
  } };
  return [key('crop'), 0];
}

function addOutfitPanelGeometry(graph, panel, prefix = '') {
  const key = (name) => `${prefix}${name}`;
  graph[key('x')] = { class_type: 'SimpleMath+', inputs: { a: ['size', 0], value: `round(a * ${panel.x})` } };
  graph[key('y')] = { class_type: 'SimpleMath+', inputs: { a: ['size', 1], value: `round(a * ${panel.y})` } };
  graph[key('x2')] = { class_type: 'SimpleMath+', inputs: { a: ['size', 0], value: `round(a * ${Math.min(1, panel.x + panel.width)})` } };
  graph[key('y2')] = { class_type: 'SimpleMath+', inputs: { a: ['size', 1], value: `round(a * ${Math.min(1, panel.y + panel.height)})` } };
  graph[key('width')] = { class_type: 'SimpleMath+', inputs: { a: [key('x2'), 0], b: [key('x'), 0], value: 'a - b' } };
  graph[key('height')] = { class_type: 'SimpleMath+', inputs: { a: [key('y2'), 0], b: [key('y'), 0], value: 'a - b' } };
  return {
    x: [key('x'), 0], y: [key('y'), 0], width: [key('width'), 0], height: [key('height'), 0],
  };
}

// Keep this mask binary at native resolution. The final composite must copy
// untouched source pixels, even when a separate HD stage changes the whole image.
function addOutfitRegionMask(graph, panel, width, height, prefix = 'edit_') {
  const key = (name) => `${prefix}${name}`;
  const [x, y, w, h] = panel.editRegion;
  const math = (name, a, value, b) => {
    graph[key(name)] = { class_type: 'SimpleMath+', inputs: { a, ...(b ? { b } : {}), value } };
    return [key(name), 0];
  };
  const left = math('x', width, `min(a - 1, round(a * ${x}))`);
  const top = math('y', height, `min(a - 1, round(a * ${y}))`);
  const regionWidth = math('width', width, `max(1, round(a * ${x + w}) - b)`, left);
  const regionHeight = math('height', height, `max(1, round(a * ${y + h}) - b)`, top);
  graph[key('background')] = { class_type: 'SolidMask', inputs: { value: 0, width, height } };
  graph[key('foreground')] = { class_type: 'SolidMask', inputs: { value: 1, width: regionWidth, height: regionHeight } };
  graph[key('mask')] = { class_type: 'MaskComposite', inputs: { destination: [key('background'), 0], source: [key('foreground'), 0], x: left, y: top, operation: 'add' } };
  return [key('mask'), 0];
}

function addOutfitRegionProtection(graph, panel, inputNode, isMuse) {
  graph.edit_native_size = { class_type: 'GetImageSize', inputs: { image: [inputNode, 0] } };
  const width = ['edit_native_size', 0], height = ['edit_native_size', 1];
  const mask = addOutfitRegionMask(graph, panel, width, height);
  if (isMuse) {
    // Muse already VAE-encodes this exact crop for its identity patch. Reuse
    // that encoded source as target, so its dimensions cannot drift.
    graph.edit_latent = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['source_latent', 0], mask } };
    graph.patch.inputs.target_latent = ['edit_latent', 0];
  } else {
    // TextEncodeQwenImage21 chooses the reference dimensions from resolution.
    // Its latent is spatially compressed by 16 (native nodes_qwen.py).
    graph.edit_latent_size = { class_type: 'GetLatentSize', inputs: { latent: ['encode', 2] } };
    for (const [name, index] of [['width', 0], ['height', 1]]) {
      graph[`edit_sample_${name}`] = { class_type: 'SimpleMath+', inputs: { a: ['edit_latent_size', index], value: 'a * 16' } };
    }
    graph.edit_sample_source = { class_type: 'ImageScale', inputs: { image: [inputNode, 0], upscale_method: 'lanczos', width: ['edit_sample_width', 0], height: ['edit_sample_height', 0], crop: 'disabled' } };
    graph.edit_sample_mask = { class_type: 'ResizeMask', inputs: { mask, width: ['edit_sample_width', 0], height: ['edit_sample_height', 0], keep_proportions: false, upscale_method: 'nearest-exact', crop: 'disabled' } };
    graph.edit_source_latent = { class_type: 'VAEEncode', inputs: { pixels: ['edit_sample_source', 0], vae: ['vae', 0] } };
    graph.edit_latent = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['edit_source_latent', 0], mask: ['edit_sample_mask', 0] } };
  }
  graph.sample.inputs.latent_image = ['edit_latent', 0];
  graph.edit_output_resize = { class_type: 'ImageScale', inputs: { image: ['decode', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' } };
  graph.edit_output = { class_type: 'ImageCompositeMasked', inputs: { destination: [inputNode, 0], source: ['edit_output_resize', 0], x: 0, y: 0, resize_source: false, mask } };
  graph.save.inputs.images = ['edit_output', 0];
}

function buildGenericOutfitPrompt(panel, outfit, hasOutfitReference = false) {
  const view = OUTFIT_VIEWS[panel.view].prompt;
  // A local portrait description comes from the current template/user. Never
  // derive one by splitting a full outfit prompt or guessing reference crops.
  const localPortraitGarment = panel.role === 'portrait' && panel.preserveOutsideRegion && panel.garmentPrompt;
  if (localPortraitGarment) hasOutfitReference = false;
  const referenceInstruction = hasOutfitReference ? ' <image2> is ONLY a garment reference: reproduce its visible garment colors, neckline, fabric, details and footwear where applicable; ignore its person, skin, face, body shape, pose, camera and background.' : '';
  if (panel.role === 'portrait') {
    return `Edit <image1> only: this is one exact ${view} CLOSE-UP PORTRAIT, not a half-body or outfit view. Image1 is authoritative for identity, camera, framing, head size and position, hair boundaries, pose and proportions. Preserve the exact original crop: the bottom edge must cut through the upper chest at exactly the same place as image1. Change only the visible upper-chest garment fabric and straps to ${localPortraitGarment || outfit}; ignore every garment in the clothing reference that is outside this crop.${referenceInstruction} Preserve the exact face, facial landmark locations, expression, makeup, original hairstyle, accessories and background. The garment hem, waist, abdomen, hips, shorts, skirt and hands are outside the frame and must never appear. Do not zoom out, do not reveal more torso, do not expand the bust or shoulders. Remove only the visible original garment fabric. Same single view only, no collage, text, logos, extra people or duplicated limbs.`;
  }
  const cropInstruction = panel.headless
    ? `Preserve this exact neck-down ${view.toUpperCase()} body composition. The head is outside the image: no head, face, skull, scalp, ears, eyes, portrait or small face anywhere. Hair that was already hanging from above the frame must remain long and natural; do not create a head or hair bun at the top edge.`
    : `Preserve the exact original ${view} full-body crop, head visibility, face, identity, head size and position; do not add or remove a head.`;
  return `Edit <image1> only. Image1 is the authoritative character, camera, framing, pose and proportions.${referenceInstruction} Change only the garments and footwear to ${outfit}. ${cropInstruction} Keep the original pose, shoulder width, waist circumference and height, torso length, hip width, long leg length and body silhouette in exactly the source positions. Never zoom out or extend the canvas. Keep the original hairstyle and hair length, skin tone, smooth skin texture, soft tonal transitions, knee shape and shading, calf contours and background. Do not enhance or invent musculature, tendons, veins, knee dimples or high-contrast anatomical shadows. Garments must follow the existing body without widening or slimming it. Both feet must remain naturally planted in their original positions with the original heel contact; do not raise the heels. Do not transfer the reference person body shape or shorten the legs. Remove the original garments completely with no leftover clothing. Same single view only, no collage, text, logos, extra people or duplicated limbs.`;
}

function addMuseOutfitEditing(graph, options, inputNode, prompt, seed, hasOutfitReference) {
  graph.model = { class_type: 'UNETLoader', inputs: { unet_name: VERSIONED_IMAGE_MODELS.museV4, weight_dtype: 'default' } };
  graph.identity = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: IDENTITY_EDIT_MODEL.lora, strength_model: 1 } };
  graph.text = { class_type: 'CLIPLoader', inputs: { clip_name: IMAGE_MODEL.clip, type: 'krea2', device: 'default' } };
  graph.vae = { class_type: 'VAELoader', inputs: { vae_name: IMAGE_MODEL.vae } };
  graph.crop_size = { class_type: 'GetImageSize', inputs: { image: [inputNode, 0] } };
  graph.source_latent = { class_type: 'VAEEncode', inputs: { pixels: [inputNode, 0], vae: ['vae', 0] } };
  graph.latent = { class_type: 'EmptySD3LatentImage', inputs: { width: ['crop_size', 0], height: ['crop_size', 1], batch_size: 1 } };
  const referenceImages = { image: [inputNode, 0], ...(hasOutfitReference ? { image_b: ['outfit_reference', 0] } : {}) };
  graph.positive = { class_type: 'Krea2EditGroundedEncode', inputs: { clip: ['text', 0], prompt, ...referenceImages, grounding_px: 768 } };
  graph.negative = { class_type: 'Krea2EditGroundedEncode', inputs: { clip: ['text', 0], prompt: '', ...referenceImages, grounding_px: 768 } };
  if (hasOutfitReference) graph.outfit_latent = { class_type: 'VAEEncode', inputs: { pixels: ['outfit_reference', 0], vae: ['vae', 0] } };
  graph.patch = { class_type: 'Krea2EditModelPatch', inputs: {
    model: ['identity', 0], source_latent: ['source_latent', 0], vae: ['vae', 0], source_image: [inputNode, 0], target_latent: ['latent', 0],
    ...(hasOutfitReference ? { source_latent_b: ['outfit_latent', 0], source_image_b: ['outfit_reference', 0] } : {}),
    ref_boost: hasOutfitReference ? 0.5 : 2, ref_boost_a: 2, fit_mode: 'fit',
    ref_position: hasOutfitReference ? 'beside (right of target)' : 'aligned (trained)', ref_position_a: 'aligned (trained)',
  } };
  graph.sample = { class_type: 'KSampler', inputs: {
    model: ['patch', 0], seed, steps: Number(options.museSteps || 16), cfg: 1.5, sampler_name: 'er_sde', scheduler: 'beta',
    positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0], denoise: Number(options.outfitDenoise ?? 1),
  } };
}

// Every model edits selected panels at their native aspect ratio. SeedVR2 runs in
// a separate prompt for every view, never on the combined character sheet.
export function buildOutfitQuadWorkflow(options) {
  const source = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  const outfitReference = options.references?.find((ref) => ref.slot === 'identity' && ref.kind === 'image');
  if (!source) throw new Error('无抠图换装需要连接一张原始四视图。');
  const outfit = options.prompt?.trim();
  if (!outfit) throw new Error('请先选择或输入一套穿搭。');
  const outfitModel = options.outfitModel || 'qwen21';
  if (!['qwen21', 'qwen21_turbo', 'muse_v4'].includes(outfitModel)) throw new Error('未知的换装模型版本。');
  if (outfitModel === 'qwen21_turbo' && Number(options.outfitDenoise ?? 1) !== 1) throw new Error('Qwen 2.1 Turbo 使用官方完整 8 步日程，重绘强度须为 1。');
  const layout = options.outfitLayout || 'legacy';
  const panel = resolveOutfitPanels(options).find((item) => item.id === (options.outfitPanel || options.panelId));
  if (!panel) throw new Error('未知的换装视图。');
  const useOutfitReference = layout !== 'legacy' && Boolean(outfitReference) && !(panel.role === 'portrait' && panel.preserveOutsideRegion && panel.garmentPrompt);
  const graph = {
    source: { class_type: 'LoadImage', inputs: { image: source.name } },
  };
  if (layout !== 'legacy') {
    if (useOutfitReference) graph.outfit_reference = { class_type: 'LoadImage', inputs: { image: outfitReference.name } };
    graph.size = { class_type: 'GetImageSize', inputs: { image: ['source', 0] } };
    const geometry = addOutfitPanelGeometry(graph, panel, 'panel_');
    graph.crop = { class_type: 'ImageCrop', inputs: { image: ['source', 0], ...geometry } };
  } else {
    graph.sheet = { class_type: 'ImageScale', inputs: { image: ['source', 0], upscale_method: 'lanczos', width: 768, height: 1344, crop: 'disabled' } };
    graph.crop = { class_type: 'ImageCrop', inputs: { image: ['sheet', 0], width: panel.width, height: panel.height, x: panel.x, y: panel.y } };
    graph.single = { class_type: 'ImageScale', inputs: { image: ['crop', 0], upscale_method: 'lanczos', width: panel.outputWidth, height: panel.outputHeight, crop: 'disabled' } };
  }
  // Generic layouts feed the native crop directly to Qwen. Pre-compressing it
  // to about 1 MP changed skin shading and made later HD refinement less stable.
  const inputNode = layout === 'legacy' ? 'single' : 'crop';
  const useRealism = options.imageLora === 'qwen21Realism';
  const realizePortrait = layout === 'legacy' && panel.id === 'tl' && useRealism;
  if (panel.preserve && !realizePortrait) {
    graph.save = { class_type: 'SaveImage', inputs: { images: [inputNode, 0], filename_prefix: `image/H3_OutfitSingle_${panel.id}` } };
    return graph;
  }
  const prompt = layout !== 'legacy' ? buildGenericOutfitPrompt(panel, outfit, useOutfitReference) : realizePortrait
    ? 'Edit <image1>: subtly convert this exact front-facing portrait toward realistic photography without redesigning the person. The original facial geometry is immutable: keep exactly the same eye width, eye height, eye spacing, eyebrow shape, nose width and length, lip width and fullness, cheek width, jawline, chin length, face contour and all facial proportions. Do not make the eyes smaller, face narrower, nose thinner or lips smaller. Preserve the original natural makeup colors, blush, eyeliner, lip color and expression. Preserve the long black half-up hairstyle, purple butterfly accessory, forehead ornament, necklace, clothing, pose, tight crop and gray background. Add only subtle photographic eye detail, individual hair strands and authentic skin microtexture with visible pores and fine facial hair. No beauty filter, no skin smoothing, no airbrushed or waxy skin, no face lifting, no contour reshaping, no makeup removal, no aging. Photorealistic studio portrait photography, no text.'
    : panel.id === 'bl'
      ? `Edit <image1>: this is the exact full-body back view. Preserve the source geometry, pose, narrow waist, waist height, torso length, hip width, long slim legs, gray background and very long black hairstyle. Change only the clothing and footwear to ${outfit}. The source bare midriff defines a very narrow waist: even when the new clothing covers it, keep exactly the same narrow waist circumference, silhouette and height. Garments must follow the body closely at the waist; no loose or padded waist, no straight-column cut, no added folds that widen the waist. Do not add a head or face, do not extend or reframe the canvas, do not redesign the body. Remove the original camisole and denim shorts completely. Photorealistic studio photography, no text.`
      : `Edit <image1>: this is the exact neck-down full-body front view. Preserve the source geometry, neck-down crop, pose, narrow waist, waist height, torso length, shoulder and hip width, long slim legs and gray background. Change only the clothing and footwear to ${outfit}. The source bare midriff defines a very narrow waist: even when the new clothing covers it, keep exactly the same narrow waist circumference, silhouette and height. Garments must follow the body closely at the waist; no loose or padded waist, no straight-column cut, no added folds that widen the waist. Do not add a head or face, do not extend or reframe the canvas, do not redesign the body. Remove the original camisole and denim shorts completely. Photorealistic studio photography, no text.`;
  graph.model = { class_type: 'UNETLoader', inputs: { unet_name: outfitModel === 'qwen21_turbo' ? VERSIONED_IMAGE_MODELS.qwenTurbo : QWEN21_EDIT_MODEL.unet, weight_dtype: 'default' } };
  if (useRealism) graph.realism = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: QWEN21_EDIT_MODEL.realismLora, strength_model: Number(options.loraStrength ?? 0.6) } };
  graph.text = { class_type: 'CLIPLoader', inputs: { clip_name: QWEN21_EDIT_MODEL.clip, type: 'qwen_image', device: 'default' } };
  graph.vae = { class_type: 'VAELoader', inputs: { vae_name: QWEN21_EDIT_MODEL.vae } };
  graph.encode = { class_type: 'TextEncodeQwenImage21', inputs: {
    clip: ['text', 0], prompt, negative_prompt: '',
    resolution: Number(options.qwenRefResolution || (layout === 'legacy' ? 1024 : 1536)),
    'images.image_1': [inputNode, 0],
    ...(useOutfitReference ? { 'images.image_2': ['outfit_reference', 0] } : {}),
    vae: ['vae', 0],
  } };
  graph.sample = { class_type: 'KSampler', inputs: {
    model: [useRealism ? 'realism' : 'model', 0],
    seed: layout === 'legacy' ? Number(options.seed) : resolveOutfitPanelSeed(options, panel),
    steps: Number(options.qwenSteps || 40), cfg: 1,
    sampler_name: 'euler', scheduler: 'simple',
    positive: ['encode', 0], negative: ['encode', 1], latent_image: ['encode', 2],
    denoise: Number(options.outfitDenoise ?? 1),
  } };
  const seed = layout === 'legacy' ? Number(options.seed) : resolveOutfitPanelSeed(options, panel);
  if (outfitModel === 'qwen21_turbo') addQwenTurboSampling(graph, [useRealism ? 'realism' : 'model', 0], seed);
  if (outfitModel === 'muse_v4') {
    delete graph.encode;
    delete graph.realism;
    addMuseOutfitEditing(graph, options, inputNode, prompt, seed, useOutfitReference);
  }
  graph.decode = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } };
  graph.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: `image/H3_OutfitSingle_${panel.id}` } };
  if (panel.preserveOutsideRegion) addOutfitRegionProtection(graph, panel, inputNode, outfitModel === 'muse_v4');
  return graph;
}

export function buildOutfitStitchWorkflow(singleImages, options = {}) {
  const layout = options.outfitLayout || 'legacy';
  const panels = resolveOutfitPanels(options);
  const graph = {};
  if (layout === 'legacy') {
    for (const panel of panels) {
      if (!singleImages[panel.id]) throw new Error(`缺少 ${panel.id} 视角的独立单图。`);
      graph[`${panel.id}_load`] = { class_type: 'LoadImage', inputs: { image: singleImages[panel.id] } };
    }
    graph.top_row = { class_type: 'ImageStitch', inputs: { image1: ['tl_load', 0], image2: ['tr_load', 0], direction: 'right', match_image_size: false, spacing_width: 0, spacing_color: 'white' } };
    graph.bottom_row = { class_type: 'ImageStitch', inputs: { image1: ['bl_load', 0], image2: ['br_load', 0], direction: 'right', match_image_size: false, spacing_width: 0, spacing_color: 'white' } };
    graph.quad = { class_type: 'ImageStitch', inputs: { image1: ['top_row', 0], image2: ['bottom_row', 0], direction: 'down', match_image_size: false, spacing_width: 0, spacing_color: 'white' } };
    graph.save = { class_type: 'SaveImage', inputs: { images: ['quad', 0], filename_prefix: 'image/H3_OutfitQuad' } };
    return graph;
  }
  const source = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  if (!source) throw new Error('按原版面合成需要连接原始四视图。');
  graph.source = { class_type: 'LoadImage', inputs: { image: source.name } };
  graph.size = { class_type: 'GetImageSize', inputs: { image: ['source', 0] } };
  let destination = ['source', 0];
  for (const panel of panels) {
    if (!singleImages[panel.id]) throw new Error(`缺少 ${panel.label} 的独立单图。`);
    const prefix = `${panel.id}_`;
    graph[`${prefix}load`] = { class_type: 'LoadImage', inputs: { image: singleImages[panel.id] } };
    const geometry = addOutfitPanelGeometry(graph, panel, prefix);
    let panelImage = [`${prefix}load`, 0];
    if (panel.preserveOutsideRegion && panel.presentationCrop) {
      // Restore protected source pixels before reframing. The native mask is
      // not in the cropped/resized portrait's coordinate space.
      graph[`${prefix}protected_original`] = { class_type: 'ImageCrop', inputs: { image: ['source', 0], ...geometry } };
      graph[`${prefix}protected_resize`] = { class_type: 'ImageScale', inputs: { image: panelImage, upscale_method: 'lanczos', width: geometry.width, height: geometry.height, crop: 'disabled' } };
      const mask = addOutfitRegionMask(graph, panel, geometry.width, geometry.height, `${prefix}edit_`);
      graph[`${prefix}protected`] = { class_type: 'ImageCompositeMasked', inputs: { destination: [`${prefix}protected_original`, 0], source: [`${prefix}protected_resize`, 0], x: 0, y: 0, resize_source: false, mask } };
      panelImage = [`${prefix}protected`, 0];
    }
    const framed = panel.presentationCrop ? addNormalizedImageCrop(graph, panelImage, panel.presentationCrop, `${prefix}frame_`) : panelImage;
    graph[`${prefix}resize`] = { class_type: 'ImageScale', inputs: { image: framed, upscale_method: 'lanczos', width: geometry.width, height: geometry.height, crop: panel.presentationCrop ? 'center' : 'disabled' } };
    graph[`${prefix}composite`] = { class_type: 'ImageCompositeMasked', inputs: { destination, source: [`${prefix}resize`, 0], x: geometry.x, y: geometry.y, resize_source: false } };
    // A framed portrait is already hard-cropped above the chest; applying the
    // old full-panel mask after the crop would put the mask in the wrong space.
    if (panel.preserveOutsideRegion && !panel.presentationCrop) graph[`${prefix}composite`].inputs.mask = addOutfitRegionMask(graph, panel, geometry.width, geometry.height, `${prefix}edit_`);
    destination = [`${prefix}composite`, 0];
  }
  graph.save = { class_type: 'SaveImage', inputs: { images: destination, filename_prefix: 'image/H3_OutfitQuad' } };
  return graph;
}

export function buildImageHdWorkflow(options) {
  const guide = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  if (!guide) throw new Error('图片高清需要连接一张本地生成或导入的图片。');
  const multiplier = Number(options.imageScale || 1.5);
  const upscaleModel = options.upscaleModel || 'seedvr2_3b';
  if (!['seedvr2_3b', 'seedvr2_7b'].includes(upscaleModel)) throw new Error('未知的 SeedVR2 模型版本。');
  return {
    model: { class_type: 'UNETLoader', inputs: { unet_name: upscaleModel === 'seedvr2_7b' ? VERSIONED_IMAGE_MODELS.seedvr7b : IMAGE_MODEL.hdUnet, weight_dtype: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: IMAGE_MODEL.hdVae } },
    source: { class_type: 'LoadImage', inputs: { image: guide.name } },
    alpha: { class_type: 'JoinImageWithAlpha', inputs: { image: ['source', 0], alpha: ['source', 1] } },
    resize: { class_type: 'ResizeImageMaskNode', inputs: {
      input: ['alpha', 0], resize_type: 'scale by multiplier', 'resize_type.multiplier': multiplier, scale_method: 'lanczos',
    } },
    preprocess: { class_type: 'SeedVR2Preprocess', inputs: { resized_images: ['resize', 0] } },
    encode: { class_type: 'VAEEncodeTiled', inputs: { pixels: ['preprocess', 0], vae: ['vae', 0], tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 } },
    conditioning: { class_type: 'SeedVR2Conditioning', inputs: { model: ['model', 0], vae_conditioning: ['encode', 0] } },
    sample: { class_type: 'KSampler', inputs: {
      model: ['model', 0], seed: Number(options.seed), steps: 1, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
      positive: ['conditioning', 0], negative: ['conditioning', 1], latent_image: ['encode', 0], denoise: 1,
    } },
    decode: { class_type: 'VAEDecodeTiled', inputs: { samples: ['sample', 0], vae: ['vae', 0], tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 } },
    postprocess: { class_type: 'SeedVR2PostProcessing', inputs: { images: ['decode', 0], original_resized_images: ['resize', 0], color_correction_method: 'lab' } },
    save: { class_type: 'SaveImage', inputs: { images: ['postprocess', 0], filename_prefix: options.outputPrefix || 'image/H3_Image_HD' } },
  };
}

export const CHARACTER_SWAP_MODELS = {
  characterLora: 'h3_character_swap_v1.5.safetensors',
  turboLora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  samCheckpoint: 'sam3.1_multiplex_fp16.safetensors',
  clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
};

export function buildCharacterSwapPrompt(details = '', target = '') {
  const subject = target.trim() || 'the selected person';
  const appearance = details.trim();
  return `Replace only ${subject} with the character designated by the user in <Picture 1>, including face, hair, body shape and the visible outfit. Use the supplied reference as it is; do not assume a fixed panel count, panel order, layout, clothing or camera view. If it shows multiple views of the same person, treat them as complementary appearance references for one character, never as extra people or a storyboard. Follow the user's description of which person or view to use when provided. Transfer appearance only; do not copy the reference sheet layout, background or standing pose. Preserve the source video's exact subject placement, apparent head and body size, framing, camera distance, cropping, occlusion, movement, performance, scene, other people and original audio. Keep a close-up as a close-up; do not zoom out or invent off-screen limbs to fit a full-body reference.${appearance ? ` User instructions and reference details: ${appearance}` : ''}`;
}

export function buildCharacterSwapWorkflow(options) {
  const guide = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'video');
  const identity = options.references?.find((ref) => ref.slot === 'identity' && ref.kind === 'image');
  if (!guide || !identity) throw new Error('角色替换需要连接一段源视频和一张人物参考图；单人照片或同一人物的多视角设定图均可。');
  if (options.references.filter((ref) => ref.slot === 'identity' && ref.kind === 'image').length > 1) throw new Error('当前角色替换只支持一张人物参考图；请合并参考或只连接一张，避免其余图片被忽略。');
  const [width, height] = resolveDimensions(options.ratio, options.resolution);
  const length = durationToFrames(options.duration || 5);
  const prompt = buildCharacterSwapPrompt(options.prompt, options.targetDescription);
  const selection = options.targetSelection || (options.targetIndex ? 'index' : 'largest');
  const graph = {
    model: { class_type: 'UNETLoader', inputs: { unet_name: MODEL_INFO.referenceUnet, weight_dtype: 'default' } },
    shift: { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['model', 0], shift_video: 12, shift_audio: 3 } },
    attention: { class_type: 'ModelAttentionBackend', inputs: { model: ['shift', 0], attention: 'comfy kitchen attention' } },
    text: { class_type: 'CLIPLoader', inputs: { clip_name: CHARACTER_SWAP_MODELS.clip, type: 'minimax', device: 'default' } },
    text_device: { class_type: 'SelectCLIPDevice', inputs: { clip: ['text', 0], device: 'gpu:0' } },
    text_memory: { class_type: 'H3RelayTextMemory', inputs: { clip: ['text_device', 0] } },
    video_vae: { class_type: 'VAELoader', inputs: { vae_name: CHARACTER_SWAP_MODELS.videoVae } },
    audio_vae: { class_type: 'VAELoader', inputs: { vae_name: MODEL_INFO.audioVae } },
    turbo: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['attention', 0], lora_name: CHARACTER_SWAP_MODELS.turboLora, strength_model: 1 } },
    adapter: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['turbo', 0], lora_name: CHARACTER_SWAP_MODELS.characterLora, strength_model: 1 } },
    source: { class_type: 'LoadVideo', inputs: { file: guide.name } },
    components: { class_type: 'GetVideoComponents', inputs: { video: ['source', 0] } },
    scale: { class_type: 'ImageScale', inputs: { image: ['components', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' } },
    frames: { class_type: 'ImageFromBatch', inputs: { image: ['scale', 0], batch_index: 0, length } },
    source_audio: { class_type: 'TrimAudioDuration', inputs: { audio: ['components', 1], start_index: 0, duration: length / 24 } },
    dimensions: { class_type: 'GetImageSize', inputs: { image: ['frames', 0] } },
    reference: { class_type: 'LoadImage', inputs: { image: identity.name } },
    sam: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHARACTER_SWAP_MODELS.samCheckpoint } },
    subject: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam', 1], text: options.targetQuery || 'person' } },
    first_frame: { class_type: 'ImageFromBatch', inputs: { image: ['frames', 0], batch_index: 0, length: 1 } },
    detect: { class_type: 'SAM3_Detect', inputs: { model: ['sam', 0], image: ['first_frame', 0], conditioning: ['subject', 0], threshold: 0.35, refine_iterations: 2, individual_masks: true } },
    select: { class_type: 'H3RelaySelectMask', inputs: { masks: ['detect', 0], selection, index: Number(options.targetIndex || 0) } },
    track: { class_type: 'SAM3_VideoTrack', inputs: { model: ['sam', 0], images: ['frames', 0], initial_mask: ['select', 0], conditioning: ['subject', 0], detection_threshold: 0.5, max_objects: 1, detect_interval: 1 } },
    mask: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['track', 0], object_indices: '' } },
    recover: { class_type: 'H3RelayRecoverMasks', inputs: { masks: ['mask', 0], images: ['frames', 0], source_frames: length, model: ['sam', 0], conditioning: ['subject', 0], selection: ['select', 1], recover_empty_frames: true } },
    expand_mask: { class_type: 'H3RelayExpandMask', inputs: { masks: ['recover', 0], images: ['frames', 0], source_frames: length, expansion_px: 64 } },
    plan: { class_type: 'H3RelayWindowPlan', inputs: { source_frames: length, window_frames: '124', history_frames: '18', seed: Number(options.seed), schedule: 'adaptive', seed_mode: 'fixed', seed_overrides: '{}' } },
    start: { class_type: 'StartLoop', inputs: { mode: 'simple', 'mode.num_iterations': ['plan', 2], cache_iterations: false } },
    window: { class_type: 'H3RelayWindowInputs', inputs: { source: ['frames', 0], window: ['plan', 3], iteration_index: ['start', 0], previous: ['start', 4], reference_history: true, fps: 24, resize_anchor: true, history_audio_mode: 'source', source_audio: ['source_audio', 0], mask: ['expand_mask', 0] } },
    reference_conditioning: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
      clip: ['text_memory', 0], prompt, width: ['dimensions', 0], height: ['dimensions', 1], length: ['window', 8],
      ref_image_size: 'match', 'ref_videos.ref_video_0': ['window', 5], 'ref_images.ref_image_0': ['reference', 0],
      vae: ['video_vae', 0], audio_vae: ['audio_vae', 0], 'ref_audios.ref_audio_0': ['window', 6],
    } },
    history: { class_type: 'H3RelayApplyHistory', inputs: { positive: ['reference_conditioning', 0], latent: ['reference_conditioning', 1], vae: ['video_vae', 0], audio_vae: ['audio_vae', 0], frames: ['window', 3], history_frames: ['window', 7], first_frame_guide: false, target_audio_guide: true, audio: ['window', 4] } },
    encode_source: { class_type: 'VAEEncode', inputs: { pixels: ['window', 0], vae: ['video_vae', 0] } },
    edit_mask: { class_type: 'H3RelayApplyEditMask', inputs: { latent: ['history', 1], source_latent: ['encode_source', 0], mask: ['window', 1] } },
    guide: { class_type: 'MiniMaxH3AddGuide', inputs: { positive: ['history', 0], latent: ['edit_mask', 0], frame_idx: 0, audio_vae: ['audio_vae', 0], audio: ['window', 2] } },
    sampling_memory: { class_type: 'H3RelaySamplingMemory', inputs: { model: ['adapter', 0], latent: ['edit_mask', 0], conditioning: ['guide', 0], activation_memory_gib: 17 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: ['window', 10] } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['sampling_memory', 0], positive: ['guide', 0], negative: ['guide', 0], cfg: 1 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'er_sde' } },
    schedule: { class_type: 'BasicScheduler', inputs: { model: ['adapter', 0], scheduler: 'normal', steps: 8, denoise: 1 } },
    sample: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['schedule', 0], latent_image: ['edit_mask', 0] } },
    separate: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['separate', 0], vae: ['video_vae', 0] } },
    append: { class_type: 'H3RelayAppendWindow', inputs: { frames: ['decode', 0], window: ['window', 12], previous: ['start', 4] } },
    end: { class_type: 'EndLoop', inputs: { output_value: ['append', 0], next_iteration_value: ['append', 0], accumulate: false } },
    finish: { class_type: 'H3RelayFinishWindows', inputs: { state: ['end', 0], audio_mode: 'source', source_audio: ['source_audio', 0] } },
    video: { class_type: 'CreateVideo', inputs: { images: ['finish', 0], fps: ['finish', 2], audio: ['finish', 1] } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: 'video/H3_CharacterSwap', format: 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 16 } },
  };
  return graph;
}

export const HD_REFINE_MODEL = 'minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors';
export const HD_REFINE_TURBO = 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors';

export function buildHdRefinePrompt(details = '') {
  const extra = details.trim();
  return `Upscale and refine the source video at the target resolution. Preserve the exact person identity, facial features, hairstyle, body shape, complete outfit, motion, expression, scene, other people, camera, timing and original audio. Reconstruct natural fine details without redesigning the character, clothing, background or performance.${extra ? ` Additional requirements: ${extra}` : ''}`;
}

export function buildHdRefineWorkflow(options) {
  const guide = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'video');
  const identity = options.references?.find((ref) => ref.slot === 'identity' && ref.kind === 'image');
  if (!guide) throw new Error('高清二采需要连接一段已经生成的一采视频。');
  const [width, height] = resolveDimensions(options.ratio, options.resolution || '720P');
  const graph = {
    model: { class_type: 'UNETLoader', inputs: { unet_name: MODEL_INFO.referenceUnet, weight_dtype: 'default' } },
    shift: { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['model', 0], shift_video: 12, shift_audio: 3 } },
    turbo: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['shift', 0], lora_name: HD_REFINE_TURBO, strength_model: 1 } },
    adapter: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['turbo', 0], lora_name: CHARACTER_SWAP_MODELS.characterLora, strength_model: 1 } },
    text: { class_type: 'CLIPLoader', inputs: { clip_name: CHARACTER_SWAP_MODELS.clip, type: 'minimax', device: 'default' } },
    text_device: { class_type: 'SelectCLIPDevice', inputs: { clip: ['text', 0], device: 'gpu:0' } },
    text_memory: { class_type: 'H3RelayTextMemory', inputs: { clip: ['text_device', 0] } },
    video_vae: { class_type: 'VAELoader', inputs: { vae_name: CHARACTER_SWAP_MODELS.videoVae } },
    audio_vae: { class_type: 'VAELoader', inputs: { vae_name: MODEL_INFO.audioVae } },
    source: { class_type: 'LoadVideo', inputs: { file: guide.name } },
    components: { class_type: 'GetVideoComponents', inputs: { video: ['source', 0] } },
    probe: { class_type: 'GetImageSizeAndCount', inputs: { image: ['components', 0] } },
    scaled_reference: { class_type: 'ImageScale', inputs: { image: ['probe', 0], upscale_method: 'lanczos', width, height, crop: 'center' } },
    encode_video: { class_type: 'VAEEncode', inputs: { pixels: ['probe', 0], vae: ['video_vae', 0] } },
    encode_audio: { class_type: 'VAEEncodeAudio', inputs: { audio: ['components', 1], vae: ['audio_vae', 0] } },
    upscale: { class_type: 'MinimaxH3LatentUpscaler3D', inputs: {
      latent: ['encode_video', 0], model_name: HD_REFINE_MODEL, mode: 'target dimensions', 'mode.width': width, 'mode.height': height,
      align: 32, enable_temporal_chunking: true, force_unload: true, device: 'cuda', precision: 'fp16',
    } },
    highres_latent: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['upscale', 0], audio_latent: ['encode_audio', 0] } },
    conditioning: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
      clip: ['text_memory', 0], prompt: buildHdRefinePrompt(options.prompt), width, height, length: ['probe', 3],
      ref_image_size: 'match', 'ref_videos.ref_video_0': ['scaled_reference', 0],
      vae: ['video_vae', 0], audio_vae: ['audio_vae', 0], 'ref_audios.ref_audio_0': ['components', 1],
    } },
    sampling_memory: { class_type: 'H3RelaySamplingMemory', inputs: { model: ['adapter', 0], latent: ['highres_latent', 0], conditioning: ['conditioning', 0], activation_memory_gib: 17 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: Number(options.seed) } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['sampling_memory', 0], positive: ['conditioning', 0], negative: ['conditioning', 0], cfg: 1 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    schedule: { class_type: 'BasicScheduler', inputs: { model: ['adapter', 0], scheduler: 'beta', steps: 3, denoise: 0.2 } },
    sample: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['schedule', 0], latent_image: ['highres_latent', 0] } },
    separate: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['separate', 0], vae: ['video_vae', 0] } },
    video: { class_type: 'CreateVideo', inputs: { images: ['decode', 0], fps: ['components', 2], audio: ['components', 1] } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: 'video/H3_HD_Refine', format: 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 16 } },
  };
  if (options.fastAttention !== false) graph.attention = { class_type: 'MiniMaxH3MemoryEfficientSageAttentionPatch', inputs: { model: ['shift', 0] } };
  if (graph.attention) graph.turbo.inputs.model = ['attention', 0];
  if (identity) {
    graph.identity = { class_type: 'LoadImage', inputs: { image: identity.name } };
    graph.conditioning.inputs['ref_images.ref_image_0'] = ['identity', 0];
  }
  return graph;
}

async function parseResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) {
    const detail = data?.node_errors ? `\n${JSON.stringify(data.node_errors)}` : '';
    throw new Error(`${data?.error?.message || data?.error || `请求失败 (${response.status})`}${detail}`);
  }
  return data;
}

export async function comfyFetch(path, options = {}) {
  const response = await fetch(`${COMFY_ORIGIN}${path}`, options);
  return parseResponse(response);
}

export function getSystemStats() {
  return comfyFetch('/system_stats');
}

export async function freeComfyMemory() {
  const queue = await comfyFetch('/queue');
  if (queue.queue_running?.length || queue.queue_pending?.length) {
    throw new Error('当前有正在运行或排队的任务，请等完成后再清理显存。');
  }
  await comfyFetch('/free', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
  return getSystemStats();
}

export async function getMossDependencyStatus() {
  const requirements = [
    ['UNETLoader', 'unet_name', MOSS_IMAGE_MODEL.unet, 'MOSS 主模型'],
    ['CLIPLoader', 'clip_name', MOSS_IMAGE_MODEL.clip, 'Qwen3.5 文本编码器'],
    ['VAELoader', 'vae_name', MOSS_IMAGE_MODEL.vae, 'Flux2 VAE'],
  ];
  const checks = requirements.map(async ([node, input, filename, label]) => {
    const response = await fetch(`${COMFY_ORIGIN}/object_info/${node}`);
    if (!response.ok) return label;
    const info = await response.json();
    return info?.[node]?.input?.required?.[input]?.[0]?.includes(filename) ? null : label;
  });
  checks.push((async () => {
    const response = await fetch(`${COMFY_ORIGIN}/object_info/SpectrumMOSSImageAdaptive`);
    return response.ok ? null : 'Spectrum MOSS 加速节点';
  })());
  const missing = (await Promise.all(checks)).filter(Boolean);
  return { ready: missing.length === 0, missing };
}

export async function getHardwareMetrics() {
  const response = await fetch('/api/hardware-metrics');
  return parseResponse(response);
}

export async function uploadMedia(file, kind = 'image') {
  const form = new FormData();
  form.append('image', file, file.name);
  form.append('type', 'input');
  form.append('subfolder', 'workbench');
  form.append('overwrite', 'true');
  const result = await comfyFetch('/upload/image', { method: 'POST', body: form });
  if (!result?.name) throw new Error(`${kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}上传失败，请重试。`);
  return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

export async function importVideoFromUrl(url) {
  const response = await fetch('/api/import-video', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return parseResponse(response);
}

export async function optimizePrompt(options) {
  const response = await fetch('/api/optimize-prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return parseResponse(response);
}

export async function openFileLocation(options) {
  const response = await fetch('/api/open-file-location', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return parseResponse(response);
}

export function uploadImage(file) {
  return uploadMedia(file, 'image');
}

export function queuePrompt(workflow, clientId) {
  return comfyFetch('/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
}

export async function enqueueGeneration({ workflow, plan, projectId, nodeId, clientId, priority = 0 }) {
  const response = await fetch('/api/queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow, plan, projectId, nodeId, clientId, priority }),
  });
  return parseResponse(response);
}

export async function getQueueSnapshot() {
  const response = await fetch('/api/queue');
  return parseResponse(response);
}

export async function cancelGenerationJob(jobId) {
  const response = await fetch(`/api/queue/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  return parseResponse(response);
}

export async function cancelGeneration(node) {
  if (node?.queueJobId) return cancelGenerationJob(node.queueJobId);
  if (node?.promptId) return cancelPrompt(node.promptId);
  // Upload/submit flight has no remote target yet. The caller invalidates its
  // local attempt; a global interrupt here could cancel somebody else's GPU job.
  return { cancelled: 'local' };
}

const QUEUE_EVENTS = ['job.queued', 'job.started', 'job.submitted', 'job.progress', 'job.running', 'job.finishing', 'job.done', 'job.error', 'job.cancelled', 'job.retry', 'job.priority', 'queue.cleared'];
export function openQueueEvents(handlers = {}) {
  let source;
  const connect = () => {
    source?.close();
    source = new EventSource('/api/queue/events');
    source.addEventListener('queue.snapshot', (event) => handlers.onSnapshot?.(JSON.parse(event.data)));
    for (const type of QUEUE_EVENTS) {
      source.addEventListener(type, (event) => {
        const payload = JSON.parse(event.data);
        handlers.onJobEvent?.(payload.job, type);
      });
    }
    source.onerror = () => handlers.onError?.(new Error('队列事件连接暂时中断，浏览器会自动重连。'));
  };
  connect();
  window.addEventListener(LOCAL_RECONNECTED, connect);
  return { close() { window.removeEventListener(LOCAL_RECONNECTED, connect); source.close(); } };
}

export async function cancelPrompt(promptId) {
  await comfyFetch('/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (promptId) {
    await comfyFetch('/queue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }
}

export function getHistory(maxItems = 60) {
  return comfyFetch(`/history?max_items=${maxItems}`);
}

export function viewUrl(file) {
  const query = new URLSearchParams({
    filename: file.filename || '', subfolder: file.subfolder || '', type: file.type || 'output',
  });
  return `${COMFY_ORIGIN}/view?${query}`;
}

function extractMedia(historyEntry, kind) {
  const files = [];
  const extensions = kind === 'image' ? /\.(png|jpe?g|webp)$/i : /\.(mp4|webm|mov|mkv)$/i;
  for (const output of Object.values(historyEntry?.outputs || {})) {
    for (const value of Object.values(output || {})) {
      if (!Array.isArray(value)) continue;
      for (const file of value) {
        if (file && typeof file === 'object' && 'filename' in file && 'subfolder' in file && 'type' in file && extensions.test(file.filename)) {
          files.push({ ...file, url: viewUrl(file) });
        }
      }
    }
  }
  return files;
}

export function extractVideos(historyEntry) {
  return extractMedia(historyEntry, 'video');
}

export function extractImages(historyEntry) {
  return extractMedia(historyEntry, 'image').filter((file) => /^H3_(?:Image(?:_HD)?|MOSS_Image|Flux3Klein(?:_Edit)?|IdentityV2|Qwen21Edit|CharacterSheet|LocalRealism|OutfitQuad|OutfitSingle|OutfitHD)/i.test(file.filename));
}

async function waitForOutfitPrompt(promptId) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const history = await comfyFetch(`/history/${promptId}`);
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error('单图生成或高清被中断、发生错误。');
    if (entry.status?.completed) return entry;
  }
}

function outfitUpscalePolicy(options) {
  const policy = options.outfitUpscale || 'auto';
  if (!['auto', 'off', 'seedvr2_7b'].includes(policy)) throw new Error('未知的换装高清策略。');
  return policy;
}

export function shouldUpscaleOutfitImage(width, height, policy = 'auto') {
  const longEdge = Math.max(Number(width), Number(height));
  if (!Number.isFinite(longEdge) || longEdge <= 0) throw new Error('无法读取换装单图尺寸，已停止而不是猜测是否高清。');
  if (!['auto', 'off', 'seedvr2_7b'].includes(policy)) throw new Error('未知的换装高清策略。');
  if (policy === 'off') return false;
  if (policy === 'seedvr2_7b') return true;
  return longEdge < 1000;
}

function buildOutfitPanelHdWorkflow(options, panel, inputName, panelIndex) {
  const upscalePolicy = outfitUpscalePolicy(options);
  const graph = buildImageHdWorkflow({
    references: [{ kind: 'image', slot: 'guide', name: inputName }],
    upscaleModel: upscalePolicy === 'seedvr2_7b' ? 'seedvr2_7b' : 'seedvr2_3b',
    imageScale: Number(options.outfitHdScale || 1.5),
    seed: Number(options.seed) + panelIndex,
    outputPrefix: `image/H3_OutfitHD_${panel.id}`,
  });
  if (panel.preserveOutsideRegion) {
    const source = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
    graph.original_source = { class_type: 'LoadImage', inputs: { image: source.name } };
    let geometry;
    if ((options.outfitLayout || 'legacy') === 'legacy') {
      // Legacy panel bounds are pixels on the normalized 768×1344 sheet,
      // then scaled to the same single-panel size used by the edit stage.
      graph.original_sheet = { class_type: 'ImageScale', inputs: { image: ['original_source', 0], upscale_method: 'lanczos', width: 768, height: 1344, crop: 'disabled' } };
      graph.original_panel_crop = { class_type: 'ImageCrop', inputs: { image: ['original_sheet', 0], x: panel.x, y: panel.y, width: panel.width, height: panel.height } };
      graph.original_crop = { class_type: 'ImageScale', inputs: { image: ['original_panel_crop', 0], upscale_method: 'lanczos', width: panel.outputWidth, height: panel.outputHeight, crop: 'disabled' } };
      geometry = { width: panel.outputWidth, height: panel.outputHeight };
    } else {
      graph.size = { class_type: 'GetImageSize', inputs: { image: ['original_source', 0] } };
      geometry = addOutfitPanelGeometry(graph, panel, 'original_panel_');
      graph.original_crop = { class_type: 'ImageCrop', inputs: { image: ['original_source', 0], ...geometry } };
    }
    const mask = addOutfitRegionMask(graph, panel, geometry.width, geometry.height);
    graph.edit_hd_resize = { class_type: 'ImageScale', inputs: { image: ['postprocess', 0], upscale_method: 'lanczos', width: geometry.width, height: geometry.height, crop: 'disabled' } };
    graph.edit_hd_output = { class_type: 'ImageCompositeMasked', inputs: { destination: ['original_crop', 0], source: ['edit_hd_resize', 0], x: 0, y: 0, resize_source: false, mask } };
    graph.save.inputs.images = ['edit_hd_output', 0];
  }
  return graph;
}

export function buildOutfitQueuePlan(options) {
  const upscalePolicy = outfitUpscalePolicy(options);
  const selectedPanel = options.outfitPanel || options.panelId || null;
  const availablePanels = resolveOutfitPanels(options);
  const panels = selectedPanel ? availablePanels.filter((panel) => panel.id === selectedPanel) : availablePanels;
  if (!panels.length) throw new Error('未知的换装视图。');
  const panelImages = {};
  const planPanels = panels.map((panel) => {
    const panelIndex = availablePanels.findIndex((item) => item.id === panel.id);
    panelImages[panel.id] = `__H3_OUTFIT_PANEL_${panel.id}__`;
    return {
      id: panel.id, label: panel.label, preserve: Boolean(panel.preserve),
      single: buildOutfitQuadWorkflow({ ...options, outfitPanel: panel.id }),
      hd: upscalePolicy === 'off' ? null : buildOutfitPanelHdWorkflow(options, panel, '__H3_OUTFIT_CURRENT__', panelIndex),
    };
  });
  return {
    kind: 'outfit', upscalePolicy, selectedPanel, panels: planPanels,
    stitch: selectedPanel ? null : buildOutfitStitchWorkflow(panelImages, options),
  };
}

export async function runOutfitQuadWorkflow(options, clientId, onProgress = () => {}) {
  const upscalePolicy = outfitUpscalePolicy(options);
  const hdImages = {};
  const selectedPanel = options.outfitPanel || options.panelId;
  const availablePanels = resolveOutfitPanels(options);
  const panels = selectedPanel ? availablePanels.filter((panel) => panel.id === selectedPanel) : availablePanels;
  if (!panels.length) throw new Error('未知的换装视图。');
  const uploadResult = async (image, label) => {
    if (!image) throw new Error(`${label}已结束，但没有找到输出图片。`);
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`无法读取${label}。`);
    const blob = await response.blob();
    let width = Number(image.metadata?.width);
    let height = Number(image.metadata?.height);
    if ((!width || !height) && typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    }
    const name = await uploadMedia(new File([blob], image.filename, { type: 'image/png' }), 'image');
    return { name, width, height };
  };
  for (const [index, panel] of panels.entries()) {
    const panelIndex = availablePanels.findIndex((item) => item.id === panel.id);
    const baseProgress = index * 90 / panels.length;
    onProgress({ status: 'running', stage: `${panel.preserve ? '保留原图' : options.outfitModel === 'muse_v4' ? 'Muse V4 独立换装' : '千问独立换装'} ${index + 1}/${panels.length} · ${panel.label}`, progress: baseProgress });
    const singleQueued = await queuePrompt(buildOutfitQuadWorkflow({ ...options, outfitPanel: panel.id }), clientId);
    const singleHistory = await waitForOutfitPrompt(singleQueued.prompt_id);
    const single = await uploadResult(extractImages(singleHistory).find((file) => file.filename.startsWith(`H3_OutfitSingle_${panel.id}_`)), `${panel.label}单图`);
    await freeComfyMemory();

    if (!shouldUpscaleOutfitImage(single.width, single.height, upscalePolicy)) {
      hdImages[panel.id] = single.name;
      onProgress({ status: 'running', stage: `原生 ${single.width} × ${single.height} · 无需高清 ${index + 1}/${panels.length} · ${panel.label}`, progress: (index + 1) * 90 / panels.length });
      if (selectedPanel) return { prompt_id: singleQueued.prompt_id, history: singleHistory };
      continue;
    }

    onProgress({ status: 'running', stage: `${upscalePolicy === 'seedvr2_7b' ? 'SeedVR2 7B' : '低于 1K'} · 独立高清 ${index + 1}/${panels.length} · ${panel.label}`, progress: baseProgress + 45 / panels.length });
    const hdQueued = await queuePrompt(buildOutfitPanelHdWorkflow(options, panel, single.name, panelIndex), clientId);
    const hdHistory = await waitForOutfitPrompt(hdQueued.prompt_id);
    const hdFile = extractImages(hdHistory).find((file) => file.filename.startsWith(`H3_OutfitHD_${panel.id}_`));
    const hd = await uploadResult(hdFile, `${panel.label}高清图`);
    hdImages[panel.id] = hd.name;
    onProgress({ status: 'running', stage: `高清完成 ${index + 1}/${panels.length} · ${panel.label}`, progress: (index + 1) * 90 / panels.length });
    await freeComfyMemory();
    if (selectedPanel) return { prompt_id: hdQueued.prompt_id, history: hdHistory };
  }
  onProgress({ status: 'finishing', stage: `四张单图已就绪 · 正在按${(options.outfitLayout || 'legacy') === 'legacy' ? '旧版四宫格' : '母图原版面'}合成`, progress: 94 });
  const stitched = await queuePrompt(buildOutfitStitchWorkflow(hdImages, options), clientId);
  const history = await waitForOutfitPrompt(stitched.prompt_id);
  return { prompt_id: stitched.prompt_id, history };
}

export function openProgressSocket(clientId, handlers = {}) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/api/comfy/ws?clientId=${encodeURIComponent(clientId)}`);
  socket.onopen = () => handlers.onOpen?.();
  socket.onerror = () => handlers.onError?.(new Error('无法连接 ComfyUI 进度服务'));
  socket.onclose = () => handlers.onClose?.();
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const message = JSON.parse(event.data);
      handlers.onMessage?.(message);
      if (message.type === 'progress') handlers.onProgress?.(message.data);
      if (message.type === 'executing') handlers.onExecuting?.(message.data);
      if (message.type === 'execution_error') handlers.onExecutionError?.(message.data);
      if (message.type === 'execution_interrupted') handlers.onInterrupted?.(message.data);
    } catch { /* Ignore non-JSON socket messages. */ }
  };
  return socket;
}
