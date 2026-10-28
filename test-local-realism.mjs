import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildLocalRealismWorkflow, LOCAL_REALISM_PROMPT } = await import('./src/workbench-api.js');

const graph = buildLocalRealismWorkflow({ references: [{ kind: 'image', slot: 'guide', name: 'face.png' }], seed: 78001 });
assert.equal(graph.skin.class_type, 'H3PortraitSkinMask');
assert.equal(graph.skin.inputs.mode, 'front');
assert.equal(buildLocalRealismWorkflow({ references: [{ kind: 'image', slot: 'guide', name: 'body.png' }], seed: 1, localMaskMode: 'front_body' }).skin.inputs.mode, 'front_body');
assert.equal(graph.crop.class_type, 'InpaintCropImproved');
assert.equal(graph.crop.inputs.mask_expand_pixels, 0);
assert.equal(graph.crop.inputs.mask_fill_holes, false);
assert.equal(graph.crop.inputs.mask_blend_pixels, 16);
assert.equal(graph.crop.inputs.output_target_width, 768);
assert.equal(graph.crop.inputs.output_target_height, 768);
assert.equal(graph.sample.inputs.steps, 25);
assert.equal(graph.sample.inputs.denoise, 0.2);
assert.equal(buildLocalRealismWorkflow({ references: [{ kind: 'image', slot: 'guide', name: 'face.png' }], seed: 1, localRealismDenoise: 0.35 }).sample.inputs.denoise, 0.35);
assert.equal(graph.latent.class_type, 'VAEEncode');
assert.deepEqual(graph.latent.inputs.pixels, ['crop', 1]);
assert.deepEqual(graph.mask.inputs.samples, ['latent', 0]);
assert.equal(graph.sample.inputs.model[0], 'model');
assert.equal(graph.realism, undefined);
assert.equal(graph.stitch.inputs.stitcher[0], 'crop');
assert.deepEqual(graph.save.inputs.images, ['stitch', 0]);
assert.equal(buildLocalRealismWorkflow({ references: [{ kind: 'image', slot: 'guide', name: 'face.png' }], seed: 1 }).encode.inputs.prompt, LOCAL_REALISM_PROMPT);
assert.throws(() => buildLocalRealismWorkflow({ references: [], seed: 1 }), /正面人像/);
const high = buildLocalRealismWorkflow({ references: [{ kind: 'image', slot: 'guide', name: 'face.png' }], seed: 78001, localRealismSize: 1536, localRealismSteps: 30 });
assert.equal(high.crop.inputs.output_target_width, 1536);
assert.equal(high.crop.inputs.output_target_height, 1536);
assert.equal(high.encode.inputs.resolution, 1536);
assert.equal(high.sample.inputs.steps, 30);
const realism = buildLocalRealismWorkflow({ references: [{ kind: 'image', slot: 'guide', name: 'face.png' }], seed: 78001, imageLora: 'qwen21Realism', loraStrength: 0.45 });
assert.equal(realism.realism.class_type, 'LoraLoaderModelOnly');
assert.equal(realism.realism.inputs.strength_model, 0.45);
assert.deepEqual(realism.sample.inputs.model, ['realism', 0]);
const customMask = buildLocalRealismWorkflow({
  references: [
    { kind: 'image', slot: 'guide', name: 'original-back.png' },
    { kind: 'image', slot: 'identity', name: 'feet-mask.png' },
  ],
  prompt: 'Edit <image1>: redraw only the masked feet.',
  seed: 78109,
  localRealismSize: 1024,
  localRealismSteps: 40,
  localRealismDenoise: 1,
  localMaskExpand: 0,
  localMaskBlend: 24,
});
assert.equal(customMask.skin, undefined);
assert.equal(customMask.mask_image.class_type, 'LoadImage');
assert.equal(customMask.mask_image.inputs.image, 'feet-mask.png');
assert.equal(customMask.mask_channel.class_type, 'ImageToMask');
assert.equal(customMask.mask_channel.inputs.channel, 'red');
assert.deepEqual(customMask.crop.inputs.mask, ['mask_channel', 0]);
assert.equal(customMask.crop.inputs.mask_blend_pixels, 24);
assert.equal(customMask.sample.inputs.steps, 40);
assert.equal(customMask.sample.inputs.denoise, 1);
console.log('局部写实工作流结构、1536 高精度参数、可选写实 LoRA 及自定义遮罩测试通过');
