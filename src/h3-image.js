import { compileQwenPrompt, orderQwenReferences, validateQwenReferences } from './qwen-references.js';

export const H3_IMAGE_MODEL = Object.freeze({
  unet: 'minimax_h3_image_pruned_int8_convrot.safetensors',
  clip: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
  vae: 'minimax_h3_image_vae_fp16.safetensors',
});
export const isH3Image = (data = {}) => (data.mode === 'image' && data.imageModel === 'h3_image') || (data.mode === 'qwenEdit' && data.qwenModel === 'h3_image');

export function resolveH3ImageDimensions(ratio = '16:9', resolution = '4MP') {
  if (!['4MP', '16MP'].includes(resolution)) throw new Error('H3-Image 输出尺寸仅支持 4MP 或 16MP。');
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(ratio)) throw new Error('不支持的 H3-Image 画幅比例。');
  const [w, h] = ratio.split(':').map(Number);
  const area = (resolution === '16MP' ? 16 : 4) * 1024 ** 2;
  return [Math.sqrt(area * w / h), Math.sqrt(area * h / w)].map(value => Math.ceil(value / 32) * 32);
}

export function buildH3ImageWorkflow(options) {
  const editing = options.mode === 'qwenEdit';
  if (options.imageLora && options.imageLora !== 'none') throw new Error('H3-Image 不能使用 Qwen／Krea2 的 LoRA，请先关闭图片 LoRA。');
  if (options.qwenSourceCrop || options.qwenMaskCrop || options.references?.some(ref => (ref.data?.slot ?? ref.slot) === 'mask')) throw new Error('H3-Image 暂不支持局部裁切与遮罩，请切回 Qwen。');
  const refs = editing ? orderQwenReferences(options.references || [], options.qwenReferenceOrder) : [];
  if (editing) validateQwenReferences(refs);
  if (refs.some(ref => !ref.name)) throw new Error('H3-Image 参考图片尚未上传完成。');
  const prompt = (editing ? compileQwenPrompt(options.prompt || '', refs).replace(/<image(\d+)>/g, '<Picture $1>') : options.prompt || '').trim();
  if (!prompt) throw new Error('请先输入 H3-Image 图片生成或编辑要求。');
  const seed = Number(options.seed ?? 42);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('H3-Image 种子必须是非负安全整数。');
  const [width, height] = resolveH3ImageDimensions(options.ratio || '16:9', options.h3ImageResolution);
  const graph = {
    model: { class_type: 'UNETLoader', inputs: { unet_name: H3_IMAGE_MODEL.unet, weight_dtype: 'default' } },
    text: { class_type: 'CLIPLoader', inputs: { clip_name: H3_IMAGE_MODEL.clip, type: 'minimax', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: H3_IMAGE_MODEL.vae } },
    positive: { class_type: 'MiniMaxH3ImageConditioning', inputs: { clip: ['text', 0], vae: ['vae', 0], prompt, width, height } },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive', 0] } },
    sample: { class_type: 'KSampler', inputs: { model: ['model', 0], seed, steps: 6, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, positive: ['positive', 0], negative: ['negative', 0], latent_image: ['positive', 1] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: editing ? 'image/H3_Image_Edit' : 'image/H3_Image' } },
  };
  if (editing) {
    refs.forEach((ref, index) => {
      const key = `reference_${index + 1}`;
      graph[key] = { class_type: 'LoadImage', inputs: { image: ref.name } };
      graph.positive.inputs[`images.image_${index + 1}`] = [key, 0];
    });
    graph.output_size = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['reference_1', 0], upscale_method: 'lanczos', megapixels: options.h3ImageResolution === '16MP' ? 16 : 4, resolution_steps: 32 } };
    graph.size = { class_type: 'GetImageSize', inputs: { image: ['output_size', 0] } };
    graph.positive.inputs.width = ['size', 0];
    graph.positive.inputs.height = ['size', 1];
  }
  return graph;
}

export async function getH3ImageDependencyStatus(workflow) {
  const names = [...new Set(Object.values(workflow).map(node => node.class_type))];
  const definitions = Object.fromEntries(await Promise.all(names.map(async name => {
    const response = await fetch(`/api/comfy/object_info/${name}`);
    if (response.status === 404) return [name, null];
    if (!response.ok) throw new Error('无法检查 H3-Image 模型与节点，请确认画布连接的 ComfyUI 在线。');
    return [name, (await response.json())[name]];
  })));
  const missing = names.filter(name => !definitions[name]).map(name => `ComfyUI 节点 ${name}`);
  const unet = definitions.UNETLoader?.input?.required, clip = definitions.CLIPLoader?.input?.required, vae = definitions.VAELoader?.input?.required;
  for (const [available, filename] of [[unet?.unet_name?.[0], H3_IMAGE_MODEL.unet], [clip?.clip_name?.[0], H3_IMAGE_MODEL.clip], [vae?.vae_name?.[0], H3_IMAGE_MODEL.vae]]) {
    if (!Array.isArray(available) || !available.includes(filename)) missing.push(filename);
  }
  if (!clip?.type?.[0]?.includes('minimax')) missing.push('ComfyUI minimax 文本编码器支持');
  return { ready: missing.length === 0, missing };
}
