import {
  IMAGE_MODEL_BY_ID, IMAGE_MODEL_FIELDS, IMAGE_TASK_BY_ID, KREA_STYLE_LORAS, SCORE_WEIGHTS, TASK_FIT,
} from './image-model-catalog.js';
import { assessImageModels } from './image-model-install.js';

export const HISTORY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
export const IMAGE_HISTORY_LIMIT = 400;
export const IMAGE_HISTORY_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

const MODEL_ALIASES = Object.freeze([
  { id: 'h3_image', pattern: /(?:minimax\s*)?h3(?:\s*[-_]?\s*image)?/i },
  { id: 'flux3_klein', pattern: /flux\s*[-_ ]?3(?:\s*[-_ ]?(?:image\s*)?klein)?|\bklein\b/i },
  { id: 'moss', pattern: /\bmoss\b/i },
  { id: 'krea2', pattern: /krea\s*[-_ ]?2(?!\s*identity)|muse\s*v?3(?:\.0)?(?:\s*turbo)?/i },
  { id: 'turbo', pattern: /qwen(?:\s*[-_ ]?image)?(?:\s*2(?:\.1)?)?\s*turbo|\bqwen\s*turbo\b/i },
  { id: 'standard', pattern: /qwen(?:\s*[-_ ]?image)?(?:\s*2(?:\.1)?)?\s*(?:标准版|标准|standard)/i },
]);

const CHOICE_BEFORE = /(?:用|换用|换成|改用|改成|切换(?:到|成)?|选择|指定)\s*$/;
const NEGATED_BEFORE = /(?:不要|别用|不用|勿用|别)\s*$/;

export function imageModelLabel(modelId) {
  return IMAGE_MODEL_BY_ID[modelId]?.label || String(modelId || '');
}

export function hasSpeedCue(prompt = '') {
  return /快速|草图|多来几张|先看看|批量|出几张|多来几|草稿/.test(String(prompt || ''));
}

export function scoreWeights(prompt) {
  return hasSpeedCue(prompt) ? SCORE_WEIGHTS.speed : SCORE_WEIGHTS.base;
}

export function classifyImageTask({
  mode, prompt = '', referenceCount = 0, hasMask = false, hasSourceCrop = false, hasMaskCrop = false,
  imageLora, flux3Resolution, h3ImageResolution,
} = {}) {
  const text = String(prompt || '');
  if (mode === 'qwenEdit') {
    if (hasMask || hasSourceCrop || hasMaskCrop) return IMAGE_TASK_BY_ID.local_mask_edit;
    if (imageLora === 'qwen21Realism' || /漫转真|转真人|转成真人|变成真人/.test(text)) return IMAGE_TASK_BY_ID.anime_to_real;
    if (/改字|改文字|替换.{0,6}文字|图中文字|标题改/.test(text)) return IMAGE_TASK_BY_ID.text_edit;
    if (referenceCount >= 2 || /放进|多参考|合成/.test(text)) return IMAGE_TASK_BY_ID.multi_ref_compose;
    if (/保持身份|保持人物|换表情|同一人|换装/.test(text)) return IMAGE_TASK_BY_ID.identity_keep_edit;
    if (/改风格|换风格|材质|白模|地编|转概念|概念图/.test(text)) return IMAGE_TASK_BY_ID.global_restyle_edit;
    if (hasSpeedCue(text)) return IMAGE_TASK_BY_ID.fast_edit_preview;
    return IMAGE_TASK_BY_ID.default_edit;
  }
  if (mode !== 'image') return null;
  if (/海报|排版|标题字|界面设计|图中文字|中文文字|写上.{0,4}字|\bUI\b/.test(text)) return IMAGE_TASK_BY_ID.text_layout;
  if (/二次元|动漫|漫画风|日漫/.test(text)) return IMAGE_TASK_BY_ID.anime_character;
  if (/写实人物|写实人像|肖像|人像|写真/.test(text)) return IMAGE_TASK_BY_ID.photoreal_people;
  if (/水彩|绘画风格|风格化|复古动漫|奇幻现实|油画|工笔/.test(text)) return IMAGE_TASK_BY_ID.style_exploration;
  if (/场景|地编|环境|关卡|建筑|白模|概念图/.test(text)) return IMAGE_TASK_BY_ID.env_concept;
  if (/4K|16\s*MP|超高清|超高分辨率|大幅/.test(text) || flux3Resolution === '4K' || h3ImageResolution === '16MP') return IMAGE_TASK_BY_ID.ultra_hires;
  if (hasSpeedCue(text)) return IMAGE_TASK_BY_ID.fast_ideation;
  return IMAGE_TASK_BY_ID.default_image;
}

export function namedModelsInPrompt(prompt = '') {
  const text = String(prompt || '');
  const found = [];
  for (const alias of MODEL_ALIASES) {
    const expression = new RegExp(alias.pattern.source, 'ig');
    let match;
    while ((match = expression.exec(text))) {
      const before = text.slice(Math.max(0, match.index - 12), match.index);
      if (NEGATED_BEFORE.test(before) || !CHOICE_BEFORE.test(before)) continue;
      found.push(alias.id);
      break;
    }
  }
  return [...new Set(found)];
}

export function resolveModelToken(token) {
  const text = String(token || '').trim();
  if (!text) return null;
  if (IMAGE_MODEL_BY_ID[text]) return text;
  const hits = [...new Set(MODEL_ALIASES.filter((alias) => alias.pattern.test(text)).map((alias) => alias.id))];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ambiguous: hits };
  return null;
}

export function taskFit(order, modelId) {
  const index = order.indexOf(modelId);
  return index < 0 ? 0 : TASK_FIT[index] ?? 0;
}

export function decayedHistory(history, modelId, taskType, now = Date.now()) {
  let accept = 0;
  let reject = 0;
  let n = 0;
  for (const record of history || []) {
    if (record?.model !== modelId || record?.taskType !== taskType || typeof record.accepted !== 'boolean') continue;
    const at = Date.parse(record.time);
    if (Number.isNaN(at)) continue;
    const weight = 0.5 ** (Math.max(0, now - at) / HISTORY_HALF_LIFE_MS);
    n += weight;
    if (record.accepted) accept += weight;
    else reject += weight;
  }
  return { accept, reject, n };
}

export function historyTerm(counts) {
  const accept = counts?.accept || 0;
  const reject = counts?.reject || 0;
  const samples = counts?.n || 0;
  const raw = (accept + 1) / (accept + reject + 2) - 0.5;
  return Math.min(1, samples / 5) * raw;
}

export function rankImageModels({ task, eligible, history, prompt, now = Date.now() }) {
  const weights = scoreWeights(prompt);
  const allowed = new Set(eligible);
  const ranked = task.order
    .filter((modelId) => allowed.has(modelId))
    .map((modelId) => {
      const counts = decayedHistory(history, modelId, task.id, now);
      const fit = taskFit(task.order, modelId);
      const historyScore = historyTerm(counts);
      const speed = IMAGE_MODEL_BY_ID[modelId].speed;
      return {
        model: modelId,
        score: weights.task * fit + weights.history * historyScore + weights.speed * speed,
        taskFit: fit,
        history: historyScore,
        speed,
        counts,
        weights,
      };
    });
  ranked.sort((left, right) => {
    const delta = right.score - left.score;
    if (Math.abs(delta) > 1e-9) return delta;
    return task.order.indexOf(left.model) - task.order.indexOf(right.model);
  });
  return ranked;
}

function fieldForMode(mode) {
  if (mode === 'image') return 'imageModel';
  if (mode === 'qwenEdit') return 'qwenModel';
  return null;
}

function compatibleIds(field, task, context, { explicit = false } = {}) {
  let ids = IMAGE_MODEL_FIELDS[field].filter((modelId) => !task.hardOnly || task.order.includes(modelId));
  if (field === 'qwenModel' && (context.hasMask || context.hasSourceCrop || context.hasMaskCrop)) {
    ids = ids.filter((modelId) => modelId === 'standard' || modelId === 'turbo');
  }
  if (!explicit && field === 'imageModel' && KREA_STYLE_LORAS.includes(context.imageLora)) ids = ids.filter((modelId) => modelId === 'krea2');
  if (!explicit && field === 'qwenModel' && context.imageLora === 'qwen21Realism') ids = ids.filter((modelId) => modelId === 'standard' || modelId === 'turbo');
  return ids;
}

function clearsLora(modelId, imageLora) {
  if (!imageLora || imageLora === 'none') return false;
  if (KREA_STYLE_LORAS.includes(imageLora)) return modelId !== 'krea2';
  if (imageLora === 'qwen21Realism') return modelId === 'h3_image' || modelId === 'flux3_klein';
  return modelId === 'h3_image' || modelId === 'flux3_klein';
}

function announcement({ explicit, modelId, task, counts }) {
  const kept = counts.accept >= 0.5 ? ` · 你上次收下了 ${Math.round(counts.accept)} 张` : counts.reject >= 0.5 && counts.accept < 0.5 ? ' · 最近多半否掉了' : '';
  const verb = explicit ? '按你的选择用了' : '自动选了';
  return `${verb} ${imageModelLabel(modelId)}（${task.label} · 已安装${kept}）`;
}

function unavailableError(task, ready, ids) {
  const lines = ids.map((modelId) => {
    const missing = ready[modelId]?.missing || ['未能确认安装状态'];
    return `${imageModelLabel(modelId)} 还缺少：${missing.join('、')}`;
  });
  return `${task.label}可用的模型都还没装好，下拉未改。${lines.join('。')}。`;
}

function explicitModelError(modelId, context) {
  const model = IMAGE_MODEL_BY_ID[modelId];
  const field = fieldForMode(context.mode);
  if (!model || !field) return '这个节点没有文生图或图生图模型下拉。下拉未改。';
  if (!model.fields.includes(field)) {
    const where = model.fields.includes('imageModel') ? '文生图' : '图生图';
    return `${model.label}只在${where}的模型下拉里。下拉未改，也没有换成别的模型。`;
  }
  if (field === 'qwenModel' && (context.hasMask || context.hasSourceCrop || context.hasMaskCrop) && modelId !== 'standard' && modelId !== 'turbo') {
    return `${model.label}不能用于局部遮罩或单格裁切。下拉未改。`;
  }
  return null;
}

function selectionPatch(field, modelId, task, note, { lock, imageLora }) {
  return {
    [field]: modelId,
    imageTaskType: task.id,
    modelPickNote: note,
    ...(lock ? { modelLockedByUser: true } : {}),
    ...(clearsLora(modelId, imageLora) ? { imageLora: 'none' } : {}),
  };
}

export function planImageModelPick({
  data = {}, mode, prompt, referenceCount = 0, hasMask = false, hasSourceCrop = false, hasMaskCrop = false,
  install, history = [], now = Date.now(), requestedModel,
} = {}) {
  const activeMode = mode || data.mode;
  const field = fieldForMode(activeMode);
  if (!field) return { ok: false, error: '自动选模只用于文生图或图生图节点。', patch: {} };
  const text = prompt === undefined ? data.prompt || '' : prompt;
  const context = {
    mode: activeMode,
    prompt: text,
    referenceCount,
    hasMask: Boolean(hasMask),
    hasSourceCrop: Boolean(hasSourceCrop || data.qwenSourceCrop),
    hasMaskCrop: Boolean(hasMaskCrop || data.qwenMaskCrop),
    imageLora: data.imageLora || 'none',
    flux3Resolution: data.flux3Resolution,
    h3ImageResolution: data.h3ImageResolution,
  };
  const task = classifyImageTask({ ...context, prompt: text });
  const named = requestedModel ? null : namedModelsInPrompt(text);
  let explicitId = null;
  if (requestedModel) {
    const resolved = resolveModelToken(requestedModel);
    if (!resolved) return { ok: false, error: `不认识的图像模型：${requestedModel}。下拉未改。`, patch: {} };
    if (resolved.ambiguous) return { ok: false, error: '这个模型名称对应多个选项，请指定 Krea2、MOSS、H3-Image、FLUX 3 Klein、Qwen 标准版或 Qwen Turbo。下拉未改。', patch: {} };
    explicitId = resolved;
  } else if (named?.length > 1) {
    return { ok: false, error: '提示里点了多个模型，请只指定一个。下拉未改。', patch: {} };
  } else if (named?.length === 1) explicitId = named[0];
  else if (/muse\s*v?4/i.test(text) && CHOICE_BEFORE.test(text.slice(Math.max(0, text.search(/muse\s*v?4/i) - 12), text.search(/muse\s*v?4/i)))) {
    return { ok: false, error: 'Muse V4 只用于四视图换装，不在文生图或图生图下拉里。下拉未改。', patch: {} };
  }

  const offline = !install || install.offline || !install.definitions;
  if (explicitId) {
    const blocked = explicitModelError(explicitId, context);
    if (blocked) return { ok: false, error: blocked, patch: {} };
    if (offline) return { ok: false, error: '画布连接的 ComfyUI 目前读不到模型列表。下拉未改，也没有换成别的模型。', patch: {} };
    const status = assessImageModels(install.definitions, context)[explicitId];
    if (!status?.ready) return { ok: false, error: `${imageModelLabel(explicitId)} 还缺少：${status.missing.join('、')}。没有换成别的模型。`, patch: {} };
    const counts = decayedHistory(history, explicitId, task.id, now);
    const note = announcement({ explicit: true, modelId: explicitId, task, counts });
    const patch = selectionPatch(field, explicitId, task, note, { lock: true, imageLora: context.imageLora });
    return { ok: true, explicit: true, locked: true, changed: data[field] !== explicitId || !data.modelLockedByUser, field, model: explicitId, taskType: task.id, announcement: note, patch };
  }

  if (data.modelLockedByUser) {
    const current = data[field] || IMAGE_MODEL_FIELDS[field][0];
    if (!offline) {
      const status = assessImageModels(install.definitions, context)[current];
      if (status && !status.ready) return { ok: false, error: `${imageModelLabel(current)} 还缺少：${status.missing.join('、')}。没有换成别的模型。`, patch: {} };
    }
    return { ok: true, locked: true, changed: false, offline, field, model: current, taskType: data.imageTaskType || task.id, announcement: data.modelPickNote || null, patch: {} };
  }

  if (offline) return { ok: true, offline: true, changed: false, field, model: data[field] || null, taskType: task.id, announcement: null, patch: {} };

  const ready = assessImageModels(install.definitions, context);
  const allowed = compatibleIds(field, task, context);
  const ranked = rankImageModels({
    task, eligible: allowed.filter((modelId) => ready[modelId]?.ready), history, prompt: text, now,
  });
  if (!ranked.length) return { ok: false, error: unavailableError(task, ready, allowed), patch: {} };
  const winner = ranked[0];
  const note = announcement({ explicit: false, modelId: winner.model, task, counts: winner.counts });
  const patch = selectionPatch(field, winner.model, task, note, { lock: false, imageLora: context.imageLora });
  return {
    ok: true, explicit: false, locked: false, changed: data[field] !== winner.model, field, model: winner.model,
    taskType: task.id, announcement: note, patch, ranked, weights: winner.weights,
  };
}

export function normalizeImageHistory(value, now = Date.now()) {
  if (!Array.isArray(value)) return [];
  const tasks = new Set(Object.keys(IMAGE_TASK_BY_ID));
  return value.filter((record) => {
    if (!record || typeof record !== 'object') return false;
    if (!IMAGE_MODEL_BY_ID[record.model] || !tasks.has(record.taskType)) return false;
    if (typeof record.accepted !== 'boolean') return false;
    if (!['imageModel', 'qwenModel'].includes(record.field)) return false;
    if (typeof record.nodeId !== 'string' || !record.nodeId) return false;
    if (typeof record.resultKey !== 'string' || !record.resultKey) return false;
    const at = Date.parse(record.time);
    return !Number.isNaN(at) && now - at <= IMAGE_HISTORY_MAX_AGE_MS;
  }).slice(-IMAGE_HISTORY_LIMIT);
}

export function appendImageReview(history, record, now = Date.now()) {
  const next = normalizeImageHistory(history, now).filter((item) => item.nodeId !== record.nodeId || item.resultKey !== record.resultKey);
  next.push(record);
  return normalizeImageHistory(next, now);
}

export function imageResultKey(data = {}) {
  return String(data.promptId || data.queueJobId || data.resultUrl || '');
}

export function createImageReview(data, accepted, resultKey, nodeId, now = new Date()) {
  const field = data.mode === 'image' ? 'imageModel' : 'qwenModel';
  const model = data[field] || IMAGE_MODEL_FIELDS[field][0];
  const taskType = data.imageTaskType || (field === 'imageModel' ? 'default_image' : 'default_edit');
  return {
    model, field, taskType, accepted: Boolean(accepted), time: now.toISOString(), nodeId, resultKey,
  };
}
