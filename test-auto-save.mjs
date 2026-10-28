import assert from 'node:assert/strict';
import { AutoSaveController, autoSaveSignatures } from './src/auto-save.js';

function fakeClock() {
  let now = 0;
  let sequence = 0;
  const tasks = new Map();
  const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  return {
    now: () => now,
    schedule(callback, delay) { const id = ++sequence; tasks.set(id, { due: now + delay, callback }); return id; },
    cancel(id) { tasks.delete(id); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, task] = next;
        tasks.delete(id); now = task.due; task.callback(); await settle();
      }
      now = target; await settle();
    },
  };
}

function canvas(progress = 0, status = 'running') {
  return {
    nodes: [
      { id: 'old', type: 'generator', position: { x: 0, y: 0 }, data: { title: '旧结果', status: 'done', progress: 100 } },
      { id: 'active', type: 'generator', position: { x: 200, y: 0 }, data: { title: '当前任务', status, progress, stage: '采样', runs: [] } },
    ], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  };
}

{
  const clock = fakeClock();
  const writes = [];
  const states = [];
  let notices = 0;
  const controller = new AutoSaveController({
    name: '进度项目', canvas: canvas(), write: async (snapshot) => writes.push(snapshot),
    onStateChange: (state) => states.push(state), onNotice: () => { notices += 1; },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  await (async () => { const pending = controller.flush(); await clock.advance(0); await pending; })();
  assert.equal(writes.length, 0, 'opening an unchanged project must not write');
  for (let index = 1; index <= 60; index += 1) {
    await clock.advance(100);
    controller.observe('进度项目', canvas(index, index === 60 ? 'done' : 'running'));
  }
  await (async () => { const pending = controller.flush(); await clock.advance(0); await pending; })();
  assert.equal(writes.length, 2, '60 progress events at 10 Hz: one 5 s snapshot + one terminal snapshot');
  assert.equal(states.length, 0, 'runtime-only writes stay silent');
  assert.equal(notices, 0, 'runtime saves never notify');
  assert.equal(writes[1].canvas.nodes[1].data.progress, 60);
  console.log('AUTO_SAVE_RUNTIME_OK writes=2 stateTransitions=0 notices=0');
}

{
  const clock = fakeClock();
  const writes = [];
  const states = [];
  let notices = 0;
  const controller = new AutoSaveController({
    name: '拖动项目', canvas: canvas(), write: async (snapshot) => writes.push(snapshot),
    onStateChange: (state) => states.push(state), onNotice: () => { notices += 1; },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  for (let index = 1; index <= 20; index += 1) {
    const next = canvas(); next.nodes[1].position.x = 200 + index;
    controller.observe('拖动项目', next);
    await clock.advance(16);
  }
  await clock.advance(400);
  await (async () => { const pending = controller.flush(); await clock.advance(0); await pending; })();
  assert.equal(writes.length, 1, 'one drag gesture debounces to one write');
  assert.deepEqual(states.filter((state, index) => index === 0 || state !== states[index - 1]), ['dirty', 'saving', 'saved']);
  await clock.advance(2000);
  assert.equal(notices, 1, 'one quiet edit notification');
  await clock.advance(5000);
  assert.equal(notices, 1, 'notification is not repeated without edits');
  console.log('AUTO_SAVE_DRAG_OK writes=1 notices=1');
}

{
  const clock = fakeClock();
  const writes = [];
  let active = 0;
  let maximum = 0;
  let release;
  const controller = new AutoSaveController({
    name: '尾随项目', canvas: canvas(), write: async () => {
      active += 1; maximum = Math.max(maximum, active); writes.push(active);
      if (writes.length === 1) await new Promise((resolve) => { release = resolve; });
      active -= 1;
    }, now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  const first = canvas(); first.nodes[1].data.title = '第一次编辑';
  controller.observe('尾随项目', first);
  await clock.advance(400);
  const second = canvas(); second.nodes[1].data.title = '第二次编辑';
  controller.observe('尾随项目', second);
  release();
  await clock.advance(400);
  await (async () => { const pending = controller.flush(); await clock.advance(0); await pending; })();
  assert.equal(maximum, 1, 'writes are single-flight');
  assert.equal(writes.length, 2, 'one trailing write preserves the latest edit');
  assert.equal(controller.hasUnsaved(), false);
  console.log('AUTO_SAVE_TRAILING_OK maxConcurrent=1 writes=2');
}

{
  const runtime = autoSaveSignatures('签名', canvas(10));
  const progressed = autoSaveSignatures('签名', canvas(20));
  assert.equal(runtime.editing, progressed.editing);
  assert.notEqual(runtime.full, progressed.full);
  const queued = canvas(20); queued.nodes[1].data.queueJobId = 'job_runtime_only';
  assert.equal(runtime.editing, autoSaveSignatures('签名', queued).editing, 'queue job identity is runtime-only');
  const selected = canvas(10); selected.nodes[0].selected = true;
  assert.equal(runtime.full, autoSaveSignatures('签名', selected).full, 'selection is not persisted content');
  console.log('AUTO_SAVE_SIGNATURE_OK');
}

{
  const clock = fakeClock();
  let attempts = 0;
  const states = [];
  const controller = new AutoSaveController({
    name: '失败项目', canvas: canvas(), write: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('磁盘暂时不可写');
    }, onStateChange: (state) => states.push(state),
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  const edited = canvas(); edited.nodes[1].data.title = '必须保留的编辑';
  controller.observe('失败项目', edited);
  const failedFlush = controller.flush();
  await clock.advance(0);
  await assert.rejects(failedFlush, /磁盘暂时不可写/, 'flush must reject instead of leaving with unsaved edits');
  assert.equal(controller.hasUnsaved(), true, 'failed content remains dirty');
  await clock.advance(10000);
  assert.equal(attempts, 1, 'a failed write is not retried in a tight automatic loop');
  const retry = controller.flush();
  await clock.advance(0);
  await retry;
  assert.equal(attempts, 2, 'an explicit flush retries the failed write');
  assert.equal(controller.hasUnsaved(), false);
  assert.equal(states.at(-1), 'saved');
  console.log('AUTO_SAVE_FAILURE_OK attempts=2 dirtyPreserved=true');
}
