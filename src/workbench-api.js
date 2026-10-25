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

export const CHARACTER_SWAP_MODELS = {
  characterLora: 'minimax_h3_character_swap_v1.1_ref2va_fro.safetensors',
  dmdLora: 'minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors',
  samCheckpoint: 'sam3.1_multiplex_fp16.safetensors',
};

export const CHARACTER_SWAP_APPEARANCE_LOCK = 'This is a full-character replacement, not a face swap or head swap. <Picture 1> is the sole authority for the character appearance. Copy the entire person as one indivisible identity: exact facial structure, facial features, skin tone, hairstyle, hair length and color, body shape, body proportions, and every visible clothing item and accessory. Preserve the exact garment types, neckline, straps, sleeves, fit, fabric, colors, patterns, layering, garment length, waist styling, lower-body clothing and footwear. Never copy the guide subject body or clothing. Do not beautify, redesign, complete, extend or replace the outfit; do not turn a top into a dress, add a skirt, or invent a new fashion style. Only the pose, gestures and performance change to follow the guide video.';

export function buildCharacterSwapPrompt(details = '', target = '') {
  const appearance = details.trim() || 'person with the exact same visible identity, facial structure, facial features, skin tone, hairstyle, hair color, body shape, body proportions, clothing and accessories';
  const guideSubject = target.trim() || 'the main subject';
  return `body_swap: subject_definitions: <Subject 1> is the ${appearance} shown in <Picture 1>, whose identity, face, head, hair or fur, skin, body shape, proportions and clothing define the character in the target video. The guide video provides the scene and the performance only: its background, environment, lighting, camera, framing, body pose, hand and arm movement, head rotation, gaze direction, lip movement and facial expression, frame by frame; only ${guideSubject} of the guide video is replaced: its complete face, hair, body and clothing become <Subject 1>.  summary: [video generation + reference] Replace ${guideSubject} with the complete person from <Picture 1>, not only the face, keeping the scene, camera and complete motion and performance of the guide video.  detailed_description: [Shot 1] <Subject 1> takes the exact place of ${guideSubject} and moves with the same timing, body pose, gestures, head motion, gaze, speech and facial expressions, while keeping the complete identity from <Picture 1>: facial structure, hair or fur, skin, body shape, body proportions and all clothing stay stable and unchanged in every frame. The background, lighting, colors and camera of the guide video are preserved. Prevent identity drift, body-shape changes, clothing changes, texture crawling and flicker. ${CHARACTER_SWAP_APPEARANCE_LOCK}`;
}

function ensureCharacterSwapAppearanceLock(prompt) {
  const clean = prompt.trim();
  return clean.includes('This is a full-character replacement, not a face swap or head swap.') ? clean : `${clean} ${CHARACTER_SWAP_APPEARANCE_LOCK}`;
}

export function buildCharacterSwapWorkflow(options) {
  const guide = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'video');
  const identity = options.references?.find((ref) => ref.slot === 'identity' && ref.kind === 'image');
  if (!guide || !identity) throw new Error('角色替换需要连接一段源视频和一张单人身份图。');
  const [width, height] = resolveDimensions(options.ratio, options.resolution);
  const length = durationToFrames(options.duration || 5);
  const prompt = ensureCharacterSwapAppearanceLock(options.prompt?.trim().startsWith('body_swap:')
    ? options.prompt.trim()
    : buildCharacterSwapPrompt(options.prompt, options.targetDescription));
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: MODEL_INFO.referenceUnet, weight_dtype: 'default' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: CHARACTER_SWAP_MODELS.dmdLora, strength_model: 1 } },
    '17': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['2', 0], lora_name: CHARACTER_SWAP_MODELS.characterLora, strength_model: 1 } },
    '3': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['17', 0], shift_video: 12, shift_audio: 3 } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: MODEL_INFO.clip, type: 'minimax', device: 'default' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: MODEL_INFO.videoVae } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: MODEL_INFO.audioVae } },
    '7': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
      clip: ['4', 0], vae: ['5', 0], audio_vae: ['6', 0], prompt, width, height, length,
      ref_image_size: options.refImageSize || 'max', ref_images: { ref_image_0: ['100', 0] },
    } },
    '18': { class_type: 'EmptyMiniMaxH3LatentAV', inputs: { width, height, length } },
    '19': { class_type: 'MiniMaxH3AddGuide', inputs: {
      positive: ['7', 0], latent: ['18', 0], frame_idx: 0, vae: ['5', 0], audio_vae: ['6', 0],
      image: ['104', 0], audio: ['105', 0],
    } },
    '8': { class_type: 'CFGGuider', inputs: { model: ['3', 0], positive: ['19', 0], negative: ['19', 0], cfg: 1 } },
    '9': { class_type: 'RandomNoise', inputs: { noise_seed: Number(options.seed) } },
    '10': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '11': { class_type: 'BasicScheduler', inputs: { model: ['3', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
    '12': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['9', 0], guider: ['8', 0], sampler: ['10', 0], sigmas: ['11', 0], latent_image: ['18', 0] } },
    '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['5', 0] } },
    '15': { class_type: 'CreateVideo', inputs: { images: options.preserveBackground ? ['23', 0] : ['13', 0], fps: 24, audio: ['105', 0], codec: 'h264' } },
    '16': { class_type: 'SaveVideo', inputs: { video: ['15', 0], filename_prefix: 'video/H3_CharacterSwap', format: 'mp4', codec: 'auto' } },
    '100': { class_type: 'LoadImage', inputs: { image: identity.name } },
    '101': { class_type: 'LoadVideo', inputs: { file: guide.name } },
    '102': { class_type: 'GetVideoComponents', inputs: { video: ['101', 0] } },
    '103': { class_type: 'ImageScale', inputs: { image: ['102', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' } },
    '104': { class_type: 'ImageFromBatch', inputs: { image: ['103', 0], batch_index: 0, length } },
    '105': { class_type: 'TrimAudioDuration', inputs: { audio: ['102', 1], start_index: 0, duration: length / 24 } },
  };
  if (options.preserveBackground) {
    Object.assign(graph, {
      '20': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHARACTER_SWAP_MODELS.samCheckpoint } },
      '21': { class_type: 'CLIPTextEncode', inputs: { clip: ['20', 1], text: options.targetQuery || 'person' } },
      '22': { class_type: 'ImageFromBatch', inputs: { image: ['104', 0], batch_index: 0, length: 1 } },
      '24': { class_type: 'SAM3_Detect', inputs: { model: ['20', 0], image: ['22', 0], conditioning: ['21', 0], threshold: 0.35, refine_iterations: 2, individual_masks: true } },
      '25': { class_type: 'SAM3_VideoTrack', inputs: { images: ['104', 0], model: ['20', 0], initial_mask: ['24', 0], detection_threshold: 0.35, max_objects: 8, detect_interval: 1 } },
      '26': { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['25', 0], object_indices: String(options.targetIndex ?? 0) } },
      '27': { class_type: 'GrowMaskWithBlur', inputs: { mask: ['26', 0], expand: 8, incremental_expandrate: 0, tapered_corners: true, flip_input: false, blur_radius: 12, lerp_alpha: 1, decay_factor: 1 } },
      '23': { class_type: 'ImageCompositeMasked', inputs: { destination: ['104', 0], source: ['13', 0], x: 0, y: 0, resize_source: true, mask: ['27', 0] } },
      '28': { class_type: 'SAM3_TrackPreview', inputs: { track_data: ['25', 0], images: ['104', 0], opacity: 0.5, fps: 24 } },
    });
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

export function extractVideos(historyEntry) {
  const videos = [];
  for (const output of Object.values(historyEntry?.outputs || {})) {
    for (const value of Object.values(output || {})) {
      if (!Array.isArray(value)) continue;
      for (const file of value) {
        if (file && typeof file === 'object' && 'filename' in file && 'subfolder' in file && 'type' in file) {
          videos.push({ ...file, url: viewUrl(file) });
        }
      }
    }
  }
  return videos;
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
