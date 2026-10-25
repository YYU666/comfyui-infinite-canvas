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
