import assert from 'node:assert/strict';
import { IMAGE_MODEL, IMAGE_LORAS, MOSS_IMAGE_MODEL, QWEN21_EDIT_MODEL, VERSIONED_IMAGE_MODELS } from './src/workbench-api.js';
import { H3_IMAGE_MODEL } from './src/h3-image.js';
import { FLUX3_KLEIN_MODEL } from './src/flux3-klein.js';
import { IMAGE_MODEL_BY_ID, IMAGE_MODELS, modelNodeClasses } from './src/image-model-catalog.js';
import { assessImageModel, clearImageModelInstallCache, readImageModelInstall } from './src/image-model-install.js';
import {
  HISTORY_HALF_LIFE_MS, appendImageReview, classifyImageTask, decayedHistory, historyTerm, planImageModelPick, rankImageModels,
} from './src/image-model-picker.js';

const NOW = Date.parse('2026-11-12T00:00:00.000Z');

function ensure(definitions, name) {
  definitions[name] = definitions[name] || { input: { required: {} } };
  return definitions[name];
}

function addList(definitions, node, input, value) {
  const definition = ensure(definitions, node);
  const bucket = definition.input.required[input] || [[]];
  definition.input.required[input] = bucket;
  const stored = String(value).replaceAll('/', '\\');
  if (!bucket[0].includes(stored)) bucket[0].push(stored);
}

function definitionsFor(ids) {
  const definitions = {};
  for (const id of ids) {
    const model = IMAGE_MODEL_BY_ID[id];
    for (const name of modelNodeClasses(model, { editing: true, hasMask: true, hasMaskCrop: true, hasSourceCrop: true, imageLora: id === 'krea2' ? 'realism' : 'qwen21Realism' })) ensure(definitions, name);
    for (const entry of model.files) {
      const node = entry.loader === 'unet' ? 'UNETLoader' : entry.loader === 'clip' ? 'CLIPLoader' : 'VAELoader';
      const input = entry.loader === 'unet' ? 'unet_name' : entry.loader === 'clip' ? 'clip_name' : 'vae_name';
      addList(definitions, node, input, entry.name);
    }
    addList(definitions, 'CLIPLoader', 'type', model.clipType);
    for (const name of Object.values(model.loras || {})) addList(definitions, 'LoraLoaderModelOnly', 'lora_name', name);
  }
  return definitions;
}

function install(ids) {
  return { offline: false, definitions: definitionsFor(ids) };
}

const ALL = ['krea2', 'moss', 'h3_image', 'flux3_klein', 'standard', 'turbo'];

function pick(extra) {
  return planImageModelPick({ install: install(ALL), history: [], now: NOW, ...extra });
}

assert.deepEqual(IMAGE_MODEL_BY_ID.krea2.files.map((entry) => entry.name), [IMAGE_MODEL.unet, IMAGE_MODEL.clip, IMAGE_MODEL.vae]);
assert.equal(IMAGE_MODEL_BY_ID.moss.files[0].name, MOSS_IMAGE_MODEL.unet);
assert.equal(IMAGE_MODEL_BY_ID.moss.files[1].name, MOSS_IMAGE_MODEL.clip);
assert.equal(IMAGE_MODEL_BY_ID.moss.files[2].name, MOSS_IMAGE_MODEL.vae);
assert.deepEqual(IMAGE_MODEL_BY_ID.h3_image.files.map((entry) => entry.name), [H3_IMAGE_MODEL.unet, H3_IMAGE_MODEL.clip, H3_IMAGE_MODEL.vae]);
assert.deepEqual(IMAGE_MODEL_BY_ID.flux3_klein.files.map((entry) => entry.name), [FLUX3_KLEIN_MODEL.unet, FLUX3_KLEIN_MODEL.clip, FLUX3_KLEIN_MODEL.upsampler, FLUX3_KLEIN_MODEL.vae]);
assert.equal(IMAGE_MODEL_BY_ID.standard.files[0].name, QWEN21_EDIT_MODEL.unet);
assert.equal(IMAGE_MODEL_BY_ID.turbo.files[0].name, VERSIONED_IMAGE_MODELS.qwenTurbo);
assert.equal(IMAGE_MODEL_BY_ID.krea2.loras.realism, IMAGE_LORAS.realism);
assert.equal(IMAGE_MODEL_BY_ID.standard.loras.qwen21Realism, QWEN21_EDIT_MODEL.realismLora);
assert.equal(IMAGE_MODELS.some((model) => model.files.some((entry) => entry.name.includes('fl2va') || entry.name.includes('video_vae'))), false);

assert.equal(classifyImageTask({ mode: 'image', prompt: '一张关卡建筑的环境概念图' }).id, 'env_concept');
assert.equal(classifyImageTask({ mode: 'image', prompt: '二次元角色立绘' }).id, 'anime_character');
assert.equal(classifyImageTask({ mode: 'image', prompt: '海报标题排版' }).id, 'text_layout');
assert.equal(classifyImageTask({ mode: 'qwenEdit', prompt: '把白模截图转成概念图' }).id, 'global_restyle_edit');
assert.equal(classifyImageTask({ mode: 'qwenEdit', prompt: '改风格', referenceCount: 3 }).id, 'multi_ref_compose');
assert.equal(classifyImageTask({ mode: 'qwenEdit', prompt: '随便改一下', hasMask: true }).id, 'local_mask_edit');
assert.equal(classifyImageTask({ mode: 'image', prompt: '画一张椅子' }).id, 'default_image');

{
  const choice = pick({ mode: 'image', data: { mode: 'image', prompt: '雨夜街道的环境概念图' }, prompt: '雨夜街道的环境概念图' });
  assert.equal(choice.model, 'h3_image');
  assert.equal(choice.field, 'imageModel');
  assert.equal(choice.weights.task, 0.6);
  assert.match(choice.announcement, /^自动选了 H3-Image（场景概念 · 已安装/);
}

{
  const partial = pick({ mode: 'image', data: { mode: 'image' }, prompt: '环境概念图', install: install(['flux3_klein', 'krea2', 'moss']) });
  assert.equal(partial.model, 'flux3_klein');
  assert.equal(partial.ranked[0].taskFit, 0.75);
}

{
  const masked = pick({ mode: 'qwenEdit', data: { mode: 'qwenEdit', qwenModel: 'h3_image' }, prompt: '把墙面改成木纹', hasMask: true });
  assert.equal(masked.taskType, 'local_mask_edit');
  assert.equal(masked.model, 'standard');
  assert.deepEqual(masked.ranked.map((item) => item.model), ['standard', 'turbo']);
  const named = pick({ mode: 'qwenEdit', data: { mode: 'qwenEdit' }, prompt: '用 H3 改这块', hasMask: true });
  assert.equal(named.ok, false);
  assert.equal(Object.keys(named.patch).length, 0);
  assert.match(named.error, /不能用于局部遮罩/);
  assert.doesNotMatch(named.error, /自动选了/);
}

{
  const lora = pick({ mode: 'image', data: { mode: 'image', imageLora: 'fantasy' }, prompt: '二次元角色' });
  assert.equal(lora.model, 'krea2');
  assert.equal(lora.ranked.length, 1);
  const realism = pick({ mode: 'qwenEdit', data: { mode: 'qwenEdit', imageLora: 'qwen21Realism' }, prompt: '把衣服改成红裙' });
  assert.equal(realism.taskType, 'anime_to_real');
  assert.deepEqual(realism.ranked.map((item) => item.model), ['standard', 'turbo']);
}

{
  const locked = pick({ mode: 'image', data: { mode: 'image', imageModel: 'krea2', modelLockedByUser: true }, prompt: '环境概念图' });
  assert.equal(locked.ok, true);
  assert.equal(locked.changed, false);
  assert.deepEqual(locked.patch, {});
  assert.equal(locked.model, 'krea2');
  const manual = pick({ mode: 'image', data: { mode: 'image', imageModel: 'krea2' }, prompt: '环境概念图', requestedModel: 'moss' });
  assert.equal(manual.model, 'moss');
  assert.equal(manual.patch.modelLockedByUser, true);
  assert.equal(manual.patch.imageModel, 'moss');
  const spoken = pick({ mode: 'image', data: { mode: 'image' }, prompt: '用 Klein 画一张环境概念图' });
  assert.equal(spoken.model, 'flux3_klein');
  assert.equal(spoken.patch.modelLockedByUser, true);
}

{
  const missing = pick({
    mode: 'image', data: { mode: 'image', imageModel: 'krea2' }, prompt: '用 H3 画环境',
    install: install(['krea2', 'moss', 'flux3_klein']),
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.patch, {});
  assert.match(missing.error, /minimax_h3_image_pruned_int8_convrot\.safetensors/);
  assert.match(missing.error, /没有换成别的模型/);
  assert.equal(missing.model, undefined);
}

{
  const fresh = decayedHistory([{ model: 'krea2', taskType: 'env_concept', accepted: true, time: new Date(NOW).toISOString() }], 'krea2', 'env_concept', NOW);
  const aged = decayedHistory([{ model: 'krea2', taskType: 'env_concept', accepted: true, time: new Date(NOW - HISTORY_HALF_LIFE_MS).toISOString() }], 'krea2', 'env_concept', NOW);
  assert.ok(Math.abs(fresh.n - 1) < 1e-9);
  assert.ok(Math.abs(aged.n - 0.5) < 1e-6);
  assert.ok(historyTerm(aged) < historyTerm(fresh) / 2);
  const one = appendImageReview([], {
    model: 'krea2', field: 'imageModel', taskType: 'env_concept', accepted: true, time: new Date(NOW).toISOString(), nodeId: 'g1', resultKey: 'r1',
  }, NOW);
  const barely = pick({ mode: 'image', data: { mode: 'image' }, prompt: '环境概念图', history: one });
  assert.equal(barely.model, 'h3_image');
  const many = [];
  for (let index = 0; index < 20; index += 1) {
    many.push({ model: 'krea2', taskType: 'env_concept', accepted: true, time: new Date(NOW).toISOString() });
    many.push({ model: 'h3_image', taskType: 'env_concept', accepted: false, time: new Date(NOW).toISOString() });
  }
  const moved = rankImageModels({ task: classifyImageTask({ mode: 'image', prompt: '环境概念图' }), eligible: ALL, history: many, prompt: '环境概念图', now: NOW });
  assert.equal(moved[0].model, 'krea2');
  const replaced = appendImageReview(one, { ...one[0], accepted: false, time: new Date(NOW).toISOString() }, NOW);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].accepted, false);
}

{
  const plain = pick({ mode: 'image', data: { mode: 'image' }, prompt: '环境概念图' });
  const rushed = pick({ mode: 'image', data: { mode: 'image' }, prompt: '快速画一张环境概念草图，多来几张' });
  assert.equal(plain.model, 'h3_image');
  assert.equal(plain.weights.speed, 0.1);
  assert.equal(rushed.taskType, 'env_concept');
  assert.deepEqual(rushed.weights, { task: 0.4, history: 0.3, speed: 0.3 });
  assert.equal(rushed.model, 'krea2');
  const sketch = pick({ mode: 'image', data: { mode: 'image' }, prompt: '先看看草图' });
  assert.equal(sketch.taskType, 'fast_ideation');
  assert.equal(sketch.model, 'krea2');
}

{
  const slash = definitionsFor(['moss']);
  const listed = slash.UNETLoader.input.required.unet_name[0][0].replaceAll('\\', '/');
  slash.UNETLoader.input.required.unet_name[0][0] = listed;
  assert.equal(assessImageModel(IMAGE_MODEL_BY_ID.moss, slash, {}).ready, true);
  delete slash.CLIPLoader.input.required.type[0][slash.CLIPLoader.input.required.type[0].indexOf('moss_image')];
  const withoutType = assessImageModel(IMAGE_MODEL_BY_ID.moss, slash, {});
  assert.equal(withoutType.ready, false);
  assert.ok(withoutType.missing.some((item) => item.includes('moss_image')));
}

{
  clearImageModelInstallCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const name = decodeURIComponent(url.split('/').at(-1));
    return { ok: true, status: 200, json: async () => ({ [name]: { input: { required: {} } } }) };
  };
  const first = await readImageModelInstall({ fetchImpl, now: NOW, origin: '/api/comfy' });
  const second = await readImageModelInstall({ fetchImpl, now: NOW + 1000, origin: '/api/comfy' });
  assert.equal(first.offline, false);
  assert.equal(second, first);
  assert.ok(calls > 0);
  const refreshed = await readImageModelInstall({ fetchImpl, now: NOW + 61_000, origin: '/api/comfy' });
  assert.notEqual(refreshed, first);
  const failedCalls = calls;
  await readImageModelInstall({ fetchImpl: async () => { throw new Error('down'); }, now: NOW + 122_000, fresh: true });
  assert.equal(calls, failedCalls);
  clearImageModelInstallCache();
}

console.log('IMAGE_MODEL_PICKER_OK');
