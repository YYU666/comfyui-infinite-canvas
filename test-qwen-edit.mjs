import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildQwen21EditWorkflow } = await import('./src/workbench-api.js');
const { validateModelSettings } = await import('./src/canvas-mcp.js');

const single = buildQwen21EditWorkflow({
  references: [{ kind: 'image', slot: 'guide', name: 'source.png' }],
  prompt: 'Keep the original face.',
  seed: 78101,
});
assert.deepEqual(single.encode.inputs['images.image_1'], ['source', 0]);
assert.equal(single.encode.inputs['images.image_2'], undefined);
assert.equal(single.makeup, undefined);

const dual = buildQwen21EditWorkflow({
  references: [
    { kind: 'image', slot: 'guide', name: 'source.png' },
    { kind: 'image', slot: 'identity', name: 'makeup.png' },
  ],
  prompt: 'Edit <image1>: use <image2> only as a makeup reference.',
  seed: 78101,
  qwenSteps: 40,
  qwenRefResolution: 1536,
});
assert.deepEqual(dual.encode.inputs['images.image_1'], ['source', 0]);
assert.deepEqual(dual.encode.inputs['images.image_2'], ['makeup', 0]);
assert.equal(dual.makeup.inputs.image, 'makeup.png');
assert.equal(dual.encode.inputs.resolution, 1536);
assert.equal(dual.sample.inputs.steps, 40);
assert.deepEqual(dual.sample.inputs.latent_image, ['encode', 2]);
assert.deepEqual(single.sample.inputs.model, ['model', 0]);
const realism = buildQwen21EditWorkflow({
  references: [{ kind: 'image', slot: 'guide', name: 'source.png' }],
  prompt: 'Turn the stylized character into a real photographed human.',
  seed: 78101,
  imageLora: 'qwen21Realism',
  loraStrength: 0.8,
});
assert.equal(realism.realism.class_type, 'LoraLoaderModelOnly');
assert.equal(realism.realism.inputs.lora_name, 'Qwen2.1_Anything2RealCharacters.safetensors');
assert.equal(realism.realism.inputs.strength_model, 0.8);
assert.deepEqual(realism.sample.inputs.model, ['realism', 0]);
console.log('Qwen 2.1 单图、双图及真人化 LoRA 输入测试通过');

const turbo = buildQwen21EditWorkflow({
  references: [{ kind: 'image', slot: 'guide', name: 'source.png' }],
  prompt: 'Keep the original face.', seed: 78101, qwenModel: 'turbo', qwenSteps: 40,
});
assert.equal(turbo.model.inputs.unet_name, 'qwen_image_2.1_turbo_int8_convrot.safetensors');
assert.equal(turbo.sample.class_type, 'SamplerCustomAdvanced');
assert.deepEqual(turbo.sample.inputs.sigmas, ['sigmas', 0]);
assert.equal(turbo.sigmas.class_type, 'ManualSigmas');
assert.deepEqual(turbo.sigmas.inputs.sigmas.split(',').map(Number), [1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0]);
assert.equal(turbo.cache.class_type, 'QwenImage21Cache');
assert.deepEqual(turbo.guider.inputs.model, ['cache', 0]);
assert.equal(turbo.noise.inputs.noise_seed, 78101);
assert.equal(turbo.guider.inputs.cfg, 1);
assert.equal(single.model.inputs.unet_name, 'qwen_image_2.1_int8_convrot.safetensors');
assert.equal(single.sample.class_type, 'KSampler');
assert.throws(() => buildQwen21EditWorkflow({ references: [{ kind: 'image', slot: 'guide', name: 'source.png' }], prompt: 'edit', qwenModel: 'unknown' }), /未知/);
console.log('QWEN_TURBO_OK official sigmas, cache, reference latent, stable seed, legacy defaults');

const cropOptions = {
  references: [
    { kind: 'image', slot: 'guide', name: 'test5-sheet.png' },
    { kind: 'image', slot: 'identity', name: 'makeup.png' },
  ],
  prompt: 'Edit <image1>: turn the face 45 degrees.', seed: 281306,
  qwenRefResolution: 1536,
};
const qwenSourceCrop = { x: 0, y: 0, width: 1152, height: 2048 };
assert.doesNotThrow(() => validateModelSettings({ qwenSourceCrop }));
for (const qwenModel of ['standard', 'turbo']) {
  const uncropped = buildQwen21EditWorkflow({ ...cropOptions, qwenModel });
  const cropped = buildQwen21EditWorkflow({ ...cropOptions, qwenModel, qwenSourceCrop });
  assert.equal(uncropped.reference_crop, undefined);
  assert.deepEqual(cropped.reference_crop, {
    class_type: 'ImageCrop', inputs: { image: ['source', 0], ...qwenSourceCrop },
  });
  assert.deepEqual(cropped.encode.inputs['images.image_1'], ['reference_crop', 0]);
  assert.deepEqual(cropped.encode.inputs['images.image_2'], ['makeup', 0]);
  // Removing the optional crop must recover the complete original graph.
  delete cropped.reference_crop;
  cropped.encode.inputs['images.image_1'] = ['source', 0];
  assert.deepEqual(cropped, uncropped);
}
for (const invalid of [
  undefined, null, [], '0,0,1152,2048', {},
  { ...qwenSourceCrop, x: -1 }, { ...qwenSourceCrop, y: -1 },
  { ...qwenSourceCrop, width: 0 }, { ...qwenSourceCrop, height: -1 },
  { ...qwenSourceCrop, x: 0.5 }, { ...qwenSourceCrop, width: '1152' },
  { ...qwenSourceCrop, x: NaN }, { ...qwenSourceCrop, height: Infinity },
  { ...qwenSourceCrop, width: 16385 }, { ...qwenSourceCrop, y: 16384 },
  { ...qwenSourceCrop, extra: 1 },
]) {
  assert.throws(() => buildQwen21EditWorkflow({ ...cropOptions, qwenSourceCrop: invalid }), /qwenSourceCrop/);
  assert.throws(() => validateModelSettings({ qwenSourceCrop: invalid }), /qwenSourceCrop/);
}
console.log('QWEN_SOURCE_CROP_OK isolated reference crop, unchanged standard/turbo graph, shared validation');

for (const qwenModel of ['standard', 'turbo']) for (const imageLora of ['none', 'qwen21Realism']) {
  const options = { ...cropOptions, qwenModel, imageLora, qwenSourceCrop, qwenSteps: 40 };
  const baseline = buildQwen21EditWorkflow(options);
  assert.deepEqual(buildQwen21EditWorkflow({ ...options, qwenCacheDevice: 'auto' }), baseline);
  const cpu = buildQwen21EditWorkflow({ ...options, qwenCacheDevice: 'cpu' });
  const model = [imageLora === 'qwen21Realism' ? 'realism' : 'model', 0];
  assert.deepEqual(cpu.cache, { class_type: 'QwenImage21Cache', inputs: { model, device: 'cpu', dtype: 'default' } });
  assert.equal(Object.values(cpu).filter((node) => node.class_type === 'QwenImage21Cache').length, 1);
  if (qwenModel === 'turbo') {
    assert.deepEqual(cpu.guider.inputs.model, ['cache', 0]);
    cpu.cache.inputs.device = 'auto';
  } else {
    assert.deepEqual(cpu.sample.inputs.model, ['cache', 0]);
    cpu.sample.inputs.model = model;
    delete cpu.cache;
  }
  assert.deepEqual(cpu, baseline, 'CPU cache changes only cache placement and its model route');
}
for (const qwenCacheDevice of ['gpu', 'off', 'int8', '', undefined, null, 0, true, {}, []]) {
  assert.throws(() => validateModelSettings({ qwenCacheDevice }), /qwenCacheDevice/);
  if (qwenCacheDevice !== undefined) assert.throws(() => buildQwen21EditWorkflow({ ...cropOptions, qwenCacheDevice }), /qwenCacheDevice/);
}
for (const mode of ['qwenEdit', 'characterSheet']) for (const qwenCacheDevice of ['auto', 'cpu']) assert.doesNotThrow(() => validateModelSettings({ qwenCacheDevice }, mode));
for (const mode of ['outfitEdit', 'image', 'localRealism']) assert.throws(() => validateModelSettings({ qwenCacheDevice: 'cpu' }, mode), /qwenCacheDevice/);
for (const type of ['note', 'image', 'video', 'audio']) {
  const current = { type, data: {} };
  assert.throws(() => validateModelSettings({ qwenCacheDevice: 'cpu' }, current.data.mode ?? ''), /qwenCacheDevice/, `${type} without a generator mode rejects cache settings`);
}
console.log('QWEN_CPU_CACHE_OK lossless placement only, auto unchanged, standard/turbo/realism, invalid settings rejected');
