import { inspectionQuery } from './workflow-inspector.js';

export function comparisonImage(projectId, node, edges) {
  const data = node?.data;
  if (!data) return null;
  const generator = node.type === 'generator';
  if (!generator && (node.type !== 'media' || (data.kind || 'image') !== 'image' || data.mediaRole === 'mask')) return null;
  const url = generator ? data.resultUrl : data.url;
  if (!url) return null;
  const promptId = generator && data.status === 'done' ? data.promptId : !generator ? data.sourcePromptId : null;
  const query = promptId ? { ...inspectionQuery(projectId, node, edges), promptId } : null;
  return { id: node.id, url, title: data.title || data.name || '图片', name: data.name, query };
}

export function inspectionStage(record, query) {
  if (!record || record.projectId !== query.projectId || (query.jobId && query.jobId !== record.jobId)
    || (query.nodeId && query.nodeId !== record.nodeId)) return null;
  return record.stages?.find((stage) => stage.promptId === query.promptId && stage.graph) || null;
}

function originalFile(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const annotation = name.match(/\s+\[(input|output|temp)\]$/);
  const type = annotation?.[1] || 'input';
  const path = annotation ? name.slice(0, annotation.index) : name;
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || ['.', '..'].includes(part) || /[:\u0000-\u001F]/.test(part))) return null;
  const filename = parts.pop();
  return '/api/comfy/view?' + new URLSearchParams({ filename, subfolder: parts.join('/'), type });
}

function resolveInput(graph, link) {
  const node = Array.isArray(link) ? graph[link[0]] : null;
  const info = node?.inputs || {};
  const crop = node?.class_type === 'ImageCrop'
    ? Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, info[key]])) : null;
  if (crop && (!Object.values(crop).every(Number.isInteger) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0)) {
    return { reason: '裁切坐标未记录' };
  }
  const loadLink = crop ? info.image : link;
  const load = Array.isArray(loadLink) ? graph[loadLink[0]] : null;
  if (load?.class_type !== 'LoadImage') return { reason: '来源或前处理无法从记录还原' };
  const name = load.inputs?.image;
  const url = originalFile(name);
  return { name, url, crop, reason: url ? null : '原图路径不可用' };
}

function describeInputs(graph) {
  const nodes = Object.entries(graph);
  const encoders = nodes.filter(([, node]) => ['TextEncodeQwenImage21', 'MiniMaxH3ImageConditioning', 'ReferenceMultiLatent'].includes(node.class_type));
  if (encoders.length === 1) {
    const encoder = encoders[0][1];
    const ports = encoder.class_type === 'ReferenceMultiLatent' ? /^images\.image(\d+)$/ : /^images\.image_(\d+)$/;
    const offset = encoder.class_type === 'ReferenceMultiLatent' ? 1 : 0;
    return Object.entries(encoder.inputs || {})
      .flatMap(([name, link]) => {
        const match = name.match(ports);
        return match ? [{ order: Number(match[1]) + offset, ...resolveInput(graph, link) }] : [];
      })
      .sort((a, b) => a.order - b.order);
  }
  const loads = nodes.filter(([, node]) => node.class_type === 'LoadImage');
  // The loader's file is factual. Its semantic role or any later transform is not.
  return loads.map(([id], index) => ({
    order: null, id: index, ...resolveInput(graph, [id, 0]),
    ...(loads.length === 1 ? {} : { url: null, reason: '记录未确定输入次序或作用' }),
  }));
}

const present = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const distinct = (values) => [...new Set(values.filter(present).map((value) => value === '' ? '（空）' : value))];

export function describeImageStage(stage) {
  if (!stage?.graph) return null;
  const graph = stage.graph;
  const nodes = Object.values(graph);
  const inputs = describeInputs(graph);
  const values = (...fields) => distinct(nodes.flatMap((node) => fields.map((field) => node.inputs?.[field])));
  const from = (classes, field) => distinct(nodes.filter((node) => classes.includes(node.class_type)).map((node) => node.inputs?.[field]));
  const samplers = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'];
  const positive = from(['TextEncodeQwenImage21', 'MiniMaxH3ImageConditioning'], 'prompt');
  const negative = from(['TextEncodeQwenImage21'], 'negative_prompt');
  for (const node of nodes.filter((item) => samplers.includes(item.class_type) || item.class_type === 'CFGGuider')) {
    for (const [key, list] of [['positive', positive], ['negative', negative]]) {
      const link = node.inputs?.[key];
      const encoder = Array.isArray(link) ? graph[link[0]] : null;
      if (encoder?.class_type === 'CLIPTextEncode') list.push(...distinct([encoder.inputs?.text]));
      if (key === 'negative' && encoder?.class_type === 'ConditioningZeroOut') list.push('ConditioningZeroOut');
    }
  }
  const loras = nodes.filter((node) => node.class_type.startsWith('LoraLoader') && typeof node.inputs?.lora_name === 'string')
    .map(({ inputs: fields }) => [fields.lora_name, ...[fields.strength_model, fields.strength_clip].filter(present)].join(' · '));
  const orderKnown = inputs.length > 0 && inputs.every(({ order }) => order !== null);
  const steps = from([...samplers, 'BasicScheduler'], 'steps');
  if (!steps.length) {
    for (const sampler of nodes.filter((node) => node.class_type === 'SamplerCustomAdvanced')) {
      const link = sampler.inputs?.sigmas;
      const schedule = Array.isArray(link) ? graph[link[0]] : null;
      if (schedule?.class_type !== 'ManualSigmas' || typeof schedule.inputs?.sigmas !== 'string') continue;
      const entries = schedule.inputs.sigmas.split(',').map((entry) => entry.trim());
      if (entries.length > 1 && entries.every((entry) => entry && Number.isFinite(Number(entry)))) steps.push(entries.length - 1);
    }
  }
  const scheduler = values('scheduler');
  if (!scheduler.length && nodes.some((node) => node.class_type === 'ManualSigmas')) scheduler.push('ManualSigmas');
  return {
    provenance: stage.provenance, inputs,
    fields: {
      weights: values('unet_name', 'ckpt_name', 'model_name'),
      loras: distinct(loras),
      seed: values('seed', 'noise_seed').filter((value) => typeof value !== 'number' || Number.isSafeInteger(value)),
      steps: distinct(steps),
      sampler: values('sampler_name'),
      scheduler,
      cfg: values('cfg'),
      referenceSize: [...from(['TextEncodeQwenImage21'], 'resolution'),
        ...from(['ReferenceMultiLatent'], 'resolution.megapixels').map((value) => value + ' MP')],
      order: orderKnown ? inputs.map(({ order, name, crop }) => '图' + order + ' · ' + (name || '文件未知')
        + (crop ? ' · 裁切 ' + [crop.x, crop.y, crop.width, crop.height].join(', ') : '')) : [],
      promptInput: from(['TextGenerate'], 'prompt'),
      positive: distinct(positive),
      negative: distinct(negative),
    },
  };
}

export const COMPARISON_FIELDS = [
  ['size', '原图像素'], ['weights', '模型权重文件'], ['weightHash', '权重校验值'],
  ['loras', 'LoRA 文件与强度'], ['seed', '种子'], ['steps', '步数'],
  ['sampler', '采样器'], ['scheduler', '调度器'], ['cfg', 'CFG'],
  ['referenceSize', '参考编码分辨率'], ['order', '参考输入顺序'],
  ['promptInput', '扩写输入'], ['positive', '采样正向提示词'], ['negative', '负向提示词'],
];

export function parameterDifference(left, right) {
  if (!left?.length || !right?.length) return 'unknown';
  return JSON.stringify(left) === JSON.stringify(right) ? 'same' : 'different';
}

export function imageFit(viewport, sizes) {
  const width = Math.max(1, ...sizes.map((size) => size?.width || 0));
  const height = Math.max(1, ...sizes.map((size) => size?.height || 0));
  const scale = Math.min(1, viewport.width / width, viewport.height / height) || 1;
  return { scale, x: width / 2, y: height / 2 };
}

export function zoomImageView(view, scale, offsetX = 0, offsetY = 0) {
  return { scale, x: view.x + offsetX * (1 / view.scale - 1 / scale), y: view.y + offsetY * (1 / view.scale - 1 / scale) };
}
