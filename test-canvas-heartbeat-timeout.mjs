import assert from 'node:assert/strict';
import { startCurrentCanvasPage } from './src/canvas-current-page.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async read => { for (let i = 0; i < 200 && !read(); i++) await sleep(5); assert.ok(read(), 'condition reached'); };
const reply = value => ({ ok: true, json: async () => value });
const page = () => ({ projectId: 'prj_test', visible: true, readOnly: false });
const command = payload => ({ ...payload, epoch: 'epoch', opId: 'only-op', tool: 'canvas_generate_node', args: { wait: false } });
const schema = { type: 'object', properties: { wait: { type: 'boolean' } }, additionalProperties: false };

// A timed-out dispatch may already be marked dispatched at the server. Its late
// response must never execute; this page must not invent a replacement opId.
for (const hangBody of [false, true]) {
  let heartbeats = 0, executions = 0, late, firstSignal, firstPayload;
  const stop = startCurrentCanvasPage({ getPage: page, intervalMs: 5, requestTimeoutMs: 25,
    tools: [{ name: 'canvas_generate_node', inputSchema: schema, execute: async () => { executions++; return '{"ok":true}'; } }],
    fetchImpl: async (url, options) => {
      if (!url.endsWith('/heartbeat')) return reply({});
      const payload = JSON.parse(options.body); heartbeats++;
      if (heartbeats === 1) {
        firstSignal = options.signal; firstPayload = payload;
        const pending = new Promise(resolve => { late = resolve; });
        return hangBody ? { ok: true, json: () => pending } : pending;
      }
      assert.equal(payload.sessionId, firstPayload.sessionId);
      return reply({ epoch: 'epoch', command: null });
    },
  });
  try {
    await until(() => heartbeats >= 3); assert.equal(firstSignal.aborted, true);
    const value = { epoch: 'epoch', command: command(firstPayload) };
    late(hangBody ? value : reply(value)); await sleep(20);
    assert.equal(executions, 0);
  } finally { stop(); }
}

// Long execution and hung receipt both keep renewing the same lease. Receipt
// retry carries the same frozen result/opId; no second execution occurs.
{
  let heartbeats = 0, executions = 0, finish, lateReceipt, acknowledgments = 0, receiptSignal;
  const receipts = []; let dispatched = false;
  const stop = startCurrentCanvasPage({ getPage: page, intervalMs: 5, requestTimeoutMs: 250,
    tools: [{ name: 'canvas_generate_node', inputSchema: schema,
      execute: async () => { executions++; await new Promise(resolve => { finish = resolve; }); return '{"ok":true,"jobId":"existing-job"}'; },
      afterResultDelivered: () => { acknowledgments++; } }],
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      if (url.endsWith('/release')) return reply({});
      if (url.endsWith('/result')) {
        receipts.push(payload);
        if (receipts.length === 1) { receiptSignal = options.signal; return new Promise(resolve => { lateReceipt = resolve; }); }
        return reply({});
      }
      heartbeats++;
      const next = !dispatched ? command(payload) : null; dispatched = true;
      return reply({ epoch: 'epoch', command: next });
    },
  });
  try {
    await until(() => executions === 1 && heartbeats >= 4);
    finish(); await until(() => receipts.length === 1);
    const count = heartbeats; await until(() => heartbeats >= count + 3);
    assert.equal(receipts.length, 1, 'heartbeat progresses while first receipt hangs');
    await until(() => acknowledgments === 1);
    assert.equal(receiptSignal.aborted, true); assert.equal(executions, 1);
    assert.equal(receipts.length, 2); assert.deepEqual(receipts[0], receipts[1]);
    lateReceipt(reply({})); await sleep(20); assert.equal(acknowledgments, 1);
  } finally { stop(); }
}

// Unmount cancels a hung heartbeat; a transport ignoring abort cannot execute
// its late command or restart the polling loop.
{
  let late, signal, payload, executions = 0, heartbeats = 0;
  const stop = startCurrentCanvasPage({ getPage: page, intervalMs: 5, requestTimeoutMs: 100,
    tools: [{ name: 'canvas_generate_node', inputSchema: schema, execute: async () => { executions++; return '{"ok":true}'; } }],
    fetchImpl: async (url, options) => {
      if (!url.endsWith('/heartbeat')) return reply({});
      heartbeats++; signal = options.signal; payload = JSON.parse(options.body);
      return new Promise(resolve => { late = resolve; });
    },
  });
  stop(); assert.equal(signal.aborted, true);
  late(reply({ epoch: 'epoch', command: command(payload) })); await sleep(30);
  assert.equal(executions, 0); assert.equal(heartbeats, 1);
}
{
  let late, signal, acknowledged = 0, abandoned = 0, sent = false;
  const stop = startCurrentCanvasPage({ getPage: page, intervalMs: 5, requestTimeoutMs: 100,
    tools: [{ name: 'canvas_generate_node', inputSchema: schema, execute: async () => '{"ok":true}',
      afterResultDelivered: () => { acknowledged++; }, onResultDeliveryAbandoned: () => { abandoned++; } }],
    fetchImpl: async (url, options) => {
      if (url.endsWith('/release')) return reply({});
      if (url.endsWith('/result')) { signal = options.signal; return new Promise(resolve => { late = resolve; }); }
      const next = sent ? null : command(JSON.parse(options.body)); sent = true;
      return reply({ epoch: 'epoch', command: next });
    },
  });
  await until(() => Boolean(late)); stop(); assert.equal(signal.aborted, true);
  late(reply({})); await sleep(20); assert.equal(acknowledged, 0); assert.equal(abandoned, 1);
}
console.log('CANVAS_HEARTBEAT_TIMEOUT_OK hung fetch/body bounded; receipt independent; long command; late/unmount isolation; same-op retry');
