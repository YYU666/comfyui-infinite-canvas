import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createVideoEditRunner } from './src/video-edit-runtime.js';
import { createVideoRhythmRunner } from './src/video-rhythm-runtime.js';
import { createVideoChromaRunner } from './src/video-chroma-runtime.js';
import { createVideoPlateRunner } from './src/video-plate-runtime.js';
import { defaultVideoEditDocument } from './src/video-edit-document.js';
import { defaultSpeedSettings } from './src/video-rhythm-document.js';
import { defaultChromaSettings } from './src/video-chroma-document.js';
import { defaultPlateSettings } from './src/video-plate-document.js';

const kinds = [
  ['edit', 'videoEdit', 'videoEditJobId', 'v1', { editDocument: defaultVideoEditDocument() }, createVideoEditRunner],
  ['rhythm', 'videoSpeed', 'rhythmJobId', 'v1', defaultSpeedSettings(), createVideoRhythmRunner],
  ['chroma', 'videoChromaKey', 'chromaJobId', 'fg', defaultChromaSettings(), createVideoChromaRunner],
  ['plate', 'videoWhitePlate', 'plateJobId', 'v1', defaultPlateSettings(), createVideoPlateRunner],
];
if (existsSync(new URL('./src/video-repair-runtime.js', import.meta.url))) {
  const { createVideoRepairRunner } = await import('./src/video-repair-runtime.js');
  const { defaultRepairSettings } = await import('./src/video-repair-document.js');
  kinds.push(['repair', 'videoLocalRepair', 'repairJobId', 'video', defaultRepairSettings(), createVideoRepairRunner]);
}
const until = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 55));
  }
  assert.fail('Timed out waiting for reconciled video job');
};
const assetPath = `assets/${'a'.repeat(64)}.mp4`;
const bgPath = `assets/${'b'.repeat(64)}.png`;
const resultPath = `assets/${'c'.repeat(64)}.mp4`;
const prefixes = { edit: 'ved', rhythm: 'vry', chroma: 'vck', plate: 'vwp', repair: 'vrp' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

for (const [kind, type, jobKey, handle, initial, createRunner] of kinds) {
  let edit, saved, receipt, posts, getRequests, failSave, hideReceipt, terminal, cancels, commits, gate;
  const source = { id: 'source', type: 'media', data: { kind: 'video', assetPath } };
  const bg = { id: 'bg', type: 'media', data: { kind: 'image', assetPath: bgPath } };
  const edges = [{ source: source.id, target: 'edit', targetHandle: handle }];
  if (kind === 'chroma') edges.push({ source: bg.id, target: 'edit', targetHandle: 'bg' });
  const reset = () => {
    edit = { id: 'edit', type, data: { ...structuredClone(initial), status: 'idle' } };
    saved = null; receipt = null; posts = 0; getRequests = 0; failSave = false; hideReceipt = false;
    terminal = 'queued'; cancels = 0; commits = 0; gate = null;
  };
  const deps = () => ({ getProjectId: () => 'prj_video_test', getNodes: () => [source, bg, edit], getEdges: () => edges,
    jobs: new Map(), pollInterval: 10, updateNode: (_, patch) => Object.assign(edit.data, patch),
    persistProject: async () => {
      if (failSave) throw new Error('fixture persistence failure');
      if (gate) await gate;
      saved = structuredClone(edit);
    },
    saveCanvasMedia: async (write, done) => {
      await write(18, 'fixture');
      return done({ asset: { path: resultPath } });
    },
  });
  let mockError;
  globalThis.fetch = async (url, options) => {
    const method = options?.method || 'GET';
    if (url === '/api/projects/prj_video_test') return json({ id: 'prj_video_test', canvas: { nodes: [saved] } });
    if (url === `/api/video-${kind}/jobs` && method === 'POST') {
      posts++;
      const { requestId, ...intent } = JSON.parse(options.body);
      try { assert.deepEqual(saved.data.videoSubmission.intent, intent); assert.equal(saved.data.videoSubmission.phase, 'prepared'); }
      catch (error) { mockError = error; throw error; }
      receipt = { id: `${prefixes[kind]}_${requestId}`, projectId: intent.projectId, nodeId: intent.nodeId,
        stage: 'fixture', progress: .2, result: { width: 64, height: 48 } };
      throw new TypeError('simulated lost POST response after backend accepted');
    }
    assert.ok(receipt && url.startsWith(`/api/video-${kind}/jobs/${receipt.id}`), url);
    if (url.endsWith('/cancel')) { cancels++; terminal = 'cancelled'; return json({ ...receipt, status: terminal }); }
    if (url.endsWith('/commit')) { commits++; assert.equal(terminal, 'completed'); return json({ asset: { path: resultPath } }); }
    getRequests++;
    return hideReceipt ? json({ message: 'fixture offline' }, 404) : json({ ...receipt, status: terminal, error: terminal === 'failed' ? 'fixture worker failed' : undefined });
  };

  reset();
  failSave = true;
  assert.equal((await createRunner(deps()).run(edit.id)).ok, false);
  assert.equal(posts, 0, `${kind}: save failure must admit zero jobs`);

  reset();
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  const pre = createRunner(deps());
  const interrupted = pre.run(edit.id);
  await until(() => edit.data.videoSubmission?.phase === 'prepared');
  await pre.cancel(edit.id);
  release();
  assert.equal((await interrupted).ok, false);
  assert.equal(posts, 0, `${kind}: cancel before save passed must admit zero jobs`);

  reset();
  hideReceipt = true;
  const original = await createRunner(deps()).run(edit.id);
  assert.equal(original.code, 'VIDEO_SUBMISSION_UNKNOWN');
  assert.equal(posts, 1);
  assert.equal(saved.data.videoSubmission.phase, 'unconfirmed');
  assert.equal(saved.data[jobKey], receipt.id);
  edit = structuredClone(saved); // A new page has no controller or in-memory response.
  hideReceipt = false;
  terminal = 'completed';
  assert.equal(createRunner(deps()).resume(edit.id), true);
  await until(() => edit.data.status === 'done' && saved.data.status === 'done');
  assert.equal(edit.data[jobKey], receipt.id);
  assert.equal(commits, 1);
  assert.equal(posts, 1, `${kind}: reopening reconciles with GET, never a second POST`);

  reset();
  const failing = createRunner(deps());
  assert.equal((await failing.run(edit.id)).ok, true, `${kind}: recover immediately by original ID`);
  terminal = 'failed';
  await until(() => saved.data.status === 'error' && saved.data.videoSubmission.phase === 'failed');
  assert.equal(commits, 0);

  reset();
  const running = createRunner(deps());
  assert.equal((await running.run(edit.id)).ok, true);
  await running.cancel(edit.id);
  await until(() => cancels === 1);
  assert.equal(posts, 1);
  assert.equal(terminal, 'cancelled');
  assert.equal(mockError, undefined);
  assert.ok(getRequests >= 1);
  console.log(`${kind}: save barrier, pre-send cancel, lost receipt, reopen, commit, failure and running cancel passed`);
}
