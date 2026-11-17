import { MOSS_IMAGE_MODEL, buildQwen21EditWorkflow } from './workbench-api.js';

export const MOSS_POSE_LORA = 'moss_image_sft_pose_control_lora.safetensors';
export const MOSS_POSE_DEFAULTS = Object.freeze({ poseInput: 'photo', poseResolution: 1024, poseSteps: 30, poseCfg: 4, poseLoraStrength: 1, seed: 42, randomSeed: false });

export function validateMossPoseSettings(options) {
  for (const [key, min, max, integer] of [['poseResolution', 256, 1536, true], ['poseSteps', 1, 60, true], ['poseCfg', 1, 10, false], ['poseLoraStrength', 0, 2, false], ['seed', 0, Number.MAX_SAFE_INTEGER, true]]) {
    const value = options[key] ?? MOSS_POSE_DEFAULTS[key];
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`${key} 必须在 ${min}–${max} 之间${integer ? '，且为整数' : ''}。`);
  }
  if (!['photo', 'skeleton'].includes(options.poseInput ?? 'photo')) throw new Error('姿势输入仅支持照片或已提取的骨架图。');
}

// The author trains on a single colored skeleton. Identity is an explicit Qwen
// editing stage, not an undocumented second image silently fed to MOSS.
export function buildMossPoseWorkflow(options) {
  validateMossPoseSettings(options);
  const settings = { ...MOSS_POSE_DEFAULTS, ...options };
  const guide = options.references?.find(ref => ref.slot === 'guide' && ref.kind === 'image');
  const identity = options.references?.find(ref => ref.slot === 'identity' && ref.kind === 'image');
  if (!guide?.name) throw new Error('请连接姿势照片或 OpenPose 骨架图。');
  if (!options.prompt?.trim()) throw new Error('请描述要生成的单人角色及场景。');
  const graph = {
    pose_source: { class_type: 'LoadImage', inputs: { image: guide.name } },
    model: { class_type: 'UNETLoader', inputs: { unet_name: MOSS_IMAGE_MODEL.unet, weight_dtype: 'default' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['model', 0], lora_name: MOSS_POSE_LORA, strength_model: settings.poseLoraStrength } },
    text: { class_type: 'CLIPLoader', inputs: { clip_name: MOSS_IMAGE_MODEL.clip, type: 'moss_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: MOSS_IMAGE_MODEL.vae } },
  };
  let pose = ['pose_source', 0];
  if (settings.poseInput === 'photo') {
    graph.skeleton = { class_type: 'H3CheckedDWPose', inputs: { image: pose, resolution: settings.poseResolution, verified_local_weights: 'verified' } };
    pose = ['skeleton', 0];
  } else {
    graph.skeleton_size = { class_type: 'ImageScaleToTotalPixels', inputs: { image: pose, upscale_method: 'lanczos', megapixels: settings.poseResolution ** 2 / 1e6, resolution_steps: 16 } };
    pose = ['skeleton_size', 0];
  }
  Object.assign(graph, {
    size: { class_type: 'GetImageSize', inputs: { image: pose } },
    positive: { class_type: 'TextEncodeMOSSImageEdit', inputs: { clip: ['text', 0], prompt: options.prompt.trim(), edit_format: 'ai-toolkit', 'images.image_0': pose, image_strength: 1, vae: ['vae', 0] } },
    negative: { class_type: 'TextEncodeMOSSImageEdit', inputs: { clip: ['text', 0], prompt: 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact', edit_format: 'ai-toolkit', 'images.image_0': pose, image_strength: 1, vae: ['vae', 0] } },
    latent: { class_type: 'EmptyLatentImage', inputs: { width: ['size', 0], height: ['size', 1], batch_size: 1 } },
    sample: { class_type: 'KSampler', inputs: { model: ['lora', 0], seed: settings.seed, steps: settings.poseSteps, cfg: settings.poseCfg, sampler_name: 'euler', scheduler: 'simple', positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0], denoise: 1 } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
  });
  if (identity) {
    if (!identity.name) throw new Error('角色四视图尚未上传完成。');
    const edit = buildQwen21EditWorkflow({ seed: settings.seed, qwenSteps: 40, qwenRefResolution: 1024, qwenCacheDevice: 'cpu', prompt: '图1定义唯一输出的姿势、肢体位置、画幅、镜头和构图。图2是同一个角色的多视图参考，只定义身份、五官比例、发型及完整穿搭。将图1的人物改成图2的角色，保持图1全身姿势与取景。只输出图1对应的一张单人图片，不输出拼版，不重复人物。', references: [{ kind: 'image', slot: 'guide', name: guide.name }, { kind: 'image', slot: 'identity', name: identity.name }] });
    // Remap every graph link, then wire the decoded pose directly into Qwen.
    // No temporary image export/reload, and no intermediate SaveImage result.
    for (const [id, node] of Object.entries(edit)) {
      if (id === 'source') continue;
      const inputs = Object.fromEntries(Object.entries(node.inputs).map(([key, value]) => [key, Array.isArray(value) && value.length === 2 && Object.hasOwn(edit, value[0]) ? value[0] === 'source' ? ['decode', value[1]] : [`identity_${value[0]}`, value[1]] : value]));
      graph[`identity_${id}`] = { ...node, inputs };
    }
    graph.identity_save.inputs.filename_prefix = 'image/H3_MOSSPose_Identity';
  } else graph.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'image/H3_MOSSPose' } };
  return graph;
}

const choices = schema => Array.isArray(schema?.[0]) ? schema[0] : schema?.[0] === 'COMBO' ? schema[1]?.options : null;

// Read-only validation against the actual connected server. No auto-downloads.
export async function getMossPoseDependencyStatus(graph, fetcher = fetch) {
  const names = [...new Set(Object.values(graph).map(node => node.class_type))];
  const definitions = Object.fromEntries(await Promise.all(names.map(async name => {
    const response = await fetcher(`/api/comfy/object_info/${name}`, { cache: 'no-store' });
    if (response.status === 404) return [name, null];
    if (!response.ok) throw new Error('无法检查 MOSS 姿势依赖，请确认 ComfyUI 在线。');
    return [name, (await response.json())[name]];
  })));
  const missing = names.filter(name => !definitions[name]).map(name => `节点 ${name}`);
  const fields = new Set(['unet_name', 'clip_name', 'vae_name', 'lora_name', 'verified_local_weights']);
  for (const node of Object.values(graph)) {
    const definition = definitions[node.class_type];
    if (!definition) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!fields.has(key)) continue;
      const allowed = choices(definition.input?.required?.[key] || definition.input?.optional?.[key]);
      if (!allowed?.includes(value)) missing.push(key === 'verified_local_weights' ? `DWPose 本地 ONNX 尚未通过 SHA-256 校验，请检查节点安装与两份权重` : `${node.class_type}.${key}: ${value}`);
    }
  }
  return { ready: !missing.length, missing: [...new Set(missing)] };
}
