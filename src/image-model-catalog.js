// Compact picker data: dropdown values, task order, install names, and compatibility.
// Speed numbers are step/size estimates, not measured local timings.

export const IMAGE_MODEL_FIELDS = Object.freeze({
  imageModel: Object.freeze(['krea2', 'moss', 'h3_image', 'flux3_klein']),
  qwenModel: Object.freeze(['standard', 'turbo', 'h3_image', 'flux3_klein']),
});

export const KREA_STYLE_LORAS = Object.freeze(['realism', 'asian', 'fantasy', 'watercolor', 'retroAnime']);

export const SCORE_WEIGHTS = Object.freeze({
  base: Object.freeze({ task: 0.6, history: 0.3, speed: 0.1 }),
  // 快速 / 草图 / 多来几张 / 先看看 / 批量: speed becomes 0.3, task match drops to 0.4, history stays 0.3.
  speed: Object.freeze({ task: 0.4, history: 0.3, speed: 0.3 }),
});

export const TASK_FIT = Object.freeze([1, 0.75, 0.5, 0.25]);

export const SPEED_PRIOR = Object.freeze({
  krea2: 1,
  turbo: 0.9,
  flux3_klein: 0.6,
  moss: 0.6,
  standard: 0.3,
  h3_image: 0.2,
});

const file = (loader, name) => Object.freeze({ loader, name });

export const IMAGE_MODELS = Object.freeze([
  {
    id: 'krea2',
    fields: ['imageModel'],
    label: 'Krea2',
    speed: SPEED_PRIOR.krea2,
    clipType: 'krea2',
    files: Object.freeze([
      file('unet', 'Krea2-MuseByStable_v30Turbo_fp8.safetensors'),
      file('clip', 'qwen3vl_4b_fp8_scaled.safetensors'),
      file('vae', 'qwen_image_vae.safetensors'),
    ]),
    nodes: Object.freeze(['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ConditioningZeroOut', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage']),
    loras: Object.freeze({
      realism: 'Krea2-N\\Krea2-realism_engine_v2.safetensors',
      asian: 'Krea2-功能\\Krea2-亚洲asianMix_v1-bf16.safetensors',
      fantasy: 'Krea2-风格\\Krea2-奇幻现实FantasyRealism.safetensors',
      watercolor: 'Krea2-风格\\krea2_装饰艺术柔和水彩softwatercolor.safetensors',
      retroAnime: 'Krea2-风格\\krea2_紫调复古旧动漫retroanime.safetensors',
    }),
  },
  {
    id: 'moss',
    fields: ['imageModel'],
    label: 'MOSS',
    speed: SPEED_PRIOR.moss,
    clipType: 'moss_image',
    files: Object.freeze([
      file('unet', 'Moss_image\\moss_image_sft_int8_convrot.safetensors'),
      file('clip', 'qwen3.5_9b_int8_convrot.safetensors'),
      file('vae', 'flux2-vae_small.safetensors'),
    ]),
    nodes: Object.freeze(['UNETLoader', 'CLIPLoader', 'VAELoader', 'SpectrumMOSSImageAdaptive', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage']),
  },
  {
    id: 'h3_image',
    fields: ['imageModel', 'qwenModel'],
    label: 'H3-Image',
    speed: SPEED_PRIOR.h3_image,
    clipType: 'minimax',
    files: Object.freeze([
      file('unet', 'minimax_h3_image_pruned_int8_convrot.safetensors'),
      file('clip', 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors'),
      file('vae', 'minimax_h3_image_vae_fp16.safetensors'),
    ]),
    nodes: Object.freeze(['UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageConditioning', 'ConditioningZeroOut', 'KSampler', 'VAEDecode', 'SaveImage']),
    editNodes: Object.freeze(['LoadImage', 'ImageScaleToTotalPixels', 'GetImageSize']),
  },
  {
    id: 'flux3_klein',
    fields: ['imageModel', 'qwenModel'],
    label: 'FLUX 3 Klein',
    speed: SPEED_PRIOR.flux3_klein,
    clipType: 'flux3',
    files: Object.freeze([
      file('unet', 'flux3-image-klein-int8-convrot.safetensors'),
      file('clip', 'qwen3vl_4b_int8_convrot.safetensors'),
      file('clip', 'qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors'),
      file('vae', 'flux2-vae.safetensors'),
    ]),
    nodes: Object.freeze(['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextGenerate', 'CLIPTextEncode', 'ConditioningZeroOut', 'KSampler', 'EmptyFlux2LatentImage', 'VAEDecode', 'SaveImage']),
    editNodes: Object.freeze(['LoadImage', 'ReferenceMultiLatent', 'ResizeAndPadImage', 'ImageBatch', 'ImageScaleToTotalPixels', 'ImageScaleToMaxDimension', 'GetImageSize']),
  },
  {
    id: 'standard',
    fields: ['qwenModel'],
    label: 'Qwen 2.1 标准版',
    speed: SPEED_PRIOR.standard,
    clipType: 'qwen_image',
    files: Object.freeze([
      file('unet', 'qwen_image_2.1_int8_convrot.safetensors'),
      file('clip', 'qwen3vl_8b_int8_convrot.safetensors'),
      file('vae', 'qwen_image_2.1_vae_bf16.safetensors'),
    ]),
    nodes: Object.freeze(['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoadImage', 'TextEncodeQwenImage21', 'KSampler', 'VAEDecode', 'SaveImage']),
    maskNodes: Object.freeze(['ImageScale', 'ImageToMask', 'GetImageSize', 'GetLatentSize', 'SimpleMath+', 'VAEEncode', 'SetLatentNoiseMask', 'ImageCompositeMasked']),
    maskCropNodes: Object.freeze(['InpaintCropImproved', 'InpaintStitchImproved', 'MaskToImage']),
    sourceCropNodes: Object.freeze(['ImageCrop']),
    loras: Object.freeze({ qwen21Realism: 'Qwen2.1_Anything2RealCharacters.safetensors' }),
  },
  {
    id: 'turbo',
    fields: ['qwenModel'],
    label: 'Qwen 2.1 Turbo',
    speed: SPEED_PRIOR.turbo,
    clipType: 'qwen_image',
    files: Object.freeze([
      file('unet', 'qwen_image_2.1_turbo_int8_convrot.safetensors'),
      file('clip', 'qwen3vl_8b_int8_convrot.safetensors'),
      file('vae', 'qwen_image_2.1_vae_bf16.safetensors'),
    ]),
    nodes: Object.freeze(['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoadImage', 'TextEncodeQwenImage21', 'QwenImage21Cache', 'RandomNoise', 'KSamplerSelect', 'ManualSigmas', 'CFGGuider', 'SamplerCustomAdvanced', 'VAEDecode', 'SaveImage']),
    maskNodes: Object.freeze(['ImageScale', 'ImageToMask', 'GetImageSize', 'GetLatentSize', 'SimpleMath+', 'VAEEncode', 'SetLatentNoiseMask', 'ImageCompositeMasked']),
    maskCropNodes: Object.freeze(['InpaintCropImproved', 'InpaintStitchImproved', 'MaskToImage']),
    sourceCropNodes: Object.freeze(['ImageCrop']),
    loras: Object.freeze({ qwen21Realism: 'Qwen2.1_Anything2RealCharacters.safetensors' }),
  },
]);

export const IMAGE_MODEL_BY_ID = Object.freeze(Object.fromEntries(IMAGE_MODELS.map((model) => [model.id, model])));

export const IMAGE_TASKS = Object.freeze([
  { id: 'env_concept', field: 'imageModel', label: '场景概念', order: Object.freeze(['h3_image', 'flux3_klein', 'krea2', 'moss']) },
  { id: 'fast_ideation', field: 'imageModel', label: '快速草图', order: Object.freeze(['krea2', 'flux3_klein', 'moss', 'h3_image']) },
  { id: 'style_exploration', field: 'imageModel', label: '风格探索', order: Object.freeze(['krea2', 'moss', 'h3_image', 'flux3_klein']) },
  { id: 'photoreal_people', field: 'imageModel', label: '写实人物', order: Object.freeze(['krea2', 'h3_image', 'flux3_klein', 'moss']) },
  { id: 'anime_character', field: 'imageModel', label: '动漫角色', order: Object.freeze(['moss', 'krea2', 'flux3_klein', 'h3_image']) },
  { id: 'text_layout', field: 'imageModel', label: '图中文字', order: Object.freeze(['moss', 'h3_image', 'flux3_klein', 'krea2']) },
  { id: 'ultra_hires', field: 'imageModel', label: '超高分辨率', order: Object.freeze(['h3_image', 'flux3_klein', 'krea2', 'moss']) },
  { id: 'default_image', field: 'imageModel', label: '文生图', order: Object.freeze(['krea2', 'moss', 'h3_image', 'flux3_klein']) },
  { id: 'local_mask_edit', field: 'qwenModel', label: '局部遮罩', hardOnly: true, order: Object.freeze(['standard', 'turbo']) },
  { id: 'global_restyle_edit', field: 'qwenModel', label: '整图改风格', order: Object.freeze(['h3_image', 'flux3_klein', 'standard', 'turbo']) },
  { id: 'multi_ref_compose', field: 'qwenModel', label: '多参考合成', order: Object.freeze(['h3_image', 'standard', 'flux3_klein', 'turbo']) },
  { id: 'identity_keep_edit', field: 'qwenModel', label: '保持身份', order: Object.freeze(['standard', 'turbo', 'h3_image', 'flux3_klein']) },
  { id: 'anime_to_real', field: 'qwenModel', label: '漫转真', hardOnly: true, order: Object.freeze(['standard', 'turbo']) },
  { id: 'text_edit', field: 'qwenModel', label: '改图中文字', order: Object.freeze(['standard', 'h3_image', 'turbo', 'flux3_klein']) },
  { id: 'fast_edit_preview', field: 'qwenModel', label: '快速编辑', order: Object.freeze(['turbo', 'flux3_klein', 'standard', 'h3_image']) },
  { id: 'default_edit', field: 'qwenModel', label: '图生图', order: Object.freeze(['standard', 'turbo', 'h3_image', 'flux3_klein']) },
]);

export const IMAGE_TASK_BY_ID = Object.freeze(Object.fromEntries(IMAGE_TASKS.map((task) => [task.id, task])));

export function modelNodeClasses(model, context = {}) {
  const names = [...model.nodes];
  if (context.editing && model.editNodes) names.push(...model.editNodes);
  if (context.hasMask && model.maskNodes) names.push(...model.maskNodes);
  if (context.hasMaskCrop && model.maskCropNodes) names.push(...model.maskCropNodes);
  if (context.hasSourceCrop && model.sourceCropNodes) names.push(...model.sourceCropNodes);
  if (context.imageLora && context.imageLora !== 'none' && model.loras?.[context.imageLora]) names.push('LoraLoaderModelOnly');
  return [...new Set(names)];
}

export function allInstallNodeClasses() {
  const names = new Set(['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoaderModelOnly']);
  for (const model of IMAGE_MODELS) {
    for (const name of modelNodeClasses(model, { editing: true, hasMask: true, hasMaskCrop: true, hasSourceCrop: true, imageLora: 'qwen21Realism' })) names.add(name);
    for (const name of modelNodeClasses(model, { imageLora: 'realism' })) names.add(name);
  }
  return [...names];
}
