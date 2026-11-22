import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCharacterSheetWorkflow, buildCharacterSheetQueuePlan } from './src/workbench-api.js';
import { resolveCharacterSheetRecipe } from './src/character-sheet-recipe.js';
import { validateCharacterSheetSettings } from './src/character-sheet-settings.js';
import { planCanvasConnection } from './src/canvas-connections.js';
import { nodeSummary, validateModelSettings } from './src/canvas-mcp.js';

const options = {
  seed: 7, prompt: 'Keep the supplied costume and proportions.',
  characterSheetIdentityMode: 'source-anchored-v1',
  references: [
    { kind: 'image', slot: 'guide', name: 'identity.png' },
    { kind: 'image', slot: 'body_reference', name: 'body.png' },
    { kind: 'image', slot: 'back_reference', name: 'rear.png' },
  ],
};
const graph = buildCharacterSheetWorkflow(options);
assert.equal(graph.body_source.inputs.image, 'body.png');
assert.equal(graph.back_source.inputs.image, 'rear.png');
assert.deepEqual(graph.front_body_encode.inputs['images.image_1'], ['body_reference', 0]);
assert.deepEqual(graph.front_body_encode.inputs['images.image_2'], ['front_portrait_decode', 0]);
assert.deepEqual(graph.back_body_encode.inputs['images.image_1'], ['front_body_decode', 0]);
assert.deepEqual(graph.back_body_encode.inputs['images.image_2'], ['back_reference', 0]);
assert.deepEqual(graph.three_quarter_portrait_encode.inputs['images.image_2'], ['portrait_reference', 0]);
for (const id of ['front_body', 'back_body']) {
  assert.equal(graph[`${id}_delivery_crop`].class_type, 'ImageCrop');
  assert.ok(graph[`${id}_delivery_crop`].inputs.y > 0, 'body delivery is cropped below the head');
  assert.deepEqual(graph[`${id}_delivery_pad`].inputs.image, [`${id}_delivery_crop`, 0]);
}
assert.deepEqual(graph.bottom_row.inputs.image1, ['back_body_delivery_pad', 0]);
assert.deepEqual(graph.bottom_row.inputs.image2, ['front_body_delivery_pad', 0]);
assert.match(graph.front_portrait_encode.inputs.prompt, /close-up|chest-above/i);
const plan = buildCharacterSheetQueuePlan(options);
assert.equal(plan.referenceMode, 'identityBodyBack');
assert.equal(plan.fidelityMode, 'sourceAnchored');
assert.deepEqual(plan.panels.map(p => p.id), ['front_portrait', 'three_quarter_portrait', 'front_body', 'back_body']);
assert.deepEqual(plan.panels[3].dependsOn, ['front_body']);
assert.ok(plan.panels[3].withoutBackSingle);
assert.ok(!Object.values(plan.panels[3].withoutBackSingle).some(n => n.inputs.image === 'rear.png'));

const sanitized = resolveCharacterSheetRecipe({ ...options,
  characterSheetFrozenPrompts: { front_portrait: 'OVERRIDE_SENTINEL' },
  characterSheetFrozenModelNodes: { source: {} },
});
assert.equal(sanitized.characterSheetFrozenPrompts, undefined);
assert.equal(sanitized.characterSheetFrozenModelNodes, undefined);
assert.throws(() => resolveCharacterSheetRecipe({ ...options, characterSheetRecipeVersion: 'unrecognized-private-recipe' }));
assert.throws(() => validateCharacterSheetSettings({ characterSheetDeliveryCrop: { x: 0, y: 0, width: 2000, height: 2048 } }));
assert.throws(() => validateModelSettings({ characterSheetStage: 'all' }, 'image'));
const summary = nodeSummary({ id: 'sheet', type: 'generator', position: { x: 0, y: 0 }, data: {
  mode: 'characterSheet', characterSheetStage: 'all', characterSheetPortraitBrief: 'text', characterSheetDeliveryCrop: { x: 100, y: 400, width: 900, height: 1600 },
} }, false);
assert.equal(summary.characterSheetPortraitBrief, undefined);
assert.equal(summary.characterSheetStage, 'all');
const source = { id: 'image', type: 'media', data: { kind: 'image' } };
const target = { id: 'sheet', type: 'generator', data: { mode: 'characterSheet' } };
for (const role of ['body_reference', 'back_reference']) {
  const result = planCanvasConnection({ source: source.id, target: target.id, targetHandle: role }, [source, target], []);
  assert.equal(result.error, undefined);
  assert.equal(result.connection.targetHandle, role);
  assert.equal(result.multiple, false);
}
const canvas = await readFile(new URL('./src/CanvasWorkbench.jsx', import.meta.url), 'utf8');
assert.match(canvas, /mode === 'characterSheet' && \['body_reference', 'back_reference'\]\.includes\(source\.data\.slot\)/,
  'visible connected references must reach the existing upload/build path');
assert.match(canvas, /characterSheetWorkflow \? characterSheetWorkflow/,
  'single-stage retries must use the selected graph');
console.log('GENERIC_CHARACTER_SHEET_OK dual/back roles, anchored identity, headless delivery, private-field rejection and UI glue');
