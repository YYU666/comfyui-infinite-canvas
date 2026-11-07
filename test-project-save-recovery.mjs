import assert from 'node:assert/strict';
import { createProjectAccessRecovery, retryCurrentProjectSave } from './src/project-save-recovery.js';
import { AutoSaveController } from './src/auto-save.js';
import { registerCanvasMcp } from './src/canvas-mcp.js';
import { readFile } from 'node:fs/promises';

let project = { id: 'one' }, connectionError = '', calls = [];
let restore = async () => { throw new TypeError('Failed to fetch'); };
const recover = createProjectAccessRecovery({ getCurrent: () => project, restore: (...args) => restore(...args), onError: value => { connectionError = value; calls.push(value); } });
await assert.rejects(recover(), /Failed to fetch/);
assert.match(connectionError, /Failed to fetch/);
restore = async () => {};
await recover(); assert.equal(connectionError, '');
let rejectOld;
restore = () => new Promise((_, reject) => { rejectOld = reject; });
const old = recover(); const oldFailure = assert.rejects(old);
restore = async () => {}; await recover();
rejectOld(new Error('obsolete')); await oldFailure; assert.equal(connectionError, '');
const abort = new AbortController(); abort.abort();
const before = calls.length;
await assert.rejects(recover({ signal: abort.signal }), { name: 'AbortError' });
assert.equal(calls.length, before);
const timeout = new AbortController(); timeout.abort(new DOMException('timeout', 'TimeoutError'));
await assert.rejects(recover({ signal: timeout.signal })); assert.match(connectionError, /超时/);
restore = () => new Promise((_, reject) => { rejectOld = reject; });
const switched = recover(); const switchedFailure = assert.rejects(switched);
project = { id: 'two' }; rejectOld(new Error('previous project')); await switchedFailure;
assert.doesNotMatch(connectionError, /previous project/);

let attempts = 0, saved, revision = 7;
const canvas = text => ({ nodes: [{ id: 'n', data: { text } }], edges: [] });
const controller = new AutoSaveController({ name: 'test', canvas: canvas('old'), debounceMs: 0, minIntervalMs: 0,
  write: async value => { attempts++; if (attempts === 1) throw new TypeError('network'); saved = value; revision++; } });
controller.observe('test', canvas('first'));
await assert.rejects(controller.flush(), /network/);
controller.observe('test', canvas('latest'));
let restores = 0;
const context = { projectId: 'one', controller, readOnly: false, switching: false };
const options = { getContext: () => ({ ...context, revision }), restore: async () => { restores++; }, persist: retry => controller.flush({ retry }) };
assert.deepEqual(await retryCurrentProjectSave(options), { saved: true, projectId: 'one', revision: 8 });
assert.equal(saved.canvas.nodes[0].data.text, 'latest'); assert.equal(attempts, 2);
const conflict = Object.assign(new Error('conflict'), { status: 409, code: 'REVISION_CONFLICT' });
controller.conflict = conflict;
await assert.rejects(retryCurrentProjectSave(options), error => error === conflict);
assert.equal(restores, 1); assert.equal(attempts, 2); assert.equal(revision, 8);
controller.conflict = null;
await assert.rejects(retryCurrentProjectSave({ ...options, restore: async () => { context.projectId = 'different'; } }));
assert.equal(attempts, 2);
controller.dispose();
const registered = new Map(); let retries = 0, ordinaryFlushes = 0;
const latest = { current: { readOnly: false, actions: {
  retryProjectSave: async () => { retries++; return { saved: true, revision: 9 }; },
  persistProject: async () => { ordinaryFlushes++; },
} } };
const stop = registerCanvasMcp(latest, { context: { registerTool: tool => registered.set(tool.name, tool) }, startPage: () => () => {} });
const retryTool = registered.get('canvas_retry_save');
assert.equal(JSON.parse(await retryTool.execute()).saved, true);
assert.equal(retries, 1); assert.equal(ordinaryFlushes, 0);
latest.current.actions.retryProjectSave = async () => { throw conflict; };
assert.deepEqual(JSON.parse(await retryTool.execute()), { ok: false, error: 'conflict', status: 409, code: 'REVISION_CONFLICT', localChangesRetained: true });
latest.current.readOnly = true; assert.equal(JSON.parse(await retryTool.execute()).ok, false);
stop();

const httpSource = (await readFile(new URL('./src/project-store-http.js', import.meta.url), 'utf8'))
  .replace("import { normalizeMediaUrl } from './workbench-api.js';", 'const normalizeMediaUrl = value => value;');
const { saveProject } = await import(`data:text/javascript,${encodeURIComponent(httpSource)}`);
const originalFetch = globalThis.fetch; const writes = [];
try {
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') {
      writes.push(options);
      return new Response(JSON.stringify({ code: 'REVISION_CONFLICT', message: 'stale' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'one', revision: 99 }), { headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(saveProject('one', 7, 'test', canvas('unsaved')), error => error.status === 409);
  assert.equal(writes.length, 1); assert.equal(writes[0].headers['If-Match'], '7');
  assert.equal(JSON.parse(writes[0].body).canvas.nodes[0].data.text, 'unsaved');
} finally { globalThis.fetch = originalFetch; }
console.log('PROJECT_SAVE_RECOVERY_OK abort/stale/failure/recovery/latest-edits/CAS/switch guards');
