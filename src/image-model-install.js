import { IMAGE_MODELS, IMAGE_MODEL_BY_ID, allInstallNodeClasses, modelNodeClasses } from './image-model-catalog.js';

const CACHE_MS = 60_000;
let cache = null;

export function clearImageModelInstallCache() {
  cache = null;
}

export function modelPathKey(value) {
  return String(value || '').replaceAll('\\', '/');
}

function listed(available, filename) {
  if (!Array.isArray(available)) return false;
  const target = modelPathKey(filename);
  return available.some((item) => modelPathKey(item) === target);
}

function loaderList(definition, input) {
  return definition?.input?.required?.[input]?.[0];
}

export function assessImageModel(model, definitions, context = {}) {
  const missing = [];
  const nodes = modelNodeClasses(model, context);
  for (const name of nodes) {
    if (!definitions?.[name]) missing.push(`ComfyUI 节点 ${name}`);
  }
  const unet = loaderList(definitions?.UNETLoader, 'unet_name');
  const clip = loaderList(definitions?.CLIPLoader, 'clip_name');
  const vae = loaderList(definitions?.VAELoader, 'vae_name');
  const loras = loaderList(definitions?.LoraLoaderModelOnly, 'lora_name');
  for (const entry of model.files) {
    const list = entry.loader === 'unet' ? unet : entry.loader === 'clip' ? clip : vae;
    if (!listed(list, entry.name)) missing.push(modelPathKey(entry.name));
  }
  const clipTypes = loaderList(definitions?.CLIPLoader, 'type');
  if (!Array.isArray(clipTypes) || !clipTypes.includes(model.clipType)) missing.push(`ComfyUI 的 ${model.clipType} 文本编码器支持`);
  const loraName = context.imageLora && context.imageLora !== 'none' ? model.loras?.[context.imageLora] : null;
  if (loraName && !listed(loras, loraName)) missing.push(modelPathKey(loraName));
  return { ready: missing.length === 0, missing };
}

export function assessImageModels(definitions, context = {}) {
  const editing = context.mode === 'qwenEdit';
  const shared = {
    editing,
    hasMask: Boolean(context.hasMask),
    hasMaskCrop: Boolean(context.hasMaskCrop),
    hasSourceCrop: Boolean(context.hasSourceCrop),
  };
  return Object.fromEntries(IMAGE_MODELS.map((model) => {
    const imageLora = model.loras?.[context.imageLora] ? context.imageLora : undefined;
    return [model.id, assessImageModel(model, definitions, { ...shared, imageLora })];
  }));
}

export async function readImageModelInstall({ fetchImpl = globalThis.fetch, now = Date.now(), origin = '/api/comfy', fresh = false } = {}) {
  if (!fresh && cache && cache.origin === origin && now - cache.at < CACHE_MS) return cache.value;
  const definitions = {};
  try {
    const rows = await Promise.all(allInstallNodeClasses().map(async (name) => {
      const response = await fetchImpl(`${origin}/object_info/${encodeURIComponent(name)}`);
      if (response.status === 404) return [name, null];
      if (!response.ok) throw new Error('offline');
      const body = await response.json();
      return [name, body?.[name] ?? null];
    }));
    for (const [name, value] of rows) definitions[name] = value;
  } catch {
    const value = { offline: true, definitions: null };
    cache = { at: now, origin, value };
    return value;
  }
  const value = { offline: false, definitions };
  cache = { at: now, origin, value };
  return value;
}

export function installStatus(install, modelId, context) {
  if (!install || install.offline || !install.definitions) return { ready: false, missing: ['画布连接的 ComfyUI 模型列表'], offline: true };
  const model = IMAGE_MODEL_BY_ID[modelId];
  if (!model) return { ready: false, missing: [`未知图像模型 ${modelId}`] };
  return assessImageModel(model, install.definitions, {
    editing: context.mode === 'qwenEdit',
    hasMask: Boolean(context.hasMask),
    hasMaskCrop: Boolean(context.hasMaskCrop),
    hasSourceCrop: Boolean(context.hasSourceCrop),
    imageLora: model.loras?.[context.imageLora] ? context.imageLora : undefined,
  });
}
