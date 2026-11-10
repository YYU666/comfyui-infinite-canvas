import assert from 'node:assert/strict';
import { createPureRefImporter, pureRefImageNodes, inspectPureRef, copyPureRefResource } from './src/pureref-import.js';

const image = index => ({ name: `PureRef-00${index}.png`, mime: 'image/png', width: 12, height: 8, bytes: 3, handle: String(index).padStart(32, '0') });
const result = { images: [image(1), image(2)], duplicates: 1, skippedExternal: 2 };
const file = new File(['fixture'], 'board.pur');
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function harness(overrides = {}) {
  const context = { projectId: 'one', owner: {}, readOnly: false, switching: false, conflict: false };
  const states = [], uploads = [], publications = [];
  let held = false, releases = 0, saves = 0;
  const importer = createPureRefImporter({ getContext: () => ({ ...context }), inspect: async () => structuredClone(result),
    upload: async selected => { uploads.push(selected); return { ok: true, assetPath: `assets/${uploads.length}.png`, mediaStorageId: `m${uploads.length}` }; },
    beginBatch: () => { assert.equal(held, false); held = true; return () => { assert.equal(held, true); held = false; releases++; }; },
    publish: images => { assert.equal(uploads.length, 2); assert.equal(held, false); publications.push(images); return ['one', 'two']; },
    persist: async () => { saves++; }, onState: state => states.push(state), ...overrides });
  return { importer, context, states, uploads, publications, held: () => held, releases: () => releases, saves: () => saves };
}

{
  const h = harness(); await h.importer.inspect(file);
  assert.equal(h.importer.getState().phase, 'preview'); assert.equal(h.uploads.length, 0); assert.equal(h.publications.length, 0);
  await h.importer.commit(); assert.equal(h.importer.getState().phase, 'done');
  assert.equal(h.saves(), 1); assert.equal(h.releases(), 1); assert.equal(h.publications.length, 1);
  assert.ok(h.publications[0].every(image => !('base64' in image))); assert.equal(h.importer.getState().duplicates, 1);
  assert.equal(h.uploads[0].handle, image(1).handle);
  await assert.rejects(() => h.importer.commit(), /先解析/);
}
{
  const waiting = deferred(); let h;
  h = harness({ upload: async () => waiting.promise }); await h.importer.inspect(file);
  const committing = h.importer.commit(); assert.equal(h.held(), true); h.importer.cancel();
  waiting.resolve({ ok: true, assetPath: 'assets/first.png' }); await committing;
  assert.equal(h.importer.getState().phase, 'cancelled'); assert.equal(h.publications.length, 0); assert.equal(h.held(), false); assert.equal(h.saves(), 0);
}
for (const mutation of [context => { context.projectId = 'two'; }, context => { context.owner = {}; }, context => { context.readOnly = true; }, context => { context.switching = true; }, context => { context.conflict = true; }]) {
  const waiting = deferred(); const h = harness({ upload: async () => waiting.promise }); await h.importer.inspect(file);
  const committing = h.importer.commit(); mutation(h.context); waiting.resolve({ ok: true, assetPath: 'assets/first.png' }); await committing;
  assert.equal(h.importer.getState().phase, 'error'); assert.equal(h.publications.length, 0); assert.equal(h.releases(), 1);
}
{
  let attempts = 0;
  const h = harness({ upload: async () => { attempts++; if (attempts === 2) return { ok: false, error: new Error('disk full fixture') }; return { ok: true, assetPath: 'assets/first.png' }; } });
  await h.importer.inspect(file); await h.importer.commit(); assert.equal(h.importer.getState().phase, 'error');
  assert.equal(h.publications.length, 0); assert.equal(h.saves(), 0); assert.equal(h.held(), false);
}
{
  const h = harness({ persist: async () => { throw new Error('uncertain response'); } }); await h.importer.inspect(file); await h.importer.commit();
  assert.equal(h.importer.getState().phase, 'unconfirmed'); assert.equal(h.publications.length, 1); assert.match(h.importer.getState().message, /不要重复导入/);
  await assert.rejects(() => h.importer.commit(), /先解析/); assert.equal(h.publications.length, 1);
}
{
  const waiting = deferred(); const h = harness({ inspect: async () => waiting.promise }); const inspecting = h.importer.inspect(file);
  h.importer.cancel(); waiting.resolve(structuredClone(result)); await inspecting;
  assert.equal(h.importer.getState().phase, 'cancelled'); assert.equal(h.uploads.length, 0);
  const preview = harness(); await preview.importer.inspect(file); preview.importer.cancel(); assert.equal(preview.importer.getState().phase, 'cancelled');
  const invalid = harness(); await assert.rejects(() => invalid.importer.inspect(new File(['a'], 'wrong.png')), /\.pur/);
  const bad = harness({ inspect: async () => { throw new Error('unsupported fixture'); } }); await bad.importer.inspect(file); assert.equal(bad.importer.getState().phase, 'error');
}
{
  let sequence = 0;
  const existing = [{ id: 'old', type: 'media', position: { x: 40, y: 80 }, data: { refTag: '<Picture 1>', assetPath: 'assets/old.png' } }];
  const source = structuredClone(existing);
  const nodes = pureRefImageNodes(result.images.map((image, index) => ({ ...image, assetPath: `assets/${index}.png` })), { existing, origin: { x: 20, y: 30 }, uid: () => `new${++sequence}`, assetUrl: relative => `/project/${relative}` });
  assert.deepEqual(existing, source); assert.ok(nodes.every(node => node.type === 'media' && node.data.kind === 'image'));
  assert.equal(nodes[0].data.refTag, '<Picture 2>'); assert.notEqual(nodes[0].data.refTag, nodes[1].data.refTag);
  assert.ok(nodes[0].position.x >= 560); assert.equal(nodes[1].position.x - nodes[0].position.x, 360);
  assert.equal(nodes[0].data.assetPath, 'assets/0.png'); assert.ok(!JSON.stringify(nodes).includes('base64'));
}
{
  const h = harness(); h.context.nodeCount = 4095; await h.importer.inspect(file);
  assert.equal(h.importer.getState().phase, 'error'); assert.equal(h.uploads.length, 0);
  const changed = harness(); await changed.importer.inspect(file); changed.context.nodeCount = 4095; await changed.importer.commit();
  assert.equal(changed.importer.getState().phase, 'error'); assert.equal(changed.publications.length, 0);
}
{
  const originalFetch = globalThis.fetch, calls = [];
  const source = new File(['abcdefghi'], 'slice-only.pur');
  source.arrayBuffer = () => { throw new Error('whole source allocation forbidden'); };
  source.text = source.arrayBuffer;
  let chunkAttempt = 0, committed = 0, finishAttempt = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    assert.ok(!url.includes('private-capability'));
    const json = value => new Response(JSON.stringify(value), {status:200,headers:{'Content-Type':'application/json'}});
    if (url === '/api/pureref/sessions') return json({id:'a'.repeat(32),capability:'private-capability',chunkBytes:4});
    assert.equal(options.headers['X-PureRef-Session'], 'private-capability');
    if (url.endsWith('/upload')) {
      assert.ok(options.body instanceof Blob); assert.ok(options.body.size <= 4);
      chunkAttempt++;
      if (chunkAttempt === 1) throw new TypeError('uncommitted network interruption');
      committed = Number(options.headers['X-Upload-Offset']) + options.body.size;
      if (chunkAttempt === 2) throw new TypeError('lost committed ACK');
      return json({bytes:committed});
    }
    if (url.endsWith('/status')) return json(calls.some(call => call.url.endsWith('/finish')) ? {phase:'ready',count:2,duplicates:0,skippedExternal:0,totalBytes:6} : {phase:'uploading',bytes:committed});
    if (url.endsWith('/finish')) { if (++finishAttempt === 1) throw new TypeError('lost finish ACK'); return json({phase:'verifying'}); }
    if (url.includes('/resources?')) return json({images:[image(1),image(2)],count:2});
    if (options.method === 'DELETE') return json({cancelled:true});
    throw new Error('unexpected request '+url);
  };
  try {
    const parsed = await inspectPureRef(source, new AbortController().signal, 'one');
    assert.equal(parsed.images.length,2); assert.equal(calls.filter(c => c.url.endsWith('/upload')).length,4);
    assert.deepEqual(calls.filter(c=>c.url.endsWith('/upload')).map(c=>c.options.headers['X-Upload-Offset']),['0','0','4','8']); assert.equal(finishAttempt,2);
    assert.ok(!JSON.stringify(parsed.images).includes('base64'));
  } finally { globalThis.fetch = originalFetch; }
}
{
  const originalFetch = globalThis.fetch, pending = deferred(), sent = [];
  let learnedRevision = 7, requests = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return new Response('{}');
    sent.push({url, revision: options.headers['If-Match']}); requests++;
    if (requests === 1) { await pending.promise; throw new TypeError('committed copy lost ACK'); }
    return new Response(JSON.stringify({asset:{path:'assets/confirmed.png'},revision:8}));
  };
  try {
    const h = harness({inspect:async()=>({...structuredClone(result),session:{id:'a'.repeat(32),capability:'private-capability'}}),
      upload: async (image, session, signal) => {
        const saved = await copyPureRefResource(session,image,'one',learnedRevision,signal);
        learnedRevision = saved.revision; // Same position as current-page media writer.
        return {ok:true,assetPath:saved.asset.path};
      }});
    await h.importer.inspect(file); const committing=h.importer.commit();
    await Promise.resolve(); h.importer.cancel(); pending.resolve(); await committing;
    assert.equal(h.importer.getState().phase,'cancelled');assert.equal(h.publications.length,0);assert.equal(h.saves(),0);
    assert.equal(learnedRevision,8);assert.equal(requests,2);assert.ok(sent.every(call=>call.revision==='7'));assert.equal(new Set(sent.map(call=>call.url)).size,1);
  } finally {globalThis.fetch=originalFetch;}
}
console.log('PUREREF_IMPORT_OK atomicBatch serializedUploads cancel projectOwner readonly switching conflict uploadFailure saveUnconfirmed originalFiles grid referenceTags');
