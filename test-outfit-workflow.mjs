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

const turboOptions = { ...stableBase, outfitModel: 'qwen21_turbo' };
const plainPlan = api.buildOutfitQueuePlan({ ...turboOptions, outfitUpscale: 'off' });
assert.equal(plainPlan.upscalePolicy, 'off');
assert.ok(plainPlan.panels.every((panel) => panel.hd === null));
const hd7Plan = api.buildOutfitQueuePlan({ ...turboOptions, outfitUpscale: 'seedvr2_7b' });
assert.equal(hd7Plan.upscalePolicy, 'seedvr2_7b');
for (const [index, panel] of hd7Plan.panels.entries()) {
  assert.equal(panel.hd.model.inputs.unet_name, 'seedvr2_7b_int8_convrot.safetensors');
  assert.deepEqual(panel.single, plainPlan.panels[index].single, 'HD branch must not alter the base sampling or prompt');
  assert.equal(panel.single.model.inputs.unet_name, 'qwen_image_2.1_turbo_int8_convrot.safetensors');
  assert.equal(panel.single.sample.class_type, 'SamplerCustomAdvanced');
  assert.equal(panel.single.noise.inputs.noise_seed, expectedPanelSeeds[panel.id]);
  assert.deepEqual(panel.single.encode.inputs['images.image_1'], ['crop', 0]);
}
assert.equal(api.shouldUpscaleOutfitImage(320, 480, 'off'), false);
assert.equal(api.shouldUpscaleOutfitImage(2048, 3072, 'seedvr2_7b'), true);
assert.equal(api.shouldUpscaleOutfitImage(2048, 3072), false);
assert.equal(api.buildImageHdWorkflow({ ...base, upscaleModel: 'seedvr2_7b' }).model.inputs.unet_name, 'seedvr2_7b_int8_convrot.safetensors');
assert.equal(hd.model.inputs.unet_name, 'seedvr2_3b_int8_convrot.safetensors');
assert.throws(() => api.buildOutfitQueuePlan({ ...stableBase, outfitUpscale: 'unknown' }), /未知/);
assert.throws(() => api.buildOutfitQuadWorkflow({ ...turboOptions, outfitPanel: 'br', outfitDenoise: 0.5 }), /完整 8 步/);

const muse = api.buildOutfitQuadWorkflow({ ...stableBase, outfitModel: 'muse_v4', outfitPanel: 'br' });
assert.equal(muse.model.inputs.unet_name, 'museByStableYogi_v40INT8Extended.safetensors');
assert.equal(muse.identity.inputs.lora_name, api.IDENTITY_EDIT_MODEL.lora);
assert.deepEqual(muse.source_latent.inputs.pixels, ['crop', 0]);
assert.deepEqual(muse.patch.inputs.source_image, ['crop', 0]);
assert.equal(muse.patch.inputs.ref_position, 'aligned (trained)');
assert.equal(muse.positive.class_type, 'Krea2EditGroundedEncode');
assert.match(muse.positive.inputs.prompt, /source positions/);
assert.equal(muse.sample.inputs.steps, 16);
assert.equal(muse.sample.inputs.seed, expectedPanelSeeds.br);
assert.deepEqual(muse.latent.inputs.width, ['crop_size', 0]);
assert.deepEqual(muse.latent.inputs.height, ['crop_size', 1]);
assert.equal(muse.encode, undefined);
const museClothing = api.buildOutfitQuadWorkflow({ ...stableBase, outfitModel: 'muse_v4', outfitPanel: 'br', references: [...base.references, { kind: 'image', slot: 'identity', name: 'clothing.png' }] });
assert.equal(museClothing.outfit_reference.inputs.image, 'clothing.png');
assert.deepEqual(museClothing.positive.inputs.image_b, ['outfit_reference', 0]);
assert.deepEqual(museClothing.patch.inputs.source_image_b, ['outfit_reference', 0]);
assert.equal(museClothing.patch.inputs.ref_boost_a, 2, 'mother image keeps the higher reference strength');
assert.ok(museClothing.patch.inputs.ref_boost < museClothing.patch.inputs.ref_boost_a);
console.log('VERSIONED_OUTFIT_OK Turbo, no-HD, forced7B, Muse grounded identity, native panel geometry');

const regionPanels = api.resolveOutfitPanels({ outfitLayout: 'mixedGrid' }).map((panel) => ({
  ...panel, editRegion: [0.12, 0.78, 0.76, 0.22], preserveOutsideRegion: true,
}));
const protectedOptions = { ...turboOptions, outfitLayout: 'custom', outfitPanels: regionPanels, outfitPanel: 'tl' };
const protectedTurbo = api.buildOutfitQuadWorkflow(protectedOptions);
assert.deepEqual(api.resolveOutfitPanels(protectedOptions)[0].editRegion, [0.12, 0.78, 0.76, 0.22]);
assert.equal(protectedTurbo.edit_background.inputs.value, 0);
assert.equal(protectedTurbo.edit_foreground.inputs.value, 1);
assert.deepEqual(protectedTurbo.edit_background.inputs.width, ['edit_native_size', 0]);
assert.deepEqual(protectedTurbo.edit_mask.inputs.destination, ['edit_background', 0]);
assert.deepEqual(protectedTurbo.edit_mask.inputs.source, ['edit_foreground', 0]);
assert.deepEqual(protectedTurbo.edit_latent_size.inputs.latent, ['encode', 2]);
assert.equal(protectedTurbo.edit_sample_width.inputs.value, 'a * 16');
assert.equal(protectedTurbo.edit_sample_height.inputs.value, 'a * 16');
assert.deepEqual(protectedTurbo.edit_sample_source.inputs.width, protectedTurbo.edit_sample_mask.inputs.width);
assert.deepEqual(protectedTurbo.edit_sample_source.inputs.height, protectedTurbo.edit_sample_mask.inputs.height);
assert.equal(protectedTurbo.edit_sample_mask.inputs.upscale_method, 'nearest-exact');
assert.equal(protectedTurbo.edit_source_latent.class_type, 'VAEEncode');
assert.deepEqual(protectedTurbo.edit_source_latent.inputs.pixels, ['edit_sample_source', 0]);
assert.equal(protectedTurbo.edit_latent.class_type, 'SetLatentNoiseMask');
assert.deepEqual(protectedTurbo.edit_latent.inputs.samples, ['edit_source_latent', 0]);
assert.deepEqual(protectedTurbo.sample.inputs.latent_image, ['edit_latent', 0]);
assert.deepEqual(protectedTurbo.edit_output.inputs.destination, ['crop', 0]);
assert.deepEqual(protectedTurbo.edit_output.inputs.mask, ['edit_mask', 0]);
assert.deepEqual(protectedTurbo.save.inputs.images, ['edit_output', 0]);
const protectedStandard = api.buildOutfitQuadWorkflow({ ...protectedOptions, outfitModel: 'qwen21' });
assert.deepEqual(protectedStandard.sample.inputs.latent_image, ['edit_latent', 0]);
const protectedMuse = api.buildOutfitQuadWorkflow({ ...protectedOptions, outfitModel: 'muse_v4' });
assert.deepEqual(protectedMuse.edit_latent.inputs.samples, ['source_latent', 0]);
assert.deepEqual(protectedMuse.patch.inputs.target_latent, ['edit_latent', 0]);
assert.deepEqual(protectedMuse.sample.inputs.latent_image, ['edit_latent', 0]);
assert.deepEqual(protectedMuse.edit_output.inputs.destination, ['crop', 0]);
assert.equal(protectedMuse.edit_latent_size, undefined);
const protectedStitch = api.buildOutfitStitchWorkflow({ tl: 'hd-tl.png', tr: 'hd-tr.png', bl: 'hd-bl.png', br: 'hd-br.png' }, protectedOptions);
for (const panel of regionPanels) {
  const protectedNode = panel.presentationCrop ? `${panel.id}_protected` : `${panel.id}_composite`;
  assert.deepEqual(protectedStitch[protectedNode].inputs.mask, [`${panel.id}_edit_mask`, 0]);
  assert.equal(protectedStitch[`${panel.id}_edit_background`].inputs.value, 0, 'HD pixels outside edit area must never reach final sheet');
  assert.equal(protectedStitch[`${panel.id}_edit_foreground`].inputs.value, 1);
  if (panel.presentationCrop) {
    assert.deepEqual(protectedStitch[protectedNode].inputs.destination, [`${panel.id}_protected_original`, 0]);
    assert.deepEqual(protectedStitch[`${panel.id}_protected_original`].inputs.image, ['source', 0]);
    assert.deepEqual(protectedStitch[protectedNode].inputs.source, [`${panel.id}_protected_resize`, 0]);
    assert.deepEqual(protectedStitch[`${panel.id}_protected_resize`].inputs.image, [`${panel.id}_load`, 0]);
    assert.deepEqual(protectedStitch[`${panel.id}_frame_crop`].inputs.image, [protectedNode, 0], 'restore original pixels before changing their coordinate space');
    assert.equal(protectedStitch[`${panel.id}_composite`].inputs.mask, undefined, 'do not apply the native mask again in cropped coordinates');
  }
}
assert.deepEqual(protectedStitch.tl_composite.inputs.destination, ['source', 0]);
assert.equal(protectedStitch.tl_composite.inputs.resize_source, false);
const protectedHdPlan = api.buildOutfitQueuePlan({ ...protectedOptions, outfitUpscale: 'seedvr2_7b' });
assert.equal(protectedHdPlan.stitch, null, 'single-panel runs must protect HD output without a stitch stage');
assert.deepEqual(protectedHdPlan.panels[0].hd.save.inputs.images, ['edit_hd_output', 0]);
assert.deepEqual(protectedHdPlan.panels[0].hd.edit_hd_output.inputs.destination, ['original_crop', 0]);
assert.deepEqual(protectedHdPlan.panels[0].hd.edit_hd_output.inputs.mask, ['edit_mask', 0]);
assert.equal(protectedHdPlan.panels[0].hd.original_source.inputs.image, 'workbench/source.png');
const optedOutPanels = regionPanels.map((panel) => ({ ...panel, preserveOutsideRegion: false }));
const optedOut = api.buildOutfitQuadWorkflow({ ...protectedOptions, outfitPanels: optedOutPanels });
assert.equal(optedOut.edit_latent, undefined);
const originalCustom = regionPanels.map(({ editRegion, ...panel }) => ({ ...panel, preserveOutsideRegion: false }));
assert.deepEqual(optedOut, api.buildOutfitQuadWorkflow({ ...protectedOptions, outfitPanels: originalCustom }), 'editRegion alone must not change existing sampling');
for (const invalid of [[-0.1, 0, 1, 1], [0, 0, 0, 1], [0.5, 0, 0.6, 1], [0, 0, 1], [0, 0, '1', 1], [0, 0, NaN, 1]]) {
  assert.throws(() => api.resolveOutfitPanels({ ...protectedOptions, outfitPanels: regionPanels.map((panel, i) => i ? panel : { ...panel, editRegion: invalid }) }), /editRegion/);
}
const defaultRegions = api.resolveOutfitPanels({ ...protectedOptions, outfitPanels: regionPanels.map(({ editRegion, ...panel }) => panel) });
for (const panel of defaultRegions) {
  assert.deepEqual(panel.editRegion, panel.role === 'portrait' ? [0, 0.72, 1, 0.28] : [0, api.OUTFIT_HEADLESS_GUARD, 1, 1 - api.OUTFIT_HEADLESS_GUARD]);
  assert.equal(panel.preserveOutsideRegion, true, 'omitted editRegion retains the explicit framing protection defaults');
}
assert.throws(() => api.resolveOutfitPanels({ ...protectedOptions, outfitPanels: regionPanels.map((panel) => ({ ...panel, preserveOutsideRegion: 'true' })) }), /布尔值/);
console.log('REGION_LOCK_OK source-latent masks, native binary composites, HD stitch protection, legacy opt-in compatibility');

// Evaluate the deterministic image/mask wiring with constant pixel fixtures.
// Resampling kernels cannot change a constant protected area; this catches HD
// contamination before a framing crop, independently of node naming assertions.
function evaluateCompositeGraph(graph, output) {
  const cache = new Map();
  const image = (width, height, value = 0) => ({ width, height, pixels: new Float64Array(width * height).fill(value) });
  const read = ([id, slot = 0]) => {
    if (cache.has(id)) return cache.get(id)[slot];
    const node = graph[id];
    const i = Object.fromEntries(Object.entries(node.inputs).map(([key, value]) => [key, Array.isArray(value) && graph[value[0]] ? read(value) : value]));
    let result;
    if (node.class_type === 'LoadImage') result = [image(100, 100, id === 'source' ? 7 : 200)];
    else if (node.class_type === 'GetImageSize') result = [i.image.width, i.image.height];
    else if (node.class_type === 'SimpleMath+') result = [Function('a', 'b', 'round', 'min', 'max', `return ${i.value}`)(i.a, i.b, Math.round, Math.min, Math.max)];
    else if (node.class_type === 'SolidMask') result = [image(i.width, i.height, i.value)];
    else if (node.class_type === 'ImageScale' || node.class_type === 'ImageCrop') {
      const out = image(i.width, i.height);
      for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
        const sx = node.class_type === 'ImageCrop' ? x + i.x : Math.min(i.image.width - 1, Math.floor(x * i.image.width / out.width));
        const sy = node.class_type === 'ImageCrop' ? y + i.y : Math.min(i.image.height - 1, Math.floor(y * i.image.height / out.height));
        out.pixels[y * out.width + x] = i.image.pixels[sy * i.image.width + sx];
      }
      result = [out];
    } else if (node.class_type === 'ImageCompositeMasked' || node.class_type === 'MaskComposite') {
      const out = { ...i.destination, pixels: i.destination.pixels.slice() };
      for (let y = 0; y < i.source.height; y++) for (let x = 0; x < i.source.width; x++) {
        const index = (y + i.y) * out.width + x + i.x;
        const alpha = i.mask ? i.mask.pixels[y * i.mask.width + x] : 1;
        out.pixels[index] = i.source.pixels[y * i.source.width + x] * alpha + out.pixels[index] * (1 - alpha);
      }
      result = [out];
    } else throw new Error(`Unexpected deterministic test node ${node.class_type}`);
    cache.set(id, result); return result[slot];
  };
  return read(output);
}
const evaluated = evaluateCompositeGraph(protectedStitch, protectedStitch.save.inputs.images);
assert.equal(evaluated.width, 100);
assert.equal(evaluated.height, 100);
for (const panel of regionPanels.filter((panel) => panel.role === 'portrait')) {
  const left = Math.round(panel.x * 100), right = Math.round((panel.x + panel.width) * 100);
  const top = Math.round(panel.y * 100), bottom = Math.round((panel.y + panel.height) * 100);
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) assert.equal(evaluated.pixels[y * 100 + x], 7, 'HD contamination must not survive in the protected cropped portrait');
}
assert.ok(evaluated.pixels.some((pixel) => pixel === 200), 'body edit regions still accept the edited image');
for (const outfitUpscale of ['off', 'auto', 'seedvr2_7b']) {
  const plan = api.buildOutfitQueuePlan({ ...protectedOptions, outfitPanel: null, outfitUpscale });
  for (const panel of plan.panels) {
    assert.deepEqual(panel.single.edit_output.inputs.mask, ['edit_mask', 0]);
    if (outfitUpscale === 'off') assert.equal(panel.hd, null);
    else assert.deepEqual(panel.hd.edit_hd_output.inputs.mask, ['edit_mask', 0]);
  }
  assert.deepEqual(plan.stitch.tl_frame_crop.inputs.image, ['tl_protected', 0]);
  assert.deepEqual(plan.stitch.bl_composite.inputs.mask, ['bl_edit_mask', 0]);
}
for (const outfitUpscale of ['auto', 'seedvr2_7b']) for (const panel of api.OUTFIT_PANELS) {
  const plan = api.buildOutfitQueuePlan({ ...base, outfitPanel: panel.id, outfitUpscale });
  const hd = plan.panels[0].hd;
  assert.equal(hd.original_panel_x, undefined, 'legacy pixel coordinates must never enter normalized geometry');
  assert.deepEqual(hd.original_sheet.inputs, { image: ['original_source', 0], upscale_method: 'lanczos', width: 768, height: 1344, crop: 'disabled' });
  assert.deepEqual(hd.original_panel_crop.inputs, { image: ['original_sheet', 0], x: panel.x, y: panel.y, width: panel.width, height: panel.height });
  assert.equal(hd.original_crop.inputs.width, panel.outputWidth);
  assert.equal(hd.original_crop.inputs.height, panel.outputHeight);
  assert.deepEqual(hd.original_crop.inputs.image, ['original_panel_crop', 0]);
  assert.equal(hd.edit_hd_resize.inputs.width, panel.outputWidth);
  assert.equal(hd.edit_hd_resize.inputs.height, panel.outputHeight);
  assert.equal(hd.edit_background.inputs.width, panel.outputWidth);
  assert.deepEqual(hd.edit_hd_output.inputs.destination, ['original_crop', 0]);
  assert.deepEqual(hd.edit_hd_output.inputs.mask, ['edit_mask', 0]);
}
console.log('OUTFIT_PRESERVATION_OK contaminated pixels blocked before framing, all queue HD policies, legacy pixel crop geometry');

const portraitGarments = [
  'a plain white fitted thin-strap camisole with a scoop neckline; only the small garment area visible along the bottom edge; same shoulder positions, no waist or abdomen',
  'light-gray textured short-sleeve collared button-front summer shirt, pale round buttons and single chest pocket; only visible collar and upper chest, same shoulder positions',
];
for (const garmentPrompt of portraitGarments) {
  const garmentPanels = regionPanels.map((panel) => panel.role === 'portrait' ? { ...panel, garmentPrompt: `  ${garmentPrompt}  ` } : panel);
  const garmentOptions = { ...protectedOptions, outfitPanels: garmentPanels, prompt: 'GLOBAL FULL OUTFIT WITH LONG TROUSERS AND SANDALS', references: [...base.references, { kind: 'image', slot: 'identity', name: 'full-body-clothing-reference.png' }] };
  assert.equal(api.resolveOutfitPanels(garmentOptions)[0].garmentPrompt, garmentPrompt);
  for (const outfitModel of ['qwen21', 'qwen21_turbo', 'muse_v4']) {
    for (const outfitPanel of ['tl', 'tr']) {
      const graph = api.buildOutfitQuadWorkflow({ ...garmentOptions, outfitModel, outfitPanel });
      const prompt = outfitModel === 'muse_v4' ? graph.positive.inputs.prompt : graph.encode.inputs.prompt;
      assert.ok(prompt.includes(garmentPrompt));
      assert.ok(!prompt.includes(garmentOptions.prompt), 'protected portrait must not receive the global full-outfit description');
      assert.ok(!prompt.includes('<image2>'), 'protected portrait has no full-body reference conditioning');
      assert.equal(graph.outfit_reference, undefined);
      if (outfitModel === 'muse_v4') {
        assert.equal(graph.positive.inputs.image_b, undefined);
        assert.equal(graph.patch.inputs.source_image_b, undefined);
        assert.equal(graph.patch.inputs.ref_position, 'aligned (trained)');
      } else assert.equal(graph.encode.inputs['images.image_2'], undefined);
    }
    const bodyGraph = api.buildOutfitQuadWorkflow({ ...garmentOptions, outfitModel, outfitPanel: 'br' });
    const bodyPrompt = outfitModel === 'muse_v4' ? bodyGraph.positive.inputs.prompt : bodyGraph.encode.inputs.prompt;
    assert.ok(bodyPrompt.includes(garmentOptions.prompt), 'body panels retain the full selected outfit');
    assert.equal(bodyGraph.outfit_reference.inputs.image, 'full-body-clothing-reference.png');
  }
  const unprotectedWithLocal = api.buildOutfitQuadWorkflow({ ...garmentOptions, outfitPanels: garmentPanels.map((panel) => ({ ...panel, preserveOutsideRegion: false })) });
  const unprotectedWithoutLocal = api.buildOutfitQuadWorkflow({ ...garmentOptions, outfitPanels: garmentPanels.map(({ garmentPrompt, ...panel }) => ({ ...panel, preserveOutsideRegion: false })) });
  assert.deepEqual(unprotectedWithLocal, unprotectedWithoutLocal, 'local prompt is opt-in for protected portraits only');
}
for (const garmentPrompt of ['', '   ', 123, {}, null]) {
  assert.throws(() => api.resolveOutfitPanels({ ...protectedOptions, outfitPanels: regionPanels.map((panel, i) => i ? panel : { ...panel, garmentPrompt }) }), /garmentPrompt/);
}
console.log('PORTRAIT_GARMENT_OK explicit per-panel garment text, no global outfit or full-body image2, body references unchanged');
