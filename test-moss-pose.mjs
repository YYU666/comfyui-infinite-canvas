import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMossPoseWorkflow, getMossPoseDependencyStatus } from './src/moss-pose.js';
import { nodeModelPaths } from './src/model-licenses.js';
import { planCanvasConnection } from './src/canvas-connections.js';

const options = { seed: 42, prompt: 'One person in a studio', references: [{ slot: 'guide', kind: 'image', name: 'pose.png' }] };
const categories = { unet_name: 'diffusion_models', clip_name: 'text_encoders', vae_name: 'vae', lora_name: 'loras' };

test('author skeleton recipe and local encoder quant are explicit; no hidden downloads', () => {
  const graph = buildMossPoseWorkflow(options);
  assert.equal(graph.skeleton.class_type, 'H3CheckedDWPose');
  assert.equal(graph.text.inputs.clip_name, 'qwen3.5_9b_int8_convrot.safetensors');
  assert.equal(graph.sample.inputs.steps, 30);
  assert.equal(graph.sample.inputs.cfg, 4);
  assert.equal(graph.sample.inputs.seed, 42);
  assert.equal(graph.positive.inputs.edit_format, 'ai-toolkit');
  assert.deepEqual(graph.positive.inputs['images.image_0'], ['skeleton', 0]);
  assert.deepEqual(graph.latent.inputs.width, ['size', 0]);
});

test('prepared skeleton skips DWPose and missing identity adds no Qwen', () => {
  const graph = buildMossPoseWorkflow({ ...options, poseInput: 'skeleton' });
  assert.ok(!graph.skeleton);
  assert.ok(!Object.values(graph).some(node => node.class_type === 'TextEncodeQwenImage21'));
  for (const poseInput of ['skeleton', 'photo']) assert.ok(nodeModelPaths({ mode: 'mossPose', poseInput }).every(path => path.endsWith('.safetensors') || path.endsWith('.gguf')), 'ONNX auxiliaries stay outside downloadable model inventory');
});

test('identity is a connected Qwen second stage with one final SaveImage and complete references', () => {
  const graph = buildMossPoseWorkflow({ ...options, references: [...options.references, { slot: 'identity', kind: 'image', name: 'sheet.png' }] });
  assert.deepEqual(graph.identity_encode.inputs['images.image_1'], ['decode', 0]);
  assert.deepEqual(graph.identity_encode.inputs['images.image_2'], ['identity_makeup', 0]);
  assert.equal(graph.identity_makeup.inputs.image, 'sheet.png');
  assert.equal(Object.values(graph).filter(node => node.class_type === 'SaveImage').length, 1);
  const actual = Object.values(graph).flatMap(node => Object.entries(node.inputs).filter(([key]) => categories[key]).map(([key, value]) => `${categories[key]}/${value}`.replaceAll('\\', '/')));
  assert.deepEqual(nodeModelPaths({ mode: 'mossPose', poseInput: 'skeleton', poseHasIdentity: true }).sort(), [...new Set(actual)].sort());
  // Detect orphan links and cycles after prefixing the existing Qwen graph.
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    assert.ok(graph[id], `missing link ${id}`);
    assert.ok(!visiting.has(id), `cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const value of Object.values(graph[id].inputs)) if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number') visit(value[0]);
    visiting.delete(id); visited.add(id);
  }
  visit('identity_save');
  for (const id of Object.keys(graph)) assert.ok(visited.has(id), `unused node ${id}`);
});

test('bad settings and missing pose fail before enqueue', () => {
  for (const patch of [{ seed: NaN }, { poseSteps: 0 }, { poseCfg: 20 }, { poseLoraStrength: -1 }, { poseInput: 'unknown' }, { poseResolution: 9000 }, { references: [] }]) assert.throws(() => buildMossPoseWorkflow({ ...options, ...patch }));
});

test('dependency checker handles V3 COMBO and rejects missing ONNX instead of substituting', async () => {
  const graph = buildMossPoseWorkflow(options);
  const definitions = {};
  for (const node of Object.values(graph)) {
    definitions[node.class_type] ||= { input: { required: {} } };
    for (const [key, value] of Object.entries(node.inputs)) if (categories[key] || key === 'verified_local_weights') definitions[node.class_type].input.required[key] = ['COMBO', { options: [value] }];
  }
  const fetcher = async url => { const name = url.split('/').at(-1); return { ok: true, status: definitions[name] ? 200 : 404, json: async () => ({ [name]: definitions[name] }) }; };
  assert.equal((await getMossPoseDependencyStatus(graph, fetcher)).ready, true);
  definitions.H3CheckedDWPose.input.required.verified_local_weights[1].options = ['blocked'];
  assert.match((await getMossPoseDependencyStatus(graph, fetcher)).missing.join(), /SHA-256/);
  delete definitions.H3CheckedDWPose;
  const missing = await getMossPoseDependencyStatus(graph, fetcher);
  assert.equal(missing.ready, false);
  assert.match(missing.missing.join(), /H3CheckedDWPose/);
});

test('visible canvas ports accept pose and identity images but reject video and mask', () => {
  const target = { id: 'pose', type: 'generator', data: { mode: 'mossPose' } };
  const input = { id: 'input', type: 'media', data: { kind: 'image' } };
  for (const handle of ['guide', 'identity']) assert.ok(!planCanvasConnection({ source: 'input', target: 'pose', targetHandle: handle }, [input, target], []).error);
  assert.match(planCanvasConnection({ source: 'input', target: 'pose', targetHandle: 'guide' }, [{ ...input, data: { kind: 'video' } }, target], []).error, /类型/);
});
