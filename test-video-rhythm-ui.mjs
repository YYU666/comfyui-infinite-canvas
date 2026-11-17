import assert from 'node:assert/strict';
import { runVideoProcessorFixture } from './test-video-processor-fixture.mjs';
await runVideoProcessorFixture({ type: 'videoSpeed', title: '恒定速度', initial: { speed: 0.5, rhythmAudio: 'preserve' },
  settings: { speed: 2, rhythmAudio: 'mute' }, api: 'video-rhythm', prefix: 'vry', resultKey: 'rhythmResultAssetPath',
  check: ({ submitted }) => { assert.equal(submitted.operation, 'speed'); assert.equal(submitted.settings.speed, 2); } });
await runVideoProcessorFixture({ type: 'videoTimeRemap', title: '时间重映射', initial: { remapKeyframes: [{ output: 0, source: 0 }, { output: 1, source: 1 }] },
  settings: { remapKeyframes: [{ output: 0, source: 0 }, { output: 1, source: 0.5 }, { output: 2, source: 0.5 }] },
  api: 'video-rhythm', prefix: 'vry', resultKey: 'rhythmResultAssetPath', check: ({ submitted }) => assert.equal(submitted.operation, 'remap') });
