import assert from 'node:assert/strict';
import { NODE_PRESETS, describeNodeModels, validateModelSettings } from './src/canvas-mcp.js';

assert.equal(NODE_PRESETS.outfit_edit[1].outfitModel, undefined, 'legacy preset keeps its original defaults');
assert.equal(describeNodeModels({}).outfitSteps, 40);
assert.match(describeNodeModels({}).outfitHdLabel, /3B/);
assert.match(describeNodeModels({}).upscaleModelLabel, /3B/);
const plain = NODE_PRESETS.outfit_qwen21_turbo[1];
const hd = NODE_PRESETS.outfit_qwen21_turbo_7b[1];
const muse = NODE_PRESETS.outfit_muse_v4[1];
assert.equal(describeNodeModels({ ...plain, qwenSteps: 40 }).outfitSteps, 8);
assert.equal(describeNodeModels({ qwenModel: 'turbo', qwenSteps: 25 }).qwenSteps, 8);
assert.equal(plain.outfitUpscale, 'off');
assert.equal(hd.outfitUpscale, 'seedvr2_7b');
assert.equal(muse.outfitUpscale, 'off');
assert.equal(describeNodeModels(muse).outfitSteps, 16);
assert.match(describeNodeModels(muse).outfitModelLabel, /Identity V2/);
assert.match(describeNodeModels(hd).outfitHdLabel, /7B/);
assert.equal(plain.seed, hd.seed);
assert.equal(plain.seed, muse.seed, 'comparison presets use one reproducible seed');
const characterSheet = NODE_PRESETS.character_sheet[1];
assert.equal(characterSheet.mode, 'characterSheet');
assert.equal(characterSheet.title, '角色四视图生成');
assert.equal(characterSheet.randomSeed, false);
assert.equal(characterSheet.qwenSteps, 40);
for (const settings of [plain, hd, muse, NODE_PRESETS.qwen_turbo_edit[1], NODE_PRESETS.image_upscale_7b[1], characterSheet]) validateModelSettings(settings);
for (const settings of [{ outfitModel: 'muse_v3' }, { qwenModel: '7B' }, { outfitUpscale: 'always' }, { upscaleModel: 'seedvr2_9b' }, { outfitHdScale: 5 }, { museSteps: 7 }, { museSteps: 8.5 }]) {
  assert.throws(() => validateModelSettings(settings));
}
console.log('VERSIONED_CANVAS_MODELS_OK legacyDefaults=true turbo8=true hdBranches=true museV4=true');
