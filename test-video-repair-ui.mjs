import assert from 'node:assert/strict';
import { defaultRepairSettings } from './src/video-repair-document.js';
import { runVideoProcessorFixture } from './test-video-processor-fixture.mjs';
await runVideoProcessorFixture({ type: 'videoLocalRepair', title: '局部水印修补', initial: defaultRepairSettings(),
  settings: { repairSettings: { schemaVersion: 1, rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, start: 0, end: 1 }, previewTime: 0.5 },
  port: 'video', api: 'video-repair', prefix: 'vrp', resultKey: 'repairResultAssetPath',
  check: ({ done, project, submitted }) => { assert.equal(submitted.settings.rect.x, 0.4); assert.equal(done.nodes.find(n => n.id === 'processor').repairResultCurrent, true); assert.equal(project.canvas.nodes.find(n => n.id === 'processor').data.repairPendingResult, null); } });
