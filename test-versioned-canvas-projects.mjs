import assert from 'node:assert/strict';
import { createProjectPageTools, startCurrentCanvasPage } from './src/canvas-current-page.js';

const until = async (read) => {
  for (let i = 0; i < 300 && !read(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(read(), 'project transition timed out');
};
let prepared = 0;
let committed = 0;
let abandoned = 0;
let attempts = 0;
let acknowledged = false;
const tools = createProjectPageTools({
  prepare: async (id, name) => { prepared += 1; return { id: id || 'prj_new', name }; },
  commit: async () => { assert.ok(acknowledged, 'the old page remains mounted until result ACK'); committed += 1; },
  abandon: () => { abandoned += 1; },
});
const stop = startCurrentCanvasPage({ intervalMs: 5, tools,
  getPage: () => ({ projectId: 'launcher', visible: true }),
  fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/release')) return { ok: true, json: async () => ({}) };
    if (url.endsWith('/result')) {
      attempts += 1;
      assert.equal(committed, 0);
      if (attempts === 1) throw new Error('lost ACK');
      acknowledged = true;
      assert.equal(body.result.projectId, 'prj_new');
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ epoch: 'epoch', command: !body.busy && !acknowledged
      ? { epoch: 'epoch', sessionId: body.sessionId, projectId: 'launcher', opId: 'create-once', tool: 'canvas_create_project', args: { name: 'Comparison' } } : null }) };
  },
});
try { await until(() => committed === 1); assert.equal(prepared, 1); assert.equal(attempts, 2); }
finally { stop(); }
assert.equal(abandoned, 0);

const blocked = createProjectPageTools({ prepare: async () => { throw new Error('任务进行中'); }, commit: async () => { throw new Error('must not switch'); } });
assert.equal(JSON.parse(await blocked[0].execute({ name: 'test' })).ok, false);
assert.equal(JSON.parse(await blocked[1].execute({ projectId: '../escape' })).ok, false);
let nativeCommit = false;
const native = createProjectPageTools({ prepare: async () => ({ id: 'prj_existing' }), commit: async () => { nativeCommit = true; } });
assert.equal(JSON.parse(await native[1].execute({ projectId: 'prj_existing' })).ok, true);
assert.ok(nativeCommit, 'native WebMCP switches directly without waiting for HTTP transport');
console.log('VERSIONED_CANVAS_PROJECTS_OK ackBeforeSwitch=true retryNoDuplicate=true native=true');
