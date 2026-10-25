import assert from 'node:assert/strict';

globalThis.window = { location: { hostname: '127.0.0.1' } };
const { RATIOS, buildWorkflow, buildReferenceWorkflow, resolveDimensions } = await import('./src/workbench-api.js');

assert.deepEqual(resolveDimensions('16:9'), [832, 480], 'Existing canvases keep their original 480P size');
assert.deepEqual(resolveDimensions('9:16', '720P'), [736, 1248]);
assert.deepEqual(resolveDimensions('16:9', '1080P'), [1888, 1088]);
assert.deepEqual(resolveDimensions('9:16', '1080P'), [1088, 1888]);

for (const ratio of Object.keys(RATIOS)) {
  for (const resolution of ['480P', '720P', '1080P']) {
    const [width, height] = resolveDimensions(ratio, resolution);
    assert.equal(width % 32, 0);
    assert.equal(height % 32, 0);
    const options = { prompt: 'test', ratio, resolution, duration: 5, seed: 42, references: [] };
    const textWorkflow = buildWorkflow(options);
    const referenceWorkflow = buildReferenceWorkflow(options);
    assert.equal(textWorkflow['7'].inputs.width, width);
    assert.equal(textWorkflow['7'].inputs.height, height);
    assert.equal(referenceWorkflow['7'].inputs.width, width);
    assert.equal(referenceWorkflow['7'].inputs.height, height);
  }
}

console.log(JSON.stringify({ defaultPreserved: true, portrait720: true, portrait1080: true, allRatios: true, textAndReferenceWorkflows: true }, null, 2));
