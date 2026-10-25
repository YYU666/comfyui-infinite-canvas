import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const api = await import('./src/workbench-api.js');
assert.equal(api.durationToFrames(5), 124);
assert.equal(api.durationToFrames(6), 141);
assert.equal(api.durationToFrames(15), 362);
for (const [ratio, [w, h]] of Object.entries(api.RATIOS)) {
  assert.ok(Math.abs(w * h - 400000) < 12000, `${ratio} pixel budget`);
  assert.equal(w % 32, 0); assert.equal(h % 32, 0);
}
const base = { prompt: 'test', ratio: '16:9', duration: 5, seed: 42, turbo: true };
const turbo = api.buildWorkflow(base);
assert.equal(turbo['11'].inputs.steps, 8);
assert.equal(turbo['3'].inputs.model[0], '2');
assert.equal(turbo['7'].inputs.length, 124);
const standard = api.buildWorkflow({ ...base, turbo: false });
assert.equal(standard['2'], undefined);
assert.equal(standard['3'].inputs.model[0], '1');
assert.equal(standard['11'].inputs.steps, 30);
const image = api.buildWorkflow({ ...base, firstFrame: 'workbench/a.png', lastFrame: 'workbench/b.png' });
assert.deepEqual(image['7'].inputs.first_frame, ['17', 0]);
assert.deepEqual(image['7'].inputs.last_frame, ['18', 0]);
const files = api.extractVideos({ outputs: { '16': { videos: [{ filename: 'H3_Workbench_00001_.mp4', subfolder: 'video', type: 'output' }] } } });
assert.equal(files.length, 1);
assert.ok(files[0].url.includes('H3_Workbench_00001_.mp4'));
console.log('API_TESTS_OK: durations, ratios, turbo, standard, first/last frames, history parsing');
