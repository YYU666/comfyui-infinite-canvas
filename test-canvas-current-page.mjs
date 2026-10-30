import assert from 'node:assert/strict';
import { startCurrentCanvasPage, validateCanvasArgs } from './src/canvas-current-page.js';

const schema = { type: 'object', properties: { nodeId: { type: 'string' }, wait: { type: 'boolean' } }, required: ['nodeId'], additionalProperties: false };
assert.throws(() => validateCanvasArgs({}, schema), /required/);
assert.throws(() => validateCanvasArgs({ nodeId: 2 }, schema), /string/);
assert.throws(() => validateCanvasArgs({ nodeId: 'a', script: 'x' }, schema), /unsupported/);
let visible = true;
let executions = 0;
let heartbeat = 0;
let deliveryAttempts = 0;
let released = false;
const results = [];
const stop = startCurrentCanvasPage({
  intervalMs: 5,
  getPage: () => ({ projectId: 'prj_test', visible }),
  tools: [{ name: 'canvas_generate_node', inputSchema: schema, execute: async () => {
    executions += 1;
    return JSON.stringify({ ok: true, node: { queueJobId: 'job_once' } });
  } }],
  fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith('/release')) { released = true; return { ok: true, json: async () => ({}) }; }
    if (url.endsWith('/result')) {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error('lost result response');
      results.push(payload);
      return { ok: true, json: async () => ({}) };
    }
    heartbeat += 1;
    let command = null;
    if (!payload.busy && heartbeat <= 5) command = { epoch: 'epoch', sessionId: payload.sessionId, projectId: payload.projectId,
      opId: 'once', tool: 'canvas_generate_node', args: { nodeId: 'g1', wait: false } };
    if (results.length && !visible) command = { epoch: 'epoch', sessionId: payload.sessionId, projectId: payload.projectId,
      opId: 'hidden', tool: 'canvas_generate_node', args: { nodeId: 'g1', wait: false } };
    return { ok: true, json: async () => ({ epoch: 'epoch', command }) };
  },
});
try {
  const until = async (read) => {
    for (let i = 0; i < 200 && !read(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(read(), 'current page test timed out');
  };
  await until(() => results.length > 0);
  assert.equal(results[0].result.node.queueJobId, 'job_once');
  await until(() => heartbeat >= 6);
  assert.equal(executions, 1, 'lost receipts and duplicate delivery never rerun generation');
  visible = false;
  await until(() => results.some((result) => result.opId === 'hidden'));
  assert.equal(executions, 1, 'visibility checked again before tool execution');
  assert.equal(results.find((result) => result.opId === 'hidden').result.ok, false);
} finally { stop(); }
assert.equal(released, true);
console.log('CURRENT_CANVAS_TRANSPORT_OK dedup=true resultRetryOnly=true hiddenBlocked=true');
