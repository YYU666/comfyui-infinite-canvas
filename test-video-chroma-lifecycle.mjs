import assert from 'node:assert/strict';
import { createVideoChromaRunner } from './src/video-chroma-runtime.js';
import { defaultChromaSettings } from './src/video-chroma-document.js';
const previousFetch = globalThis.fetch;
try {
  for (const change of ['switch', 'cancel']) {
    let project = 'prj_old', release;
    const waiting = new Promise(resolve => { release = resolve; });
    const source = { id:'video', type:'media', data:{ kind:'video', url:'/synthetic.mp4' } };
    const background = { id:'bg', type:'media', data:{ kind:'image', assetPath:`assets/${'b'.repeat(64)}.png` } };
    const node = { id:'chroma', type:'videoChromaKey', data:defaultChromaSettings() };
    const jobs = new Map(); let saves = 0, updates = 0, calls = 0;
    globalThis.fetch = async url => {
      assert.equal(url, '/synthetic.mp4'); calls++;
      return { ok:true, blob:async () => { await waiting; return new Blob(['fixture']); } };
    };
    const runner = createVideoChromaRunner({ getProjectId:()=>project, getNodes:()=>[source,background,node],
      getEdges:()=>[{source:'video',target:'chroma',targetHandle:'fg'},{source:'bg',target:'chroma',targetHandle:'bg'}], jobs,
      updateNode:()=>updates++, saveCanvasMedia:async () => { saves++; }, saveProjectFile:async()=> { saves++; } });
    const preview = runner.preview('chroma');
    await Promise.resolve();
    assert.equal(calls, 1); assert.equal(jobs.has('chroma'), true);
    if (change === 'switch') project = 'prj_new'; else runner.cancel('chroma');
    release();
    assert.equal((await preview).ok, false);
    assert.equal(saves, 0); assert.equal(updates, 0); assert.equal(jobs.size, 0);
  }
} finally { globalThis.fetch = previousFetch; }
console.log('VIDEO_CHROMA_LIFECYCLE_OK switch/cancel during remote preview never imports into another project');
