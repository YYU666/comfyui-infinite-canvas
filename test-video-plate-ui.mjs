import assert from 'node:assert/strict';
import { defaultPlateSettings } from './src/video-plate-document.js';
import { runVideoProcessorFixture } from './test-video-processor-fixture.mjs';
await runVideoProcessorFixture({ type:'videoWhitePlate', title:'绿幕白模', initial:defaultPlateSettings(),
  settings:{keepPrompts:['person','pole'], maskGrow:0, maskFeather:0, shadeMode:'flat'},
  api:'video-plate',prefix:'vwp',resultKey:'plateResultAssetPath',repeatExport:true,
  check:({done,project,submitted,output})=>{
    assert.deepEqual(submitted.settings.keepPrompts,['person','pole']);
    const plate=done.nodes.find(n=>n.id==='processor');
    const media=project.canvas.nodes.find(n=>n.id===plate.plateResultNodeId);
    assert.equal(media.type,'media');assert.equal(media.data.kind,'video');assert.equal(media.data.assetPath,output);
    assert.ok(project.canvas.edges.some(e=>e.source==='processor'&&e.target===media.id&&e.targetHandle==='preview'));
  }
});
