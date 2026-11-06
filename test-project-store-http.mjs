import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Isolate the HTTP boundary; URL normalization is unrelated to upload CAS.
const source = (await readFile(new URL('./src/project-store-http.js', import.meta.url), 'utf8'))
  .replace("import { normalizeMediaUrl } from './workbench-api';", 'const normalizeMediaUrl = (url) => url;');
const { saveProjectFile, openProjectPath, restoreProjectAccess } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const originalFetch = globalThis.fetch;
const calls = [];
const file = new File(['synthetic'], 'sample.png', { type: 'image/png' });
try {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const revision = Number(options.headers['If-Match']);
    return new Response(JSON.stringify(revision === 4
      ? { asset: { path: 'assets/synthetic.png' }, revision: 5 }
      : { code: 'REVISION_CONFLICT', message: 'stale upload', details: { revision: 4 } }), {
      status: revision === 4 ? 201 : 409, headers: { 'Content-Type': 'application/json' },
    });
  };
  await assert.rejects(saveProjectFile('prj_fixture', 'node', file), /项目版本/);
  assert.equal(calls.length, 0, 'browser upload must never silently omit the revision');
  await assert.rejects(saveProjectFile('prj_fixture', 'node', file, 2), (error) => error.code === 'REVISION_CONFLICT' && error.status === 409);
  assert.equal(calls[0].options.headers['If-Match'], '2', 'send the page base revision, not a fresh server GET revision');
  const result = await saveProjectFile('prj_fixture', 'node', file, 4);
  assert.equal(result.revision, 5);
  assert.equal(calls[1].options.body, file);
  assert.equal(calls[1].options.headers['Content-Type'], 'image/png');
  assert.equal(calls.length, 2);
  console.log('PROJECT_HTTP_ASSET_CAS_OK staleRejected=true missingRevisionRejected=true');

  let mappingLost = false; let locked = false; let opens = 0;
  const opened = [];
  globalThis.fetch = async (url, options) => {
    let status = 200;
    let data = { id: 'prj_external', revision: 99, canvas: { nodes: [] } };
    if (url.endsWith('/open')) {
      opens++; opened.push(JSON.parse(options.body));
      if (locked) { status = 423; data = { code: 'LOCKED', message: 'locked' }; }
      else mappingLost = false;
    } else if (mappingLost) { status = 404; data = { code: 'NOT_FOUND', message: 'missing' }; }
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const current = await openProjectPath('C:/synthetic/external');
  current.revision = 3; current.canvas.nodes.push({ id: 'unsaved' });
  assert.equal(current.path, undefined, 'backend need not expose path in project JSON');
  await restoreProjectAccess(current); assert.equal(opens, 1, 'available project never reopens');
  mappingLost = true; await restoreProjectAccess(current);
  assert.equal(opens, 2); assert.equal(current.revision, 3); assert.equal(current.canvas.nodes[0].id, 'unsaved');
  mappingLost = true; locked = true;
  await assert.rejects(restoreProjectAccess(current), (error) => error.status === 423);
  assert.equal(opens, 3, 'lock never falls back silently to read-only');
  assert.equal(opened.at(-1).readOnly, false);
  await assert.rejects(restoreProjectAccess(current, { isCurrent: () => false }), (error) => error.status === 404);
  assert.equal(opens, 3, 'obsolete page cannot re-register after project switch');
  console.log('PROJECT_HTTP_RECONNECT_OK rememberedExternalPath=true revisionRetained=true lockSurfaced=true obsoletePageBlocked=true');
} finally { globalThis.fetch = originalFetch; }
