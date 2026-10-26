export const COMFY_ORIGIN = `http://${window.location.hostname || '127.0.0.1'}:8188`;
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

export function buildImageWorkflow(options) {
  const [width, height] = resolveImageDimensions(options.ratio);
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
    save: { class_type: 'SaveImage', inputs: { images: ['postprocess', 0], filename_prefix: 'image/H3_Image_HD' } },
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
  return extractMedia(historyEntry, 'image').filter((file) => /^H3_Image(?:_HD)?_\d+_/i.test(file.filename));
}

export function openProgressSocket(clientId, handlers = {}) {
  const socket = new WebSocket(`ws://${window.location.hostname || '127.0.0.1'}:8188/ws?clientId=${encodeURIComponent(clientId)}`);
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
