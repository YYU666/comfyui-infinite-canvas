import { FLUX3_PUP_PROMPTS } from './flux3-klein-prompts.js';
import { compileQwenPrompt, orderQwenReferences, validateQwenReferences } from './qwen-references.js';

// Official ComfyUI INT8 checkpoints; RTX 30-series does not support NVFP4.
export const FLUX3_KLEIN_MODEL = Object.freeze({
  unet: 'flux3-image-klein-int8-convrot.safetensors',
  clip: 'qwen3vl_4b_int8_convrot.safetensors',
  upsampler: 'qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors',
  vae: 'flux2-vae.safetensors',
});

export function scaleFlux3Dimensions(dimensions, resolution = '1MP') {
  if (!['1MP', '2K', '4K'].includes(resolution)) throw new Error('FLUX 3 输出尺寸仅支持 1MP、2K 或 4K。');
  if (resolution === '1MP') return dimensions;
  const longest = resolution === '2K' ? 2048 : 4096;
  const scale = longest / Math.max(...dimensions);
  return dimensions.map((value) => Math.max(16, Math.round(value * scale / 16) * 16));
}

export async function getFlux3KleinDependencyStatus(workflow) {
  // Inspect the exact graph: image editing and each output size use different nodes.
  const names = [...new Set(Object.values(workflow).map((node) => node.class_type))];
  const definitions = Object.fromEntries(await Promise.all(names.map(async (name) => {
    const response = await fetch(`/api/comfy/object_info/${name}`);
    if (response.status === 404) return [name, null];
    if (!response.ok) throw new Error('无法检查 FLUX 3 模型与节点依赖，请确认 ComfyUI 在线。');
    return [name, (await response.json())[name]];
  })));
  const loaders = ['UNETLoader', 'CLIPLoader', 'VAELoader'].map((name) => definitions[name]?.input?.required);
  const checks = [
    [loaders[0]?.unet_name?.[0], FLUX3_KLEIN_MODEL.unet],
    [loaders[1]?.clip_name?.[0], FLUX3_KLEIN_MODEL.clip],
    [loaders[1]?.clip_name?.[0], FLUX3_KLEIN_MODEL.upsampler],
    [loaders[2]?.vae_name?.[0], FLUX3_KLEIN_MODEL.vae],
  ];
  const missing = names.filter((name) => !definitions[name]).map((name) => `ComfyUI 节点 ${name}`);
  missing.push(...checks.filter(([files, file]) => !Array.isArray(files) || !files.includes(file)).map(([, file]) => file));
  const clipTypes = loaders[1]?.type?.[0];
  if (!Array.isArray(clipTypes) || !clipTypes.includes('flux3')) missing.push('ComfyUI 的 flux3 文本编码器支持');
  return { ready: missing.length === 0, missing };
}

export function buildFlux3KleinWorkflow(options, dimensions) {
  const editing = options.mode === 'qwenEdit';
  if (options.imageLora && options.imageLora !== 'none') throw new Error('FLUX 3 Klein 不能使用 Qwen／Krea2 的 LoRA，请先关闭图片 LoRA。');
  if (options.qwenSourceCrop || options.qwenMaskCrop || options.references?.some((ref) => (ref.data?.slot ?? ref.slot) === 'mask')) {
    throw new Error('FLUX 3 Klein 暂不支持当前 Qwen 局部裁切与遮罩，请切回 Qwen 进行局部修改。');
  }
  const references = editing ? orderQwenReferences(options.references || [], options.qwenReferenceOrder) : [];
  if (editing) validateQwenReferences(references);
  if (references.some((ref) => !ref.name)) throw new Error('FLUX 3 参考图片尚未上传完成。');
  const prompt = (editing ? compileQwenPrompt(options.prompt || '', references) : options.prompt || '').trim();
  if (!prompt) throw new Error('请先输入图片生成或编辑要求。');
  const seed = Number(options.seed ?? 42);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('FLUX 3 种子必须是非负安全整数。');
  const graph = {
    model: { class_type: 'UNETLoader', inputs: { unet_name: FLUX3_KLEIN_MODEL.unet, weight_dtype: 'default' } },
    text: { class_type: 'CLIPLoader', inputs: { clip_name: FLUX3_KLEIN_MODEL.clip, type: 'flux3', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: FLUX3_KLEIN_MODEL.vae } },
    upsampler: { class_type: 'CLIPLoader', inputs: { clip_name: FLUX3_KLEIN_MODEL.upsampler, type: 'flux3', device: 'default' } },
    caption: { class_type: 'TextGenerate', inputs: {
      clip: ['upsampler', 0], prompt: prompt.replace(/<image(\d+)>/g, 'reference image $1'),
      system_prompt: FLUX3_PUP_PROMPTS[editing ? 'i2i' : 't2i'], max_length: 3584,
      sampling_mode: 'on', 'sampling_mode.temperature': 1, 'sampling_mode.top_k': 1,
      'sampling_mode.top_p': 0.95, 'sampling_mode.min_p': 0, 'sampling_mode.repetition_penalty': 1.05,
      'sampling_mode.seed': seed, 'sampling_mode.presence_penalty': editing ? 0 : 1.5,
      thinking: false, use_default_template: true, mtp: 'off',
    } },
    positive: { class_type: 'CLIPTextEncode', inputs: { clip: ['text', 0], text: ['caption', 0] } },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive', 0] } },
    sample: { class_type: 'KSampler', inputs: {
      model: ['model', 0], seed, steps: 16, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0],
    } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: editing ? 'image/H3_Flux3Klein_Edit' : 'image/H3_Flux3Klein' } },
  };
  if (!editing) {
    const [width, height] = scaleFlux3Dimensions(dimensions, options.flux3Resolution);
    graph.latent = { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: 1 } };
    graph.caption.inputs.prompt = `TARGET CANVAS: ${width}:${height}\n${prompt}`;
    return graph;
  }
  const referenceSize = Number(options.qwenRefResolution || 1024);
  if (!Number.isFinite(referenceSize) || referenceSize < 256 || referenceSize > 4096) throw new Error('FLUX 3 参考精度须在 256–4096 之间。');
  graph.encode = { class_type: 'ReferenceMultiLatent', inputs: {
    positive: ['positive', 0], negative: ['negative', 0], vae: ['vae', 0],
    resolution: 'resize', 'resolution.megapixels': referenceSize ** 2 / 1024 ** 2,
  } };
  // Only the captioner's copies are letterboxed to a common batch size.
  // Original references go to the image model independently, in the same order.
  references.forEach((ref, index) => {
    const key = `reference_${index + 1}`, preview = `caption_image_${index + 1}`;
    graph[key] = { class_type: 'LoadImage', inputs: { image: ref.name } };
    graph.encode.inputs[`images.image${index}`] = [key, 0];
    graph[preview] = { class_type: 'ResizeAndPadImage', inputs: {
      image: [key, 0], target_width: 768, target_height: 768, padding_color: 'white', interpolation: 'lanczos',
    } };
    if (index === 0) graph.caption.inputs.image = [preview, 0];
    else {
      const batch = `caption_batch_${index + 1}`;
      graph[batch] = { class_type: 'ImageBatch', inputs: { image1: graph.caption.inputs.image, image2: [preview, 0] } };
      graph.caption.inputs.image = [batch, 0];
    }
  });
  graph.sample.inputs.positive = ['encode', 0];
  graph.sample.inputs.negative = ['encode', 1];
  scaleFlux3Dimensions([1024, 1024], options.flux3Resolution); // Validate the selected size for edits, too.
  if (!options.flux3Resolution || options.flux3Resolution === '1MP') {
    graph.output_size = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['reference_1', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 } };
  } else {
    graph.output_size = { class_type: 'ImageScaleToMaxDimension', inputs: { image: ['reference_1', 0], upscale_method: 'lanczos', largest_size: options.flux3Resolution === '4K' ? 4096 : 2048 } };
  }
  graph.size = { class_type: 'GetImageSize', inputs: { image: ['output_size', 0] } };
  graph.latent = { class_type: 'EmptyFlux2LatentImage', inputs: { width: ['size', 0], height: ['size', 1], batch_size: 1 } };
  graph.sample.inputs.latent_image = ['latent', 0];
  return graph;
}
