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
assert.equal(turbo['11'].inputs.scheduler, 'beta');
assert.equal(turbo['3'].inputs.model[0], '2');
assert.equal(turbo['7'].inputs.length, 124);
const standard = api.buildWorkflow({ ...base, turbo: false });
assert.equal(standard['2'], undefined);
assert.equal(standard['3'].inputs.model[0], '1');
assert.equal(standard['11'].inputs.steps, 20);
assert.equal(standard['11'].inputs.scheduler, 'beta');
const image = api.buildWorkflow({ ...base, firstFrame: 'workbench/a.png', lastFrame: 'workbench/b.png' });
assert.deepEqual(image['7'].inputs.first_frame, ['17', 0]);
assert.deepEqual(image['7'].inputs.last_frame, ['18', 0]);
const files = api.extractVideos({ outputs: { '16': { videos: [{ filename: 'H3_Workbench_00001_.mp4', subfolder: 'video', type: 'output' }] } } });
assert.equal(files.length, 1);
assert.ok(files[0].url.includes('H3_Workbench_00001_.mp4'));
const swapOptions = {
  ...base, prompt: 'Female, short black bob hair, oval face, red jacket', preserveBackground: true,
  references: [{ kind: 'video', slot: 'guide', name: 'workbench/guide.mp4' }, { kind: 'image', slot: 'identity', name: 'workbench/identity.png' }],
};
const swap = api.buildCharacterSwapWorkflow(swapOptions);
assert.equal(swap['17'].inputs.lora_name, api.CHARACTER_SWAP_MODELS.characterLora);
assert.equal(swap['19'].inputs.image[0], '104');
assert.equal(swap['104'].inputs.length, 124);
assert.equal(swap['105'].class_type, 'TrimAudioDuration');
assert.equal(swap['105'].inputs.duration, 124 / 24);
assert.equal(swap['19'].inputs.frame_idx, 0);
assert.equal(swap['7'].inputs.ref_videos, undefined);
assert.ok(swap['7'].inputs.prompt.startsWith('body_swap:'));
assert.equal(swap['8'].inputs.cfg, 1);
assert.equal(swap['10'].inputs.sampler_name, 'euler');
assert.equal(swap['11'].inputs.scheduler, 'simple');
assert.equal(swap['11'].inputs.steps, 8);
assert.deepEqual(swap['15'].inputs.audio, ['105', 0]);
assert.deepEqual(swap['15'].inputs.images, ['23', 0]);
assert.equal(swap['25'].class_type, 'SAM3_VideoTrack');
assert.equal(swap['24'].inputs.threshold, 0.35);
assert.equal(swap['25'].inputs.max_objects, 8);
assert.equal(swap['28'].class_type, 'SAM3_TrackPreview');
const swapWhole = api.buildCharacterSwapWorkflow({ ...swapOptions, preserveBackground: false });
assert.deepEqual(swapWhole['15'].inputs.images, ['13', 0]);
assert.equal(swapWhole['25'], undefined);
console.log('API_TESTS_OK: durations, ratios, turbo, standard, frames, character swap, SAM, original audio');
