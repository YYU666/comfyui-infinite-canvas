// Local ComfyUI video upscalers. Source FPS and audio flow to a new saved video;
// no source preview or input file can serve as the finished output.
export const VIDEO_SUPER_RESOLUTION_MODELS = Object.freeze(['rtx', 'seedvr2_3b', 'seedvr2_7b']);
export const RTX_SUPER_RESOLUTION_QUALITIES = Object.freeze([
  'LOW', 'MEDIUM', 'HIGH', 'ULTRA',
  'HIGHBITRATE_LOW', 'HIGHBITRATE_MEDIUM', 'HIGHBITRATE_HIGH', 'HIGHBITRATE_ULTRA',
  'STREAMING_MEDIUM', 'STREAMING_ULTRA',
]);

const SEEDVR_MODELS = Object.freeze({
  seedvr2_3b: 'seedvr2_3b_int8_convrot.safetensors',
  seedvr2_7b: 'seedvr2_7b_int8_convrot.safetensors',
});

function numberInRange(value, fallback, min, max, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label}必须在 ${min}–${max} 之间。`);
  }
  return number;
}

export function normalizeVideoSuperResolutionSettings(options = {}) {
  const videoUpscaleModel = options.videoUpscaleModel ?? 'rtx';
  if (!VIDEO_SUPER_RESOLUTION_MODELS.includes(videoUpscaleModel)) throw new Error('未知的视频超分模型。');
  const videoUpscaleScale = numberInRange(options.videoUpscaleScale, 2, 1, 4, '视频超分倍率');
  const rtxQuality = options.rtxQuality ?? 'ULTRA';
  if (!RTX_SUPER_RESOLUTION_QUALITIES.includes(rtxQuality)) throw new Error('未知的 RTX 超分质量档位。');
  const rtxStrength = numberInRange(options.rtxStrength, 1, 0, 1, 'RTX 超分强度');
  return { videoUpscaleModel, videoUpscaleScale, rtxQuality, rtxStrength };
}

export function videoSuperResolutionOutputPrefix(model = 'rtx') {
  if (!VIDEO_SUPER_RESOLUTION_MODELS.includes(model)) throw new Error('未知的视频超分模型。');
  return model === 'rtx' ? 'video/H3_RTX_VFX' : 'video/H3_SeedVR2';
}

function comboOptions(field) {
  if (!Array.isArray(field)) return null;
  if (Array.isArray(field[0])) return field[0]; // Legacy ComfyUI enumeration.
  if (field[0] === 'COMBO' && Array.isArray(field[1]?.options)) return field[1].options;
  return null;
}

function numericInputAccepts(field, value) {
  return Array.isArray(field) && field[0] === 'FLOAT' && typeof value === 'number'
    && Number.isFinite(value)
    && (field[1]?.min === undefined || value >= field[1].min)
    && (field[1]?.max === undefined || value <= field[1].max);
}

// Inspect the same backend that will receive the graph. This is a preflight,
// never an installer: registered node schemas and selected local filenames only.
export async function getVideoSuperResolutionDependencyStatus(workflow, comfyFetch) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)
    || !Object.keys(workflow).length || Object.values(workflow).some((node) => !node || typeof node.class_type !== 'string')) {
    throw new Error('视频超分工作流无效，未检查或提交生成。');
  }
  if (typeof comfyFetch !== 'function') throw new Error('视频超分缺少 ComfyUI 依赖检查接口。');
  const definitions = await comfyFetch('/object_info');
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    throw new Error('无法读取 ComfyUI 节点清单，请确认画布连接的后台在线。');
  }
  const missing = [];
  const classes = [...new Set(Object.values(workflow).map((node) => node.class_type))];
  for (const name of classes) {
    if (!Object.hasOwn(definitions, name) || !definitions[name] || typeof definitions[name] !== 'object') missing.push(`ComfyUI 节点 ${name}`);
  }
  for (const node of Object.values(workflow)) {
    const loaderKey = node.class_type === 'UNETLoader' ? 'unet_name' : node.class_type === 'VAELoader' ? 'vae_name' : null;
    if (loaderKey) {
      const selected = node.inputs?.[loaderKey];
      const files = comboOptions(definitions[node.class_type]?.input?.required?.[loaderKey]);
      if (typeof selected !== 'string' || !files?.includes(selected)) missing.push(selected || `${node.class_type}.${loaderKey} 文件选择接口`);
    }
    if (node.class_type !== 'RTXVideoSuperResolution' || !definitions.RTXVideoSuperResolution) continue;
    const required = definitions.RTXVideoSuperResolution.input?.required;
    const resize = required?.resize_type;
    const scaleMode = resize?.[0] === 'COMFY_DYNAMICCOMBO_V3'
      && resize[1]?.options?.find((option) => option?.key === 'scale by multiplier');
    const scale = scaleMode?.inputs?.required?.scale;
    if (required?.images?.[0] !== 'IMAGE'
      || node.inputs?.resize_type !== 'scale by multiplier'
      || !numericInputAccepts(scale, node.inputs?.['resize_type.scale'])) {
      missing.push('RTX Video Super Resolution 动态倍率接口（resize_type.scale）');
    }
    if (!numericInputAccepts(required?.strength, node.inputs?.strength)) missing.push('RTX Video Super Resolution 强度接口');
    if (!comboOptions(required?.quality)?.includes(node.inputs?.quality)) missing.push(`RTX Video Super Resolution 质量档位 ${node.inputs?.quality ?? ''}`.trim());
    if (!comboOptions(required?.image_encoding)?.includes(node.inputs?.image_encoding)) missing.push('RTX Video Super Resolution 8-bit RGB 编码接口');
    if (!definitions.RTXVideoSuperResolution.output?.includes('IMAGE')) missing.push('RTX Video Super Resolution IMAGE 输出接口');
  }
  const uniqueMissing = [...new Set(missing)];
  return { ready: uniqueMissing.length === 0, missing: uniqueMissing };
}

export function buildVideoSuperResolutionWorkflow(options = {}) {
  const settings = normalizeVideoSuperResolutionSettings(options);
  const guide = options.references?.find((ref) => ref.slot === 'guide' && ref.kind === 'video');
  if (!guide || typeof guide.name !== 'string' || !guide.name.trim()) {
    throw new Error('视频超分需要连接一段本地视频。');
  }
  const graph = {
    source: { class_type: 'LoadVideo', inputs: { file: guide.name } },
    components: { class_type: 'GetVideoComponents', inputs: { video: ['source', 0] } },
  };
  let resultImages;
  if (settings.videoUpscaleModel === 'rtx') {
    graph.rtx = { class_type: 'RTXVideoSuperResolution', inputs: {
      images: ['components', 0], resize_type: 'scale by multiplier',
      'resize_type.scale': settings.videoUpscaleScale,
      quality: settings.rtxQuality, strength: settings.rtxStrength,
      image_encoding: '8-bit RGB',
    } };
    resultImages = ['rtx', 0];
  } else {
    const seed = options.seed === undefined ? 42 : Number(options.seed);
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('SeedVR2 种子必须为非负安全整数。');
    Object.assign(graph, {
      model: { class_type: 'UNETLoader', inputs: { unet_name: SEEDVR_MODELS[settings.videoUpscaleModel], weight_dtype: 'default' } },
      vae: { class_type: 'VAELoader', inputs: { vae_name: 'seedvr2_ema_vae_fp16.safetensors' } },
      resize: { class_type: 'ResizeImageMaskNode', inputs: {
        input: ['components', 0], resize_type: 'scale by multiplier',
        'resize_type.multiplier': settings.videoUpscaleScale, scale_method: 'lanczos',
      } },
      // Preprocess pads the time axis to 4n+1; PostProcessing removes that padding
      // using the complete resized source sequence. No fixed-duration crop.
      preprocess: { class_type: 'SeedVR2Preprocess', inputs: { resized_images: ['resize', 0] } },
      encode: { class_type: 'VAEEncodeTiled', inputs: {
        pixels: ['preprocess', 0], vae: ['vae', 0], tile_size: 512, overlap: 128,
        temporal_size: 64, temporal_overlap: 8,
      } },
      chunks: { class_type: 'SeedVR2TemporalChunk', inputs: {
        latent: ['encode', 0], temporal_overlap: 1,
        chunking_mode: 'manual', 'chunking_mode.frames_per_chunk': 21,
      } },
      conditioning: { class_type: 'SeedVR2Conditioning', inputs: {
        model: ['model', 0], vae_conditioning: ['chunks', 0],
      } },
      sample: { class_type: 'KSampler', inputs: {
        model: ['model', 0], seed, steps: 1, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
        positive: ['conditioning', 0], negative: ['conditioning', 1], latent_image: ['chunks', 0], denoise: 1,
      } },
      merge: { class_type: 'SeedVR2TemporalMerge', inputs: {
        latents: ['sample', 0], temporal_overlap: ['chunks', 1],
      } },
      decode: { class_type: 'VAEDecodeTiled', inputs: {
        samples: ['merge', 0], vae: ['vae', 0], tile_size: 512, overlap: 128,
        temporal_size: 64, temporal_overlap: 8,
      } },
      postprocess: { class_type: 'SeedVR2PostProcessing', inputs: {
        images: ['decode', 0], original_resized_images: ['resize', 0], color_correction_method: 'lab',
      } },
    });
    resultImages = ['postprocess', 0];
  }
  graph.video = { class_type: 'CreateVideo', inputs: {
    images: resultImages, fps: ['components', 2], audio: ['components', 1],
  } };
  graph.save = { class_type: 'SaveVideo', inputs: {
    video: ['video', 0], filename_prefix: videoSuperResolutionOutputPrefix(settings.videoUpscaleModel),
    format: 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 16,
  } };
  return graph;
}
