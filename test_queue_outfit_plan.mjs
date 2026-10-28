import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const api = await import('./src/workbench-api.js');

const options = {
  prompt: 'fitted summer outfit', seed: 281306, outfitLayout: 'mixedGrid',
  references: [{ kind: 'image', slot: 'guide', name: 'workbench/source.png' }],
};
const plan = api.buildOutfitQueuePlan(options);
assert.equal(plan.kind, 'outfit');
assert.equal(plan.selectedPanel, null);
assert.equal(plan.panels.length, 4);
assert.equal(plan.panels[0].hd.source.inputs.image, '__H3_OUTFIT_CURRENT__');
assert.equal(plan.stitch.tl_load.inputs.image, '__H3_OUTFIT_PANEL_tl__');
assert.equal(plan.stitch.source.inputs.image, 'workbench/source.png');
assert.equal(plan.panels[2].single.sample.inputs.seed, 281306);
assert.equal(plan.panels[2].hd.sample.inputs.seed, 281308);

const single = api.buildOutfitQueuePlan({ ...options, outfitPanel: 'br' });
assert.equal(single.selectedPanel, 'br');
assert.equal(single.panels.length, 1);
assert.equal(single.stitch, null);
assert.equal(single.panels[0].single.save.inputs.filename_prefix, 'image/H3_OutfitSingle_br');
assert.throws(() => api.buildOutfitQueuePlan({ ...options, outfitPanel: 'bad' }), /未知/);
console.log('OUTFIT_QUEUE_PLAN_OK panels=4 placeholders=true single=true');
