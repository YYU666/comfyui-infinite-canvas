import assert from 'node:assert/strict';
import { defaultChromaSettings } from './src/video-chroma-document.js';
import { runVideoProcessorFixture } from './test-video-processor-fixture.mjs';
await runVideoProcessorFixture({ type: 'videoChromaKey', title: '绿幕扣像合成', initial: defaultChromaSettings(),
  settings: { keyColor: '#00ff00', secondKey: true, secondKeyColor: '#ffffff', similarity: 0.3 },
  port: 'fg', api: 'video-chroma', prefix: 'vck', resultKey: 'chromaResultAssetPath',
  nodes: [{ id: 'background', type: 'media', position: { x: 0, y: 400 }, data: { kind: 'image', assetPath: `assets/${'c'.repeat(64)}.png` } }],
  edges: [{ id: 'background-edge', source: 'background', target: 'processor', targetHandle: 'bg', sourceHandle: 'ref' }],
  check: ({ submitted }) => { assert.equal(submitted.settings.keyColor, '#00FF00'); assert.equal(submitted.settings.secondKey, true); } });
