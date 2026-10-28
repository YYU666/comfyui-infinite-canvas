import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildQwen21EditWorkflow } = await import('./src/workbench-api.js');

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
