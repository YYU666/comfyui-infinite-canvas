import assert from 'node:assert/strict';
import { buildQwen21EditWorkflow } from './src/workbench-api.js';
import { visibleGenerationRecord, captureVisibleExecution } from './src/visible-generation.js';
import { imageGenerationSeed, imageRunError, pageImageRun, preparePageImageRun, promptRunSnapshot, recoverInterruptedImageRuns } from './src/image-visible-run.js';

const node = { id: 'generator', type: 'generator', data: { mode: 'qwenEdit' } };
const image = (id, slot, data = {}) => ({ id, data: { kind: 'image', title: id, slot, assetPath: 'assets/' + id + '.png', remoteName: 'workbench/' + id + '.png', ...data } });
const face = image('face', 'references');
const base = image('base', 'guide');
const mask = image('mask', 'mask', { maskSourceId: 'base', maskSourceKey: 'stable-mask-source' });
const prompt = '按 [[qref:base]] 构图，把 [[qref:face]] 作为参考。';
const references = [face, base].map(({ id, data }) => ({id, kind: data.kind, slot: data.slot, name: data.remoteName}));
const settings = { mode: 'qwenEdit', seed: 0, qwenModel: 'standard', qwenSteps: 40, qwenRefResolution: 768,
  qwenCacheDevice: 'cpu', imageLora: 'none', qwenReferenceOrder: ['base', 'face'],
  prompt, references };
const request = { requestId: 'synthetic-qwen', origin: 'agent' };
const crop = { x: 17, y: 22, width: 216, height: 304 };
const cropRun = visibleGenerationRecord(node, [face, base], { ...settings, qwenSourceCrop: crop }, request);
assert.equal(imageGenerationSeed(settings), 0);
assert.equal(imageGenerationSeed({ mode: 'outfitEdit', seed: '0' }), 0);
assert.equal(imageGenerationSeed({ mode: 'image' }), 42);
assert.equal(imageGenerationSeed({ mode: 'reference', seed: 0 }), 42);
assert.deepEqual(cropRun.inputs.map(row => [row.nodeId, row.role, row.order]), [['base', 'base', 1], ['face', 'reference', 2]]);
assert.deepEqual(cropRun.inputs[0].crop, crop);
assert.equal(cropRun.inputs[1].resolvedName, 'workbench/face.png');
assert.equal(cropRun.parameters.seed, 0);
assert.notDeepEqual(visibleGenerationRecord(node, [face, base], { ...settings, qwenReferenceOrder: ['face', 'base'], qwenSourceCrop: crop }, request), cropRun);
assert.notDeepEqual(visibleGenerationRecord(node, [face, base], { ...settings, qwenSourceCrop: { ...crop, x: 18 } }, request), cropRun);
const cropGraph = buildQwen21EditWorkflow({ ...settings, qwenSourceCrop: crop });
assert.deepEqual(cropGraph.reference_crop.inputs, { image: ['source', 0], ...crop });
assert.equal(cropGraph.sample.inputs.seed, 0);
assert.equal(cropGraph.source.inputs.image, cropRun.inputs[0].resolvedName);
assert.equal(cropGraph.makeup.inputs.image, cropRun.inputs[1].resolvedName);
const maskSettings = { ...settings, qwenMaskCrop: true,
  references: [...references, { id: mask.id, name: mask.data.remoteName, kind: mask.data.kind, slot: mask.data.slot }] };
const maskRun = visibleGenerationRecord(node, [mask, face, base], maskSettings, request);
assert.equal(maskRun.inputs[2].role, 'mask');
assert.equal(maskRun.inputs[2].guideNodeId, 'base');
assert.equal(maskRun.inputs[2].guideVersion, 'stable-mask-source');
const maskGraph = buildQwen21EditWorkflow(maskSettings);
assert.equal(maskGraph.mask_image.inputs.image, maskRun.inputs[2].resolvedName);
assert.notEqual((await captureVisibleExecution(cropGraph)).record.digest, (await captureVisibleExecution(maskGraph)).record.digest);

const optimizer = { id: 'prompt', type: 'prompt', data: { idea: 'Synthesized shot' } };
const target = { id: 'video', data: { mode: 'reference', prompt: 'holds @base', ratio: '16:9', duration: 5 } };
const descriptors = [{node: base, tag: '<Picture 1>', kind: 'image'}];
const snap = promptRunSnapshot(optimizer, target, descriptors);
assert.match(snap.payload.currentPrompt, /<Picture 1>/);
assert.equal(snap.restore('keep <Picture 1>'), 'keep @base');
assert.notEqual(snap.version, promptRunSnapshot(optimizer, { ...target, data: {...target.data, prompt: 'current edits'} }, descriptors).version);
assert.notEqual(snap.version, promptRunSnapshot(optimizer, target, [{...descriptors[0], node: image('selected-again', 'guide')}]).version);
assert.throws(() => promptRunSnapshot(optimizer, {...target, data: {mode: 'qwenEdit'}}, descriptors), /H3/);

for (const kind of ['prompt-optimization', 'art-analysis', 'image-worker']) {
  const run = pageImageRun(kind, snap.inputs, { fixture: true }, 'fixture-' + kind);
  let current = true;
  const events = [];
  const record = {
    stage: () => events.push('visible'),
    persist: async () => events.push('saved'),
    assertCurrent: () => { if (!current) throw new Error('source changed'); },
  };
  const dispatch = async (callbacks) => {
    await preparePageImageRun(callbacks);
    events.push('fake provider');
  };
  await dispatch(record);
  assert.deepEqual(events, ['visible', 'saved', 'fake provider']);
  events.length = 0;
  await assert.rejects(dispatch({ ...record, persist: async () => { throw new Error('save failed'); } }), /save failed/);
  assert.deepEqual(events, ['visible']);
  events.length = 0;
  await assert.rejects(dispatch({ ...record, persist: async () => { current = false; } }), /source changed/);
  assert.equal(events.includes('fake provider'), false);
  const interrupted = recoverInterruptedImageRuns([{ id: kind, type: kind === 'art-analysis' ? 'artDirector' : kind === 'image-worker' ? 'imageProcess' : 'prompt',
    data: { status: 'running', imageRun: run, processedAssetPath: 'old.png' } }])[0];
  assert.equal(interrupted.data.imageRun.phase, 'interrupted');
  assert.equal(interrupted.data.processedAssetPath, 'old.png');
  assert.equal(imageRunError(run, new DOMException('', 'TimeoutError'), true).phase, 'interrupted');
}
console.log('IMAGE_VISIBLE_RUN_OK seed 0; exact role/order/crop/mask; prepared before mock request; stale input and reopen interrupted');
