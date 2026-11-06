import assert from 'node:assert/strict';

globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildQwen21EditWorkflow } = await import('./src/workbench-api.js');
const source = { id: 'source', kind: 'image', slot: 'guide', name: 'source.png' };
const reference = { id: 'reference', kind: 'image', slot: 'identity', name: 'reference.png' };
const mask = { id: 'selection', kind: 'image', slot: 'mask', name: 'selection.png' };
const options = { references: [source, reference], prompt: '把图1选中区域改成图2的颜色', seed: 42 };

for (const qwenModel of ['standard', 'turbo']) {
  for (const qwenCacheDevice of ['auto', 'cpu']) {
    const settings = { ...options, qwenModel, qwenCacheDevice };
    const unmasked = buildQwen21EditWorkflow(settings);
    assert.deepEqual(buildQwen21EditWorkflow({ ...settings, qwenMaskCrop: true }), unmasked, 'crop option without a mask has no effect');
    assert.deepEqual(unmasked.sample.inputs.latent_image, ['encode', 2], 'unmasked native latent is unchanged');
    assert.deepEqual(unmasked.save.inputs.images, ['decode', 0], 'unmasked output is not composited/resized');
    assert.ok(!Object.keys(unmasked).some((key) => key.startsWith('mask_')));
    assert.equal(unmasked.sample.class_type, qwenModel === 'turbo' ? 'SamplerCustomAdvanced' : 'KSampler');
    if (qwenModel === 'standard') {
      assert.equal(unmasked.sample.inputs.denoise, 1);
      assert.equal(unmasked.sample.inputs.steps, 40);
    }

    const graph = buildQwen21EditWorkflow({ ...settings, references: [mask, reference, source] });
    assert.deepEqual(buildQwen21EditWorkflow({ ...settings, references: [mask, reference, source], qwenMaskCrop: false }), graph, 'full-frame remains the default');
    assert.deepEqual(graph.encode, unmasked.encode, 'mask never becomes a numbered prompt/reference image');
    assert.deepEqual(graph.source, unmasked.source, 'image1 remains the complete original');
    assert.deepEqual(graph.sample, { ...unmasked.sample, inputs: { ...unmasked.sample.inputs, latent_image: ['mask_latent', 0] } });
    assert.deepEqual(graph.mask_latent, { class_type: 'SetLatentNoiseMask', inputs: { samples: ['mask_source_latent', 0], mask: ['mask_sample', 0] } });
    assert.equal(graph.mask_source_latent.class_type, 'VAEEncode');
    assert.deepEqual(graph.mask_source_latent.inputs.pixels, ['mask_sample_source', 0], 'sampling starts from source pixels, not empty encoder latent');
    assert.deepEqual(graph.mask_latent_size.inputs.latent, ['encode', 2]);
    assert.equal(graph.mask_sample_width.inputs.value, 'a * 16');
    assert.equal(graph.mask_sample_height.inputs.value, 'a * 16');
    for (const axis of ['width', 'height']) {
      assert.deepEqual(graph.mask_sample_source.inputs[axis], graph.mask_sample_image.inputs[axis], 'source/mask sampling dimensions match');
      assert.deepEqual(graph.mask_output_resize.inputs[axis], graph.mask_original_image.inputs[axis], 'composite dimensions match original source');
    }
    assert.deepEqual(graph.mask_sample_source.inputs.image, ['source', 0]);
    assert.deepEqual(graph.mask_sample_image.inputs.image, ['mask_original_image', 0]);
    assert.equal(graph.mask_sample_source.inputs.crop, 'disabled');
    assert.equal(graph.mask_sample_image.inputs.crop, 'disabled');
    assert.equal(graph.mask_sample.inputs.channel, 'red');
    assert.equal(graph.mask_original.inputs.channel, 'red');
    assert.equal(graph.mask_original_image.inputs.upscale_method, 'nearest-exact');
    assert.equal(graph.mask_sample_image.inputs.upscale_method, 'nearest-exact');
    assert.deepEqual(graph.mask_source_size.inputs.image, ['source', 0]);
    assert.deepEqual(graph.mask_output_resize.inputs.image, ['decode', 0]);
    assert.deepEqual(graph.mask_output, { class_type: 'ImageCompositeMasked', inputs: {
      destination: ['source', 0], source: ['mask_output_resize', 0], x: 0, y: 0, resize_source: false, mask: ['mask_original', 0],
    } });
    assert.deepEqual(graph.save.inputs.images, ['mask_output', 0]);
    assert.ok(!JSON.stringify(graph).includes('H3PortraitSkinMask'), 'generic edits never inherit portrait skin detection');
    assert.ok(!Object.values(graph).some((node) => node.class_type.includes('InpaintCrop')), 'reference context is never cropped');
    // Every unchanged node remains identical, including cache, LoRA and Turbo sigmas.
    for (const [id, node] of Object.entries(unmasked)) {
      if (!['sample', 'save'].includes(id)) assert.deepEqual(graph[id], node);
    }

    for (const qwenRefResolution of [undefined, 768, 1000]) {
      const local = buildQwen21EditWorkflow({ ...settings, references: [source, mask, reference], qwenMaskCrop: true, qwenRefResolution });
      const cropInputs = local.mask_crop.inputs;
      assert.equal(local.mask_crop.class_type, 'InpaintCropImproved');
      assert.deepEqual(cropInputs.image, ['source', 0]);
      assert.deepEqual(cropInputs.mask, ['mask_original', 0]);
      assert.equal(cropInputs.output_target_width, qwenRefResolution ?? 1024);
      assert.equal(cropInputs.output_target_height, qwenRefResolution ?? 1024);
      assert.equal(cropInputs.output_resize_to_target_size, true);
      assert.equal(cropInputs.context_from_mask_extend_factor, 1.3);
      assert.equal(cropInputs.mask_expand_pixels, 0);
      assert.equal(cropInputs.mask_blend_pixels, 0);
      assert.equal(cropInputs.mask_hipass_filter, 0);
      assert.equal(cropInputs.mask_fill_holes, false);
      assert.equal(cropInputs.preresize, false);
      assert.equal(cropInputs.extend_for_outpainting, false);
      assert.deepEqual(local.encode.inputs['images.image_1'], ['mask_crop', 1]);
      assert.deepEqual(local.encode.inputs['images.image_2'], graph.encode.inputs['images.image_2']);
      assert.equal(local.encode.inputs.prompt, graph.encode.inputs.prompt, 'local crop does not renumber references');
      assert.deepEqual(local.mask_sample_source.inputs.image, ['mask_crop', 1]);
      assert.deepEqual(local.mask_crop_image, { class_type: 'MaskToImage', inputs: { mask: ['mask_crop', 2] } });
      assert.deepEqual(local.mask_sample_image.inputs.image, ['mask_crop_image', 0]);
      assert.deepEqual(local.mask_latent, graph.mask_latent, 'both samplers retain the cropped source latent and noise mask');
      assert.deepEqual(local.sample, graph.sample);
      assert.deepEqual(local.mask_latent_size.inputs.latent, ['encode', 2], 'actual encoder dimensions govern crop sampling');
      for (const axis of ['width', 'height']) assert.deepEqual(local.mask_sample_source.inputs[axis], local.mask_sample_image.inputs[axis]);
      assert.deepEqual(local.mask_crop_size.inputs.image, ['mask_crop', 1]);
      assert.deepEqual(local.mask_crop_decode_resize, { class_type: 'ImageScale', inputs: {
        image: ['decode', 0], upscale_method: 'lanczos', width: ['mask_crop_size', 0], height: ['mask_crop_size', 1], crop: 'disabled',
      } }, 'restore actual crop dimensions before stitching, including non-multiple target sizes');
      assert.deepEqual(local.mask_stitch, { class_type: 'InpaintStitchImproved', inputs: { stitcher: ['mask_crop', 0], inpainted_image: ['mask_crop_decode_resize', 0] } });
      assert.deepEqual(local.mask_output_resize.inputs.image, ['mask_stitch', 0]);
      assert.deepEqual(local.mask_output, graph.mask_output, 'final original red-mask composite protects every black pixel after stitching');
      assert.deepEqual(local.mask_original, graph.mask_original);
      assert.deepEqual(local.save, graph.save);
    }
  }
}

const refs = Array.from({ length: 10 }, (_, i) => ({ id: `ref${i}`, name: `ref${i}.png`, kind: 'image', slot: 'references' }));
const full = buildQwen21EditWorkflow({ ...options, references: [...refs, mask], prompt: '修改图1，参考图10' });
assert.equal(Object.keys(full.encode.inputs).filter((key) => key.startsWith('images.image_')).length, 10, 'mask does not consume reference capacity');
assert.deepEqual(full.encode.inputs['images.image_10'], ['reference_10', 0]);
const fullCrop = buildQwen21EditWorkflow({ ...options, references: [...refs, mask], prompt: '修改图1，参考图10', qwenMaskCrop: true });
assert.deepEqual(fullCrop.encode.inputs['images.image_1'], ['mask_crop', 1]);
for (let index = 2; index <= 10; index++) assert.deepEqual(fullCrop.encode.inputs[`images.image_${index}`], full.encode.inputs[`images.image_${index}`], 'all additional references remain full-frame');
const reordered = buildQwen21EditWorkflow({ ...options, references: [source, mask, reference], qwenReferenceOrder: ['selection', 'reference', 'source'] });
assert.equal(reordered.source.inputs.image, reference.name, 'mask follows whichever numbered image is currently image1');
assert.throws(() => buildQwen21EditWorkflow({ ...options, references: [source, mask, { ...mask, id: 'second' }] }), /最多连接一张遮罩/);
assert.throws(() => buildQwen21EditWorkflow({ ...options, references: [source, { ...mask, kind: 'video' }] }), /有效的遮罩图片/);
assert.throws(() => buildQwen21EditWorkflow({ ...options, references: [source, { ...mask, name: '' }] }), /有效的遮罩图片/);
assert.throws(() => buildQwen21EditWorkflow({ ...options, references: [mask] }), /至少需要一张参考/);
assert.throws(() => buildQwen21EditWorkflow({ ...options, references: [source, mask], prompt: '修改图2' }), /图2未连接/);
assert.throws(() => buildQwen21EditWorkflow({ ...options, references: [source, mask], prompt: '[[qref:selection]]' }), /已断开/);
const crop = { x: 0, y: 0, width: 256, height: 384 };
assert.throws(() => buildQwen21EditWorkflow({ ...options, references: [source, reference, mask], qwenSourceCrop: crop }), /不支持 qwenSourceCrop/);
assert.throws(() => buildQwen21EditWorkflow({ ...options, references: [source, reference, mask], qwenSourceCrop: crop, qwenMaskCrop: true }), /不支持 qwenSourceCrop/);
for (const qwenMaskCrop of [null, 0, 1, 'false', 'true', [], {}]) {
  assert.throws(() => buildQwen21EditWorkflow({ ...options, qwenMaskCrop }), /qwenMaskCrop 必须是布尔值/);
}
const cropped = buildQwen21EditWorkflow({ ...options, qwenSourceCrop: crop });
assert.deepEqual(cropped.encode.inputs['images.image_1'], ['reference_crop', 0], 'unmasked source crops remain supported');
console.log('QWEN_MASK_OK standard/Turbo, CPU cache, full-frame/cropped source-aligned sampling, crop stitching, original-size composite, reference numbering/capacity, invalid masks/crops/flags');

// Packaged nodes must retain the mask input as well as the numbered references.
const { shareSource } = await import('./src/workflow-sharing.js');
const shared = shareSource({ data: { mode: 'qwenEdit', seed: 1, prompt: '编辑图1' } }, [{ id: 'a', data: { kind: 'image', slot: 'references' } }, { id: 'm', data: { kind: 'image', slot: 'mask' } }]);
assert.equal(shared.workflow.mask_image.class_type, 'LoadImage');
assert.equal(shared.workflow.encode.inputs['images.image_2'], undefined);
