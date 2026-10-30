import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Isolate the HTTP boundary; URL normalization is unrelated to upload CAS.
const source = (await readFile(new URL('./src/project-store-http.js', import.meta.url), 'utf8'))
  .replace("import { normalizeMediaUrl } from './workbench-api';", 'const normalizeMediaUrl = (url) => url;');
const { saveProjectFile } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
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
} finally { globalThis.fetch = originalFetch; }
