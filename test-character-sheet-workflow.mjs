import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const {
  buildCharacterSheetWorkflow,
  buildCharacterSheetQueuePlan,
  buildCharacterSheetPanelPrompt,
  CHARACTER_SHEET_BODY_CROP,
  CHARACTER_SHEET_PANEL,
  CHARACTER_SHEET_VIEWS,
  CHARACTER_SHEET_PROMPT_VERSION,
  QWEN21_EDIT_MODEL,
} = await import('./src/workbench-api.js');
const { validateModelSettings } = await import('./src/canvas-mcp.js');

assert.deepEqual(CHARACTER_SHEET_PANEL, { width: 1152, height: 2048 });
assert.equal(CHARACTER_SHEET_PANEL.width * 16, CHARACTER_SHEET_PANEL.height * 9);
assert.deepEqual(CHARACTER_SHEET_BODY_CROP, { x: 108, y: 384, width: 936, height: 1664 });
assert.equal(CHARACTER_SHEET_BODY_CROP.width * 16, CHARACTER_SHEET_BODY_CROP.height * 9);
assert.equal(CHARACTER_SHEET_BODY_CROP.x * 2 + CHARACTER_SHEET_BODY_CROP.width, CHARACTER_SHEET_PANEL.width);
assert.equal(CHARACTER_SHEET_VIEWS.length, 4);
assert.equal(CHARACTER_SHEET_PROMPT_VERSION, 'portrait-proportions-v2');
const options = {
  prompt: '写实男性角色，现代夏装，九头身、宽肩窄腰、自然长腿比例。',
  seed: 281306,
  qwenSteps: 40,
  qwenRefResolution: 1536,
  references: [{ kind: 'image', slot: 'guide', name: 'workbench/character.png' }],
};
const graph = buildCharacterSheetWorkflow(options);
assert.equal(graph.source.inputs.image, 'workbench/character.png');
assert.equal(graph.reference.class_type, 'ResizeAndPadImage');
assert.equal(graph.reference.inputs.target_width, 1152);
assert.equal(graph.reference.inputs.target_height, 2048);
assert.equal(graph.reference.inputs.padding_color, 'white');
assert.equal(graph.model.inputs.unet_name, QWEN21_EDIT_MODEL.unet);
assert.equal(graph.realism, undefined);
assert.equal(Object.values(graph).filter((node) => node.class_type === 'TextEncodeQwenImage21').length, 4);
assert.equal(Object.values(graph).filter((node) => node.class_type === 'KSampler').length, 4);
assert.equal(Object.values(graph).filter((node) => node.class_type === 'VAEDecode').length, 4);
assert.equal(Object.values(graph).filter((node) => node.class_type === 'ImageStitch').length, 3);
assert.equal(Object.values(graph).filter((node) => node.class_type === 'ImageCrop').length, 2);
assert.equal(Object.values(graph).filter((node) => node.class_type === 'SaveImage').length, 1, 'only the final sheet is saved');
assert.equal(Object.values(graph).some((node) => /SeedVR2|Upscale|ImageHd/i.test(node.class_type)), false);
for (const [index, view] of CHARACTER_SHEET_VIEWS.entries()) {
  const encode = graph[`${view.id}_encode`];
  const sample = graph[`${view.id}_sample`];
  const isThreeQuarter = view.id === 'three_quarter_portrait';
  assert.deepEqual(encode.inputs['images.image_1'], isThreeQuarter ? ['front_portrait_decode', 0] : view.id === 'back_body' ? ['front_body_decode', 0] : ['reference', 0]);
  assert.equal(encode.inputs.resolution, 1536);
  assert.equal(sample.inputs.steps, 40);
  assert.equal(sample.inputs.seed, isThreeQuarter ? 2096285145 : options.seed + view.seedOffset);
  if (isThreeQuarter) {
    assert.match(encode.inputs.prompt, /只修改头部和视线方向/);
    assert.match(encode.inputs.prompt, /向角色左侧45度/);
    assert.match(encode.inputs.prompt, /下沿锁骨的近景、头部大小与位置/);
    assert.match(encode.inputs.prompt, /五官身份、发型、可见上衣、浅灰背景、光线和画质不变/);
    assert.doesNotMatch(encode.inputs.prompt, /黑色短发|白色T恤/);
  } else {
    assert.match(encode.inputs.prompt, /#D9D9D9/);
    assert.match(encode.inputs.prompt, /exactly ONE INSTANCE/);
    assert.match(encode.inputs.prompt, /ONE pose, from ONE camera angle/);
  }
  // Full-body creative requirements must never leak into either portrait.
  assert.equal(encode.inputs.prompt.includes(options.prompt), index >= 2);
  assert.doesNotMatch(encode.inputs.prompt, /FIXED PORTRAIT GEOMETRY|chin is at 62–66%|head from hair top to chin occupies about 55–60%/);
  assert.doesNotMatch(encode.inputs.prompt, /deterministic post-crop|Generate one natural head temporarily/);
  assert.doesNotMatch(encode.inputs.prompt, /adult woman|white camisole|purple butterfly|forehead ornament|top bun|denim shorts|barefoot/i, 'no female-reference-specific hardcoding');
  assert.deepEqual(graph[`${view.id}_decode`].inputs.samples, [`${view.id}_sample`, 0]);
  assert.equal(index < 2, !/HEAD-TO-TOE FULL-BODY/.test(encode.inputs.prompt));
}
assert.match(graph.front_portrait_encode.inputs.prompt, /FRONT-FACING HEAD CLOSE-UP IDENTITY PORTRAIT/);
assert.match(graph.front_portrait_encode.inputs.prompt, /Long hair lengths naturally continue beyond the lower edge/);
assert.match(graph.front_portrait_encode.inputs.prompt, /complete crown, scalp and side hair framing/);
assert.match(graph.front_portrait_encode.inputs.prompt, /small clear margin above the topmost hair/);
assert.match(graph.front_portrait_encode.inputs.prompt, /facing directly into the camera/);
assert.match(graph.front_portrait_encode.inputs.prompt, /head upright without tilt/);
assert.match(graph.three_quarter_portrait_encode.inputs.prompt, /不要拉远/);
assert.match(graph.three_quarter_portrait_encode.inputs.prompt, /不要改变画幅/);
// Character briefs can change complete outfits without changing the fixed portraits.
for (const id of ['front_portrait', 'three_quarter_portrait']) {
  assert.equal(buildCharacterSheetPanelPrompt('red coat, boots, long legs', id), buildCharacterSheetPanelPrompt('blue dress, sandals', id));
}
assert.notEqual(buildCharacterSheetPanelPrompt('red coat', 'front_body'), buildCharacterSheetPanelPrompt('blue dress', 'front_body'));
for (const id of ['back_body', 'front_body']) {
  assert.match(graph[`${id}_encode`].inputs.prompt, /HEAD-TO-TOE FULL-BODY/);
  assert.match(graph[`${id}_encode`].inputs.prompt, /one complete natural head/);
  assert.doesNotMatch(graph[`${id}_encode`].inputs.prompt, /base of the neck near 18%/);
  assert.match(graph[`${id}_encode`].inputs.prompt, /Both arms, hands, legs and feet remain fully inside the frame/);
  assert.match(graph[`${id}_encode`].inputs.prompt, /both feet fully visible/);
  assert.equal(graph[`${id}_crop`], undefined);
  assert.equal(graph[`${id}_output`], undefined);
}
assert.deepEqual(graph.top_row.inputs.image1, ['front_portrait_decode', 0]);
assert.deepEqual(graph.top_row.inputs.image2, ['three_quarter_portrait_decode', 0]);
assert.deepEqual(graph.bottom_row.inputs.image1, ['back_body_delivery_pad', 0]);
assert.deepEqual(graph.bottom_row.inputs.image2, ['front_body_delivery_pad', 0]);
assert.deepEqual(graph.save.inputs.images, ['quad', 0]);
assert.equal(graph.save.inputs.filename_prefix, 'image/H3_CharacterSheet');
assert.equal(graph.top_row.inputs.match_image_size, false);
assert.equal(graph.bottom_row.inputs.spacing_width, 0);
assert.equal(graph.quad.inputs.spacing_width, 0);
const finalSize = [CHARACTER_SHEET_PANEL.width * 2, CHARACTER_SHEET_PANEL.height * 2];
assert.deepEqual(finalSize, [2304, 4096]);
assert.equal(finalSize[0] * 16, finalSize[1] * 9);

const realism = buildCharacterSheetWorkflow({ ...options, imageLora: 'qwen21Realism', loraStrength: 0.8 });
assert.equal(realism.realism.inputs.lora_name, QWEN21_EDIT_MODEL.realismLora);
assert.equal(realism.realism.inputs.strength_model, 0.8);
for (const view of CHARACTER_SHEET_VIEWS) assert.deepEqual(realism[`${view.id}_sample`].inputs.model, ['realism', 0]);
for (const characterSheetAngleSeed of [0, 42, Number.MAX_SAFE_INTEGER]) {
  assert.doesNotThrow(() => validateModelSettings({ characterSheetAngleSeed }));
  const overridden = buildCharacterSheetWorkflow({ ...options, characterSheetAngleSeed });
  const expected = structuredClone(graph);
  expected.three_quarter_portrait_sample.inputs.seed = characterSheetAngleSeed;
  assert.deepEqual(overridden, expected, 'angle override changes only its sampler seed');
}
for (const characterSheetAngleSeed of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, '42', true, {}, []]) {
  assert.throws(() => validateModelSettings({ characterSheetAngleSeed }), /characterSheetAngleSeed/);
  assert.throws(() => buildCharacterSheetWorkflow({ ...options, characterSheetAngleSeed }), /characterSheetAngleSeed/);
}
const changedMainSeed = buildCharacterSheetWorkflow({ ...options, seed: 123 });
for (const view of CHARACTER_SHEET_VIEWS) {
  assert.equal(changedMainSeed[`${view.id}_sample`].inputs.seed, view.id === 'three_quarter_portrait' ? 2096285145 : 123 + view.seedOffset);
}
assert.throws(() => buildCharacterSheetWorkflow({ ...options, references: [] }), /一张单人角色参考图/);
assert.doesNotThrow(() => buildCharacterSheetWorkflow({ ...options, prompt: '  ' }), 'reference-only generation is valid');
assert.throws(() => buildCharacterSheetPanelPrompt('test', 'unknown'), /未知/);
for (const settings of [options, { ...options, imageLora: 'qwen21Realism', loraStrength: 0.8, characterSheetAngleSeed: 42 }]) {
  const referenceGraph = buildCharacterSheetWorkflow(settings);
  const plan = buildCharacterSheetQueuePlan(settings);
  assert.equal(plan.kind, 'characterSheet');
  assert.equal(plan.memoryPolicy, 'preserve');
  assert.deepEqual(plan.panels.map((panel) => panel.id), CHARACTER_SHEET_VIEWS.map((view) => view.id));
  for (const panel of plan.panels) {
    const dependency = panel.id === 'three_quarter_portrait' ? 'front_portrait' : panel.id === 'back_body' ? 'front_body' : null;
    const angle = Boolean(dependency);
    assert.deepEqual(panel.dependsOn, dependency ? [dependency] : []);
    assert.equal(Object.values(panel.single).filter((node) => node.class_type === 'KSampler').length, 1);
    assert.equal(Object.values(panel.single).filter((node) => node.class_type === 'SaveImage').length, 1);
    assert.equal(Object.values(panel.single).some((node) => node.class_type === 'ImageStitch'), false);
    assert.equal(panel.single.save.inputs.filename_prefix, `image/H3_CharacterSheetPanel_${panel.id}`);
    assert.deepEqual(panel.single.save.inputs.images, [`${panel.id}_decode`, 0]);
    for (const [id, node] of Object.entries(panel.single)) {
      if (id === 'save') continue;
      if (id === 'angle_source') {
        assert.deepEqual(node, { class_type: 'LoadImage', inputs: { image: `__H3_CHARACTER_SHEET_PANEL_${dependency}__` } });
      } else if (angle && id === `${panel.id}_encode`) {
        const expected = structuredClone(referenceGraph[id]);
        expected.inputs['images.image_1'] = ['angle_source', 0];
        assert.deepEqual(node, expected);
      } else assert.deepEqual(node, referenceGraph[id], `${panel.id}/${id} keeps the original graph configuration`);
    }
    assert.equal(panel.single.front_portrait_decode !== undefined, panel.id === 'front_portrait');
    assert.equal(panel.single.reference !== undefined, !angle, 'saved front is loaded directly, without rescaling');
  }
  assert.deepEqual(Object.values(plan.stitch).map((node) => node.class_type).sort(), [...Array(4).fill('LoadImage'), ...Array(3).fill('ImageStitch'), ...Array(2).fill('ImageCrop'), ...Array(2).fill('ResizeAndPadImage'), 'SaveImage'].sort());
  for (const view of CHARACTER_SHEET_VIEWS) assert.equal(plan.stitch[`${view.id}_load`].inputs.image, `__H3_CHARACTER_SHEET_PANEL_${view.id}__`);
  assert.deepEqual(plan.stitch.save, referenceGraph.save);
  assert.deepEqual(plan.stitch.quad, referenceGraph.quad);
  assert.deepEqual(plan.stitch.top_row.inputs.image1, ['front_portrait_load', 0]);
  assert.deepEqual(plan.stitch.top_row.inputs.image2, ['three_quarter_portrait_load', 0]);
  assert.deepEqual(plan.stitch.bottom_row.inputs.image1, ['back_body_delivery_pad', 0]);
  assert.deepEqual(plan.stitch.bottom_row.inputs.image2, ['front_body_delivery_pad', 0]);
}
for (const imageLora of ['none', 'qwen21Realism']) {
  const settings = { ...options, imageLora };
  const baseline = buildCharacterSheetWorkflow(settings);
  assert.deepEqual(buildCharacterSheetWorkflow({ ...settings, qwenCacheDevice: 'auto' }), baseline);
  const cpu = buildCharacterSheetWorkflow({ ...settings, qwenCacheDevice: 'cpu' });
  const model = [imageLora === 'qwen21Realism' ? 'realism' : 'model', 0];
  assert.deepEqual(cpu.cache, { class_type: 'QwenImage21Cache', inputs: { model, device: 'cpu', dtype: 'default' } });
  for (const view of CHARACTER_SHEET_VIEWS) {
    assert.deepEqual(cpu[`${view.id}_sample`].inputs.model, ['cache', 0]);
    cpu[`${view.id}_sample`].inputs.model = model;
  }
  delete cpu.cache;
  assert.deepEqual(cpu, baseline, 'cache option leaves prompts, sampling, sources, crops and stitch untouched');
  const plan = buildCharacterSheetQueuePlan({ ...settings, qwenCacheDevice: 'cpu' });
  const baselinePlan = buildCharacterSheetQueuePlan(settings);
  assert.deepEqual(plan.stitch, baselinePlan.stitch);
  for (const [index, panel] of plan.panels.entries()) {
    assert.deepEqual(panel.single.cache, { class_type: 'QwenImage21Cache', inputs: { model, device: 'cpu', dtype: 'default' } });
    assert.deepEqual(panel.single[`${panel.id}_sample`].inputs.model, ['cache', 0]);
    panel.single[`${panel.id}_sample`].inputs.model = model;
    delete panel.single.cache;
    assert.deepEqual(panel, baselinePlan.panels[index], 'each persisted stage inherits only cache placement');
  }
}
for (const qwenCacheDevice of ['gpu', 'off', 'int8', '', null, 0, true, {}, []]) {
  assert.throws(() => buildCharacterSheetWorkflow({ ...options, qwenCacheDevice }), /qwenCacheDevice/);
  assert.throws(() => buildCharacterSheetQueuePlan({ ...options, qwenCacheDevice }), /qwenCacheDevice/);
}
console.log('CHARACTER_SHEET_WORKFLOW_OK preserved model/cache/seed/stitch invariants, full bodies, dependent back view');

// New production controls and single-stage regression coverage.
{

globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildCharacterSheetWorkflow, buildCharacterSheetQueuePlan, buildCharacterSheetPanelPrompt, CHARACTER_SHEET_VIEWS } = await import('./src/workbench-api.js');
const { validateModelSettings } = await import('./src/canvas-mcp.js');
const { CHARACTER_SHEET_PRESETS, characterSheetBodyInstructions } = await import('./src/character-sheet-settings.js');
const options = { seed: 281306, prompt: 'Red coat, boots, nine-head body', qwenSteps:40, references:[{kind:'image',slot:'guide',name:'accepted.png'}] };
const graph=buildCharacterSheetWorkflow(options);
assert.equal(graph.reference.class_type,'ResizeAndPadImage');
assert.equal(graph.reference.inputs.target_width,1152);
assert.equal(graph.reference.inputs.target_height,2048);
assert.equal(Object.values(graph).filter(n=>n.class_type==='KSampler').length,4);
assert.equal(Object.values(graph).filter(n=>n.class_type==='ImageCrop').length,2);
for (const id of ['front_portrait','three_quarter_portrait']) {
  const prompt=graph[`${id}_encode`].inputs.prompt;
  assert.doesNotMatch(prompt,/Red coat|nine-head|CHEST-UP|18%/);
  assert.equal(buildCharacterSheetPanelPrompt('pants',id),buildCharacterSheetPanelPrompt('dress',id));
  assert.match(buildCharacterSheetPanelPrompt('',id,{characterSheetPortraitBrief:'preserve freckles'}),/preserve freckles/);
}
assert.match(graph.front_portrait_encode.inputs.prompt,/HEAD CLOSE-UP/);
assert.match(graph.front_portrait_encode.inputs.prompt,/clavicle/);
assert.match(graph.front_portrait_encode.inputs.prompt,/Long hair lengths naturally continue beyond the lower edge/);
assert.match(graph.three_quarter_portrait_encode.inputs.prompt,/长发可自然延伸到下沿画外/);
assert.doesNotMatch(characterSheetBodyInstructions({characterSheetPreset:'heroic_nine_head'}),/Where the reference is unclear/);
assert.deepEqual(graph.back_body_encode.inputs['images.image_1'],['front_body_decode',0]);
for (const id of ['front_body','back_body']) {
 assert.match(graph[`${id}_encode`].inputs.prompt,/HEAD-TO-TOE FULL-BODY/);
 assert.doesNotMatch(graph[`${id}_encode`].inputs.prompt,/18%|95%/);
 assert.match(graph[`${id}_encode`].inputs.prompt,/Red coat/);
}
for (const preset of Object.keys(CHARACTER_SHEET_PRESETS)) {
 const configured={characterSheetPreset:preset,characterSheetHeadRatio:8.5,characterSheetBuild:'stocky',characterSheetLegs:'short',characterSheetTorso:'long',characterSheetShoulders:'narrow',characterSheetHips:'wide',characterSheetPosture:'neutral',characterSheetPreserveTraits:'scar'};
 assert.doesNotThrow(()=>validateModelSettings(configured));
 const prompt=characterSheetBodyInstructions(configured);
 for (const word of ['1:8.5','stocky','short','long','narrow','wide','neutral','scar']) assert.ok(prompt.includes(word));
 assert.match(prompt,/explicit numeric\/text requirements override the selected preset/);
 assert.match(prompt,/apply its specified attributes even when the reference differs/);
}
for (const invalid of [{characterSheetPreset:'x'},{characterSheetStage:'x'},{characterSheetHeadRatio:1},{characterSheetHeadRatio:13},{characterSheetHeadRatio:'9'},{characterSheetLegs:4}]) {
 assert.throws(()=>validateModelSettings(invalid));
 assert.throws(()=>buildCharacterSheetWorkflow({...options,...invalid}));
}
const plan=buildCharacterSheetQueuePlan(options);
assert.deepEqual(plan.panels.map(p=>p.id),['front_portrait','three_quarter_portrait','front_body','back_body']);
for (const panel of plan.panels) {
 const dependency=panel.id==='three_quarter_portrait'?'front_portrait':panel.id==='back_body'?'front_body':null;
 assert.deepEqual(panel.dependsOn,dependency?[dependency]:[]);
 assert.equal(Object.values(panel.single).filter(n=>n.class_type==='KSampler').length,1);
 assert.equal(Object.values(panel.single).filter(n=>n.class_type==='SaveImage').length,1);
 assert.deepEqual(panel.single.save.inputs.images,[`${panel.id}_decode`,0]);
 if (dependency) assert.deepEqual(Object.values(panel.single).filter(n=>n.class_type==='LoadImage').map(n=>n.inputs.image),[`__H3_CHARACTER_SHEET_PANEL_${dependency}__`]);
}
assert.deepEqual(plan.stitch.bottom_row.inputs.image1,['back_body_delivery_pad',0]);
assert.deepEqual(plan.stitch.bottom_row.inputs.image2,['front_body_delivery_pad',0]);
for (const {id} of CHARACTER_SHEET_VIEWS) for (const seed of [0,123456]) {
 const {workflow}=buildCharacterSheetQueuePlan({...options,characterSheetStage:id,seed,characterSheetAngleSeed:999});
 assert.equal(Object.values(workflow).filter(n=>n.class_type==='KSampler').length,1);
 assert.equal(workflow[`${id}_sample`].inputs.seed,seed);
 assert.deepEqual(Object.values(workflow).filter(n=>n.class_type==='LoadImage').map(n=>n.inputs.image),['accepted.png']);
 assert.equal(workflow.save.inputs.filename_prefix,`image/H3_CharacterSheet_${id}`);
}
for (const characterSheetAngleSeed of [0,42,Number.MAX_SAFE_INTEGER]) assert.equal(buildCharacterSheetWorkflow({...options,characterSheetAngleSeed}).three_quarter_portrait_sample.inputs.seed,characterSheetAngleSeed);
for (const characterSheetAngleSeed of [-1,1.5,'42',null]) assert.throws(()=>buildCharacterSheetWorkflow({...options,characterSheetAngleSeed}));
const cpu=buildCharacterSheetWorkflow({...options,qwenCacheDevice:'cpu',imageLora:'qwen21Realism',loraStrength:.8});
assert.equal(cpu.cache.inputs.device,'cpu');
assert.equal(cpu.realism.inputs.strength_model,.8);
for(const {id} of CHARACTER_SHEET_VIEWS) assert.deepEqual(cpu[`${id}_sample`].inputs.model,['cache',0]);
console.log('character-sheet presets, prompt isolation, dependencies, single-panel seeds and schema passed');

}

const delivery = {x:50,y:400,width:1000,height:1600};
const croppedPlan=buildCharacterSheetQueuePlan({...options,characterSheetDeliveryCrop:delivery});
assert.deepEqual(croppedPlan.panels,buildCharacterSheetQueuePlan(options).panels,'delivery crop cannot change raw generation or back conditioning');
for (const id of ['front_body','back_body']) assert.deepEqual(croppedPlan.stitch[`${id}_delivery_crop`].inputs,{image:[`${id}_load`,0],...delivery});
for (const crop of [{...delivery,x:-1},{...delivery,width:1200},{...delivery,y:0.5},{...delivery,height:0},{...delivery,extra:1},null]) assert.throws(()=>buildCharacterSheetQueuePlan({...options,characterSheetDeliveryCrop:crop}),/characterSheetDeliveryCrop/);
