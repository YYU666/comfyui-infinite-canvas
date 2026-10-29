import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const api = await import('./src/workbench-api.js');
const base = { prompt: 'fitted summer outfit', seed: 42, references: [{ kind: 'image', slot: 'guide', name: 'workbench/source.png' }] };

for (const panel of api.OUTFIT_PANELS) {
  const graph = api.buildOutfitQuadWorkflow({ ...base, outfitPanel: panel.id });
  assert.equal(graph.single.inputs.width, panel.outputWidth);
  assert.equal(graph.single.inputs.height, panel.outputHeight);
  assert.equal(graph.crop.inputs.y, panel.y);
  assert.equal(graph.save.inputs.filename_prefix, `image/H3_OutfitSingle_${panel.id}`);
  assert.equal(Object.keys(graph).some((key) => key.includes('stitch') || key === 'quad'), false);
  if (panel.preserve) {
    assert.equal(graph.model, undefined);
    assert.equal(graph.sample, undefined);
    assert.equal(graph.save.inputs.images[0], 'single');
  } else {
    assert.equal(graph.model.inputs.unet_name, api.QWEN21_EDIT_MODEL.unet);
    assert.equal(graph.sample.inputs.denoise, 1);
    assert.equal(graph.sample.inputs.steps, 40);
    assert.match(graph.encode.inputs.prompt, /same narrow waist circumference/);
    assert.match(graph.encode.inputs.prompt, /no loose or padded waist/);
    assert.match(graph.encode.inputs.prompt, /Do not add a head or face/);
  }
}

const hd = api.buildImageHdWorkflow({
  references: [{ kind: 'image', slot: 'guide', name: 'workbench/single.png' }],
  imageScale: 1.5,
  seed: 42,
  outputPrefix: 'image/H3_OutfitHD_br',
});
assert.equal(hd.save.inputs.filename_prefix, 'image/H3_OutfitHD_br');
assert.equal(hd.resize.inputs['resize_type.multiplier'], 1.5);
assert.equal(hd.sample.inputs.steps, 1);
assert.equal(hd.source.inputs.image, 'workbench/single.png');

const stitch = api.buildOutfitStitchWorkflow({ tl: 'tl.png', tr: 'tr.png', bl: 'bl.png', br: 'br.png' });
assert.equal(stitch.quad.class_type, 'ImageStitch');
assert.equal(stitch.save.inputs.filename_prefix, 'image/H3_OutfitQuad');
assert.equal(Object.values(stitch).some((node) => node.class_type === 'KSampler'), false);
assert.throws(() => api.buildOutfitQuadWorkflow({ ...base, outfitPanel: 'bad' }), /未知/);
const realistic = api.buildOutfitQuadWorkflow({ ...base, outfitPanel: 'br', imageLora: 'qwen21Realism', loraStrength: 0.6 });
assert.equal(realistic.realism.class_type, 'LoraLoaderModelOnly');
assert.equal(realistic.realism.inputs.lora_name, api.QWEN21_EDIT_MODEL.realismLora);
assert.equal(realistic.realism.inputs.strength_model, 0.6);
assert.deepEqual(realistic.sample.inputs.model, ['realism', 0]);
const realisticPortrait = api.buildOutfitQuadWorkflow({ ...base, outfitPanel: 'tl', imageLora: 'qwen21Realism', loraStrength: 0.45 });
assert.equal(realisticPortrait.realism.inputs.lora_name, api.QWEN21_EDIT_MODEL.realismLora);
assert.equal(realisticPortrait.sample.inputs.denoise, 1);
assert.match(realisticPortrait.encode.inputs.prompt, /original facial geometry is immutable/);
assert.match(realisticPortrait.encode.inputs.prompt, /No beauty filter, no skin smoothing/);
const referenced = api.buildOutfitQuadWorkflow({
  ...base,
  outfitLayout: 'mixedGrid',
  outfitPanel: 'tl',
  references: [...base.references, { kind: 'image', slot: 'identity', name: 'workbench/outfit-reference.png' }],
});
assert.equal(referenced.outfit_reference.inputs.image, 'workbench/outfit-reference.png');
assert.deepEqual(referenced.encode.inputs['images.image_2'], ['outfit_reference', 0]);
assert.match(referenced.encode.inputs.prompt, /<image2> is ONLY a garment reference/);
assert.match(referenced.encode.inputs.prompt, /ignore its person, skin, face, body shape, pose, camera and background/);
assert.match(referenced.encode.inputs.prompt, /Do not zoom out/);
assert.match(referenced.encode.inputs.prompt, /bottom edge must cut through the upper chest at exactly the same place/);
assert.match(referenced.encode.inputs.prompt, /waist, abdomen, hips, shorts, skirt and hands are outside the frame/);
const softBody = api.buildOutfitQuadWorkflow({ ...base, outfitLayout: 'mixedGrid', outfitPanel: 'br' });
assert.match(softBody.encode.inputs.prompt, /skin tone, smooth skin texture, soft tonal transitions/);
assert.match(softBody.encode.inputs.prompt, /Do not enhance or invent musculature, tendons, veins/);

const stableBase = { ...base, seed: 281306, outfitLayout: 'mixedGrid' };
const expectedPanelSeeds = { tl: 281324, tr: 281330, bl: 281306, br: 281312 };
for (const panel of api.resolveOutfitPanels(stableBase)) {
  const graph = api.buildOutfitQuadWorkflow({ ...stableBase, outfitPanel: panel.id });
  assert.equal(graph.encode.inputs.resolution, 1536);
  assert.equal(graph.sample.inputs.seed, expectedPanelSeeds[panel.id]);
  assert.deepEqual(graph.encode.inputs['images.image_1'], ['crop', 0]);
  assert.equal(Object.values(graph).some((node) => node.class_type === 'ImageScaleToTotalPixels'), false);
}
const headlessBack = api.buildOutfitQuadWorkflow({ ...stableBase, outfitPanel: 'bl' });
assert.match(headlessBack.encode.inputs.prompt, /no head, face, skull, scalp, ears, eyes, portrait or small face/);
assert.match(headlessBack.encode.inputs.prompt, /do not create a head or hair bun/);
assert.match(headlessBack.encode.inputs.prompt, /Both feet must remain naturally planted/);
const horizontalBody = api.buildOutfitQuadWorkflow({ ...stableBase, outfitLayout: 'horizontal', outfitPanel: 'tl' });
assert.doesNotMatch(horizontalBody.encode.inputs.prompt, /head is outside/);
assert.match(horizontalBody.encode.inputs.prompt, /head visibility, face, identity/);
const legacyBody = api.buildOutfitQuadWorkflow({ ...base, outfitPanel: 'br' });
assert.equal(legacyBody.encode.inputs.resolution, 1024);
assert.equal(legacyBody.sample.inputs.seed, 42);
assert.deepEqual(legacyBody.encode.inputs['images.image_1'], ['single', 0]);
assert.equal(api.shouldUpscaleOutfitImage(1152, 2080), false, '2K full-body output skips SeedVR2');
assert.equal(api.shouldUpscaleOutfitImage(1216, 1952), false, 'Near-2K portrait output skips SeedVR2');
assert.equal(api.shouldUpscaleOutfitImage(800, 1280), false, '1K–2K output is kept without forced HD');
assert.equal(api.shouldUpscaleOutfitImage(768, 960), true, 'Only sub-1K output automatically uses SeedVR2');
assert.equal(api.shouldUpscaleOutfitImage(1000, 800), false);
assert.throws(() => api.shouldUpscaleOutfitImage(0, 0), /无法读取/);
const queuePlan = api.buildOutfitQueuePlan(stableBase);
assert.equal(queuePlan.kind, 'outfit');
assert.equal(queuePlan.panels.length, 4);
assert.equal(queuePlan.panels[0].hd.source.inputs.image, '__H3_OUTFIT_CURRENT__');
assert.equal(queuePlan.stitch.tl_load.inputs.image, '__H3_OUTFIT_PANEL_tl__');
assert.equal(queuePlan.stitch.source.inputs.image, 'workbench/source.png');
assert.equal(queuePlan.panels[2].single.sample.inputs.seed, expectedPanelSeeds.bl);
const singleQueuePlan = api.buildOutfitQueuePlan({ ...stableBase, outfitPanel: 'br' });
assert.equal(singleQueuePlan.selectedPanel, 'br');
assert.equal(singleQueuePlan.panels.length, 1);
assert.equal(singleQueuePlan.stitch, null);
assert.throws(() => api.buildOutfitQueuePlan({ ...stableBase, outfitPanel: 'bad' }), /未知/);
console.log('PASS: native-crop Qwen input; stable per-view seeds; persistent outfit queue plan; HD only below 1K; final stitch only.');
