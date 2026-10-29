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

export function resolveImageDimensions(ratio = '16:9') {
  return IMAGE_RATIOS[ratio] || IMAGE_RATIOS['16:9'];
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

// Qwen Image 2.1 native editing: its encoder supplies the reference-matched latent.
export function buildQwen21EditWorkflow(options) {
  const source = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  const makeup = options.references?.find((ref) => ref.slot === 'identity' && ref.kind === 'image');
  if (!source) throw new Error('Qwen 2.1 图生图需要连接一张人物或场景母图。');
  const prompt = options.prompt?.trim();
  if (!prompt) throw new Error('请先输入要保留和要修改的画面内容。');
  const instruction = prompt.includes('<image1>') ? prompt : `Edit <image1>: ${prompt}`;
  const useRealism = options.imageLora === 'qwen21Realism';
  return {
    model: { class_type: 'UNETLoader', inputs: { unet_name: QWEN21_EDIT_MODEL.unet, weight_dtype: 'default' } },
    ...(useRealism ? { realism: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: QWEN21_EDIT_MODEL.realismLora, strength_model: Number(options.loraStrength ?? 0.6) } } } : {}),
    text: { class_type: 'CLIPLoader', inputs: { clip_name: QWEN21_EDIT_MODEL.clip, type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: QWEN21_EDIT_MODEL.vae } },
    source: { class_type: 'LoadImage', inputs: { image: source.name } },
    ...(makeup ? { makeup: { class_type: 'LoadImage', inputs: { image: makeup.name } } } : {}),
    encode: { class_type: 'TextEncodeQwenImage21', inputs: {
      clip: ['text', 0], prompt: instruction, negative_prompt: '', resolution: Number(options.qwenRefResolution || 1024),
      'images.image_1': ['source', 0], ...(makeup ? { 'images.image_2': ['makeup', 0] } : {}), vae: ['vae', 0],
    } },
    sample: { class_type: 'KSampler', inputs: {
      model: [useRealism ? 'realism' : 'model', 0], seed: Number(options.seed), steps: Number(options.qwenSteps || 40), cfg: 1,
      sampler_name: 'euler', scheduler: 'simple', positive: ['encode', 0], negative: ['encode', 1], latent_image: ['encode', 2], denoise: 1,
    } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'image/H3_Qwen21Edit' } },
  };
}

export const LOCAL_REALISM_PROMPT = 'Edit <image1>: enhance only the selected skin with subtle natural photographic microtexture, realistic fine pores and softly varied skin tones. Keep the original person, identity, facial features, makeup colors, expression, lighting, hair and all unselected pixels unchanged. Avoid beauty filtering, waxy skin, airbrushing, contour changes and age changes.';

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
    return {
      ...outfitLayoutPanel(id, role, view, bounds.x, bounds.y, bounds.width, bounds.height, Boolean(panel?.headless)),
      label: typeof panel?.label === 'string' && panel.label.trim() ? panel.label.trim() : `${OUTFIT_VIEWS[view].label}${role === 'portrait' ? '近景' : '全身'}`,
    };
  });
}

export function resolveOutfitPanels(options = {}) {
  const layout = options.outfitLayout || 'legacy';
  if (layout === 'legacy') return OUTFIT_PANELS;
  if (layout === 'custom') return normalizeCustomOutfitPanels(options.outfitPanels);
  if (!OUTFIT_LAYOUTS[layout]) throw new Error('未知的母图版面。');
  return OUTFIT_LAYOUTS[layout].map((panel) => ({ ...panel }));
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

function buildGenericOutfitPrompt(panel, outfit, hasOutfitReference = false) {
  const view = OUTFIT_VIEWS[panel.view].prompt;
  const referenceInstruction = hasOutfitReference ? ' <image2> is ONLY a garment reference: reproduce its visible garment colors, neckline, fabric, details and footwear where applicable; ignore its person, skin, face, body shape, pose, camera and background.' : '';
  if (panel.role === 'portrait') {
    return `Edit <image1> only: this is one exact ${view} CLOSE-UP PORTRAIT, not a half-body or outfit view. Image1 is authoritative for identity, camera, framing, head size and position, hair boundaries, pose and proportions. Preserve the exact original crop: the bottom edge must cut through the upper chest at exactly the same place as image1. Change only the visible upper-chest garment fabric and straps to ${outfit}; ignore every garment in the clothing reference that is outside this crop.${referenceInstruction} Preserve the exact face, facial landmark locations, expression, makeup, original hairstyle, accessories and background. The garment hem, waist, abdomen, hips, shorts, skirt and hands are outside the frame and must never appear. Do not zoom out, do not reveal more torso, do not expand the bust or shoulders. Remove only the visible original garment fabric. Same single view only, no collage, text, logos, extra people or duplicated limbs.`;
  }
  const cropInstruction = panel.headless
    ? `Preserve this exact neck-down ${view.toUpperCase()} body composition. The head is outside the image: no head, face, skull, scalp, ears, eyes, portrait or small face anywhere. Hair that was already hanging from above the frame must remain long and natural; do not create a head or hair bun at the top edge.`
    : `Preserve the exact original ${view} full-body crop, head visibility, face, identity, head size and position; do not add or remove a head.`;
  return `Edit <image1> only. Image1 is the authoritative character, camera, framing, pose and proportions.${referenceInstruction} Change only the garments and footwear to ${outfit}. ${cropInstruction} Keep the original pose, shoulder width, waist circumference and height, torso length, hip width, long leg length and body silhouette in exactly the source positions. Never zoom out or extend the canvas. Keep the original hairstyle and hair length, skin tone, smooth skin texture, soft tonal transitions, knee shape and shading, calf contours and background. Do not enhance or invent musculature, tendons, veins, knee dimples or high-contrast anatomical shadows. Garments must follow the existing body without widening or slimming it. Both feet must remain naturally planted in their original positions with the original heel contact; do not raise the heels. Do not transfer the reference person body shape or shorten the legs. Remove the original garments completely with no leftover clothing. Same single view only, no collage, text, logos, extra people or duplicated limbs.`;
}

// Qwen edits every selected panel at its native aspect ratio. SeedVR2 runs in
// a separate prompt for every view, never on the combined character sheet.
export function buildOutfitQuadWorkflow(options) {
  const source = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  const outfitReference = options.references?.find((ref) => ref.slot === 'identity' && ref.kind === 'image');
  if (!source) throw new Error('无抠图换装需要连接一张原始四视图。');
  const outfit = options.prompt?.trim();
  if (!outfit) throw new Error('请先选择或输入一套穿搭。');
  const layout = options.outfitLayout || 'legacy';
  const panel = resolveOutfitPanels(options).find((item) => item.id === (options.outfitPanel || options.panelId));
  if (!panel) throw new Error('未知的换装视图。');
  const graph = {
    source: { class_type: 'LoadImage', inputs: { image: source.name } },
  };
  if (layout !== 'legacy') {
    if (outfitReference) graph.outfit_reference = { class_type: 'LoadImage', inputs: { image: outfitReference.name } };
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
  const prompt = layout !== 'legacy' ? buildGenericOutfitPrompt(panel, outfit, Boolean(outfitReference)) : realizePortrait
    ? 'Edit <image1>: subtly convert this exact front-facing portrait toward realistic photography without redesigning the person. The original facial geometry is immutable: keep exactly the same eye width, eye height, eye spacing, eyebrow shape, nose width and length, lip width and fullness, cheek width, jawline, chin length, face contour and all facial proportions. Do not make the eyes smaller, face narrower, nose thinner or lips smaller. Preserve the original natural makeup colors, blush, eyeliner, lip color and expression. Preserve the long black half-up hairstyle, purple butterfly accessory, forehead ornament, necklace, clothing, pose, tight crop and gray background. Add only subtle photographic eye detail, individual hair strands and authentic skin microtexture with visible pores and fine facial hair. No beauty filter, no skin smoothing, no airbrushed or waxy skin, no face lifting, no contour reshaping, no makeup removal, no aging. Photorealistic studio portrait photography, no text.'
    : panel.id === 'bl'
      ? `Edit <image1>: this is the exact full-body back view. Preserve the source geometry, pose, narrow waist, waist height, torso length, hip width, long slim legs, gray background and very long black hairstyle. Change only the clothing and footwear to ${outfit}. The source bare midriff defines a very narrow waist: even when the new clothing covers it, keep exactly the same narrow waist circumference, silhouette and height. Garments must follow the body closely at the waist; no loose or padded waist, no straight-column cut, no added folds that widen the waist. Do not add a head or face, do not extend or reframe the canvas, do not redesign the body. Remove the original camisole and denim shorts completely. Photorealistic studio photography, no text.`
      : `Edit <image1>: this is the exact neck-down full-body front view. Preserve the source geometry, neck-down crop, pose, narrow waist, waist height, torso length, shoulder and hip width, long slim legs and gray background. Change only the clothing and footwear to ${outfit}. The source bare midriff defines a very narrow waist: even when the new clothing covers it, keep exactly the same narrow waist circumference, silhouette and height. Garments must follow the body closely at the waist; no loose or padded waist, no straight-column cut, no added folds that widen the waist. Do not add a head or face, do not extend or reframe the canvas, do not redesign the body. Remove the original camisole and denim shorts completely. Photorealistic studio photography, no text.`;
  graph.model = { class_type: 'UNETLoader', inputs: { unet_name: QWEN21_EDIT_MODEL.unet, weight_dtype: 'default' } };
  if (useRealism) graph.realism = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: QWEN21_EDIT_MODEL.realismLora, strength_model: Number(options.loraStrength ?? 0.6) } };
  graph.text = { class_type: 'CLIPLoader', inputs: { clip_name: QWEN21_EDIT_MODEL.clip, type: 'qwen_image', device: 'default' } };
  graph.vae = { class_type: 'VAELoader', inputs: { vae_name: QWEN21_EDIT_MODEL.vae } };
  graph.encode = { class_type: 'TextEncodeQwenImage21', inputs: {
    clip: ['text', 0], prompt, negative_prompt: '',
    resolution: Number(options.qwenRefResolution || (layout === 'legacy' ? 1024 : 1536)),
    'images.image_1': [inputNode, 0],
    ...(layout !== 'legacy' && outfitReference ? { 'images.image_2': ['outfit_reference', 0] } : {}),
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
  graph.decode = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } };
  graph.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: `image/H3_OutfitSingle_${panel.id}` } };
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
    graph[`${prefix}resize`] = { class_type: 'ImageScale', inputs: { image: [`${prefix}load`, 0], upscale_method: 'lanczos', width: geometry.width, height: geometry.height, crop: 'disabled' } };
    graph[`${prefix}composite`] = { class_type: 'ImageCompositeMasked', inputs: { destination, source: [`${prefix}resize`, 0], x: geometry.x, y: geometry.y, resize_source: false } };
    destination = [`${prefix}composite`, 0];
  }
  graph.save = { class_type: 'SaveImage', inputs: { images: destination, filename_prefix: 'image/H3_OutfitQuad' } };
  return graph;
}

export function buildImageHdWorkflow(options) {
  const guide = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'image');
  if (!guide) throw new Error('图片高清需要连接一张本地生成或导入的图片。');
  const multiplier = Number(options.imageScale || 1.5);
  return {
    model: { class_type: 'UNETLoader', inputs: { unet_name: IMAGE_MODEL.hdUnet, weight_dtype: 'default' } },
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
  return `Replace only ${subject} with the complete reference character, including face, hair, body shape and the exact visible outfit. Preserve the source performance, scene, other people, camera and original audio.${appearance ? ` Reference details: ${appearance}` : ''}`;
}

export function buildCharacterSwapWorkflow(options) {
  const guide = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'video');
  const identity = options.references?.find((ref) => ref.slot === 'identity' && ref.kind === 'image');
  if (!guide || !identity) throw new Error('角色替换需要连接一段源视频和一张包含全身与穿搭的单人参考图。');
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
  const source = new EventSource('/api/queue/events');
  const onSnapshot = (event) => handlers.onSnapshot?.(JSON.parse(event.data));
  source.addEventListener('queue.snapshot', onSnapshot);
  for (const type of QUEUE_EVENTS) {
    source.addEventListener(type, (event) => {
      const payload = JSON.parse(event.data);
      handlers.onJobEvent?.(payload.job, type);
    });
  }
  source.onerror = () => handlers.onError?.(new Error('队列事件连接暂时中断，浏览器会自动重连。'));
  return source;
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
  return extractMedia(historyEntry, 'image').filter((file) => /^H3_(?:Image(?:_HD)?|MOSS_Image|IdentityV2|Qwen21Edit|LocalRealism|OutfitQuad|OutfitSingle|OutfitHD)/i.test(file.filename));
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

export function shouldUpscaleOutfitImage(width, height) {
  const longEdge = Math.max(Number(width), Number(height));
  if (!Number.isFinite(longEdge) || longEdge <= 0) throw new Error('无法读取换装单图尺寸，已停止而不是猜测是否高清。');
  return longEdge < 1000;
}

export function buildOutfitQueuePlan(options) {
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
      hd: buildImageHdWorkflow({
        references: [{ kind: 'image', slot: 'guide', name: '__H3_OUTFIT_CURRENT__' }],
        imageScale: Number(options.outfitHdScale || 1.5),
        seed: Number(options.seed) + panelIndex,
        outputPrefix: `image/H3_OutfitHD_${panel.id}`,
      }),
    };
  });
  return {
    kind: 'outfit', selectedPanel, panels: planPanels,
    stitch: selectedPanel ? null : buildOutfitStitchWorkflow(panelImages, options),
  };
}

export async function runOutfitQuadWorkflow(options, clientId, onProgress = () => {}) {
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
    onProgress({ status: 'running', stage: `${panel.preserve ? '保留原图' : '千问独立换装'} ${index + 1}/${panels.length} · ${panel.label}`, progress: baseProgress });
    const singleQueued = await queuePrompt(buildOutfitQuadWorkflow({ ...options, outfitPanel: panel.id }), clientId);
    const singleHistory = await waitForOutfitPrompt(singleQueued.prompt_id);
    const single = await uploadResult(extractImages(singleHistory).find((file) => file.filename.startsWith(`H3_OutfitSingle_${panel.id}_`)), `${panel.label}单图`);
    await freeComfyMemory();

    if (!shouldUpscaleOutfitImage(single.width, single.height)) {
      hdImages[panel.id] = single.name;
      onProgress({ status: 'running', stage: `原生 ${single.width} × ${single.height} · 无需高清 ${index + 1}/${panels.length} · ${panel.label}`, progress: (index + 1) * 90 / panels.length });
      if (selectedPanel) return { prompt_id: singleQueued.prompt_id, history: singleHistory };
      continue;
    }

    onProgress({ status: 'running', stage: `低于 1K · 独立高清 ${index + 1}/${panels.length} · ${panel.label}`, progress: baseProgress + 45 / panels.length });
    const hdQueued = await queuePrompt(buildImageHdWorkflow({
      references: [{ kind: 'image', slot: 'guide', name: single.name }],
      imageScale: Number(options.outfitHdScale || 1.5),
      seed: Number(options.seed) + panelIndex,
      outputPrefix: `image/H3_OutfitHD_${panel.id}`,
    }), clientId);
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
