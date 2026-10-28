import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildImageWorkflow, extractImages, IMAGE_MODEL, MOSS_IMAGE_MODEL } = await import('./src/workbench-api.js');

const moss = buildImageWorkflow({ imageModel: 'moss', prompt: '写实的新角色与场景', ratio: '9:16', seed: 42 });
assert.equal(moss.model.inputs.unet_name, MOSS_IMAGE_MODEL.unet);
assert.equal(moss.text.inputs.clip_name, MOSS_IMAGE_MODEL.clip);
assert.equal(moss.text.inputs.type, 'moss_image');
assert.equal(moss.vae.inputs.vae_name, MOSS_IMAGE_MODEL.vae);
assert.equal(moss.accelerate.class_type, 'SpectrumMOSSImageAdaptive');
assert.deepEqual(moss.sample.inputs.model, ['accelerate', 0]);
assert.equal(moss.sample.inputs.steps, 25);
assert.equal(moss.sample.inputs.cfg, 2.5);
assert.equal(moss.sample.inputs.sampler_name, 'er_sde');
assert.equal(moss.sample.inputs.scheduler, 'simple');
assert.equal(moss.latent.inputs.width, 768);
assert.equal(moss.latent.inputs.height, 1344);
assert.equal(moss.save.inputs.filename_prefix, 'image/H3_MOSS_Image');
assert.equal(moss.lora, undefined);

const krea = buildImageWorkflow({ imageModel: 'krea2', prompt: 'test', ratio: '16:9', seed: 42 });
assert.equal(krea.model.inputs.unet_name, IMAGE_MODEL.unet);
assert.equal(krea.sample.inputs.steps, 8);
assert.equal(krea.sample.inputs.cfg, 1);
assert.equal(krea.save.inputs.filename_prefix, 'image/H3_Image');
const mossResults = extractImages({ outputs: { save: { images: [{ filename: 'H3_MOSS_Image_00001_.png', subfolder: 'image', type: 'output' }] } } });
assert.equal(mossResults.length, 1);
assert.equal(mossResults[0].filename, 'H3_MOSS_Image_00001_.png');
console.log('PASS: MOSS 25-step Spectrum graph, result extraction and unchanged Krea2 graph.');
