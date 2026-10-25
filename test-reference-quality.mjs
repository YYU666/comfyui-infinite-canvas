import assert from 'node:assert/strict';

globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildReferenceWorkflow } = await import('./src/workbench-api.js');
const references = [
  { kind: 'image', title: '角色参考', name: 'workbench/character.png' },
  { kind: 'video', title: '动作参考', name: 'workbench/dance.mp4' },
];
const base = { prompt: '@角色参考 模仿 @动作参考 的舞蹈', references, ratio: '9:16', duration: 5, seed: 42 };
const standard = buildReferenceWorkflow({ ...base, turbo: false, refImageSize: 'max' });
assert.equal(standard['7'].inputs.ref_image_size, 'max');
assert.equal(standard['11'].inputs.scheduler, 'beta');
assert.equal(standard['11'].inputs.steps, 20);
assert.equal(standard['2'], undefined);
assert.equal(standard['3'].inputs.model[0], '1');
assert.deepEqual(standard['7'].inputs.ref_images, { ref_image_0: ['100', 0] });
assert.deepEqual(standard['7'].inputs.ref_videos, { ref_video_0: ['201', 0] });
assert.deepEqual(standard['7'].inputs.ref_video_audios, { ref_video_audio_0: ['201', 1] });
const defaults = buildReferenceWorkflow(base);
assert.equal(defaults['7'].inputs.ref_image_size, 'max');
const turbo = buildReferenceWorkflow({ ...base, turbo: true });
assert.equal(turbo['11'].inputs.scheduler, 'beta');
assert.equal(turbo['11'].inputs.steps, 4);
console.log('REFERENCE_QUALITY_OK: max identity, beta scheduler, standard 20 steps, reference links preserved');
