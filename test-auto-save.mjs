import assert from 'node:assert/strict';
import { AutoSaveController, autoSaveSignatures } from './src/auto-save.js';
import { readViewport, saveViewport } from './src/canvas-viewport.js';

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
  assert.equal(writes.length, 1, '60 progress events at 10 Hz: only the terminal snapshot is durable');
  assert.equal(states.length, 0, 'runtime-only writes stay silent');
  assert.equal(notices, 0, 'runtime saves never notify');
  assert.equal(writes[0].canvas.nodes[1].data.progress, 60);
  console.log('AUTO_SAVE_RUNTIME_OK writes=1 stateTransitions=0 notices=0');
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
  assert.equal(notices, 0, 'no toast after editing');
  await clock.advance(5000);
  assert.equal(notices, 0);
  console.log('AUTO_SAVE_DRAG_OK writes=1 notices=0');
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
  assert.equal(runtime.full, progressed.full, 'pure progress never dirties durable content');
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
  await assert.rejects(controller.flush(), /磁盘暂时不可写/, 'hidden-page flush must not retry a failed write');
  const retry = controller.flush({ retry: true });
  await clock.advance(0);
  await retry;
  assert.equal(attempts, 2, 'an explicit flush retries the failed write');
  assert.equal(controller.hasUnsaved(), false);
  assert.equal(states.at(-1), 'saved');
  console.log('AUTO_SAVE_FAILURE_OK attempts=2 dirtyPreserved=true');
}

for (const marker of [{ code: 'REVISION_CONFLICT' }, { status: 409 }]) {
  const clock = fakeClock();
  let attempts = 0;
  let notices = 0;
  const states = [];
  const errors = [];
  const conflict = Object.assign(new Error('版本冲突'), marker);
  const controller = new AutoSaveController({
    name: '冲突项目', canvas: canvas(), write: async () => { attempts += 1; throw conflict; },
    onStateChange: (state) => states.push(state), onError: (error) => errors.push(error),
    onNotice: () => { notices += 1; },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  controller.observe('冲突项目', canvas(10, 'queued'));
  const firstFlush = controller.flush();
  const rejected = assert.rejects(firstFlush, (error) => error === conflict);
  await clock.advance(0);
  await rejected;
  for (let index = 1; index <= 10; index += 1) {
    const next = canvas(10 + index, index === 10 ? 'done' : 'running');
    next.viewport.x = index * 20;
    next.nodes[1].data.title = `冲突后编辑 ${index}`;
    if (index === 10) next.nodes.push({ id: 'result', type: 'media', data: { output: true } });
    controller.observe('冲突项目', next);
    // Viewport and hidden-page handlers both call observe + flush.
    await assert.rejects(controller.flush(), (error) => error === conflict);
    await clock.advance(6000);
  }
  await assert.rejects(controller.waitForIdle(), (error) => error === conflict);
  assert.equal(attempts, 1, '409 is latched across edits, runtime progress, terminal results and flushes');
  assert.equal(errors.length, 1, 'report the conflict once');
  assert.equal(states.at(-1), 'error', 'new local edits must not mask the conflict state');
  assert.equal(notices, 0, 'never announce an automatic save after conflict');
  assert.equal(controller.hasUnsaved(), true);
  assert.equal(controller.latest.canvas.nodes.at(-1).id, 'result', 'retain results arriving after conflict');
  assert.equal(controller.latest.canvas.nodes[1].data.title, '冲突后编辑 10');
  controller.dispose();
  const replacement = new AutoSaveController({
    name: '重新打开项目', canvas: canvas(), write: async () => { attempts += 1; },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  replacement.observe('重新打开项目', canvas(50, 'done'));
  const saved = replacement.flush();
  await clock.advance(0);
  await saved;
  assert.equal(attempts, 2, 'a deliberate new controller can save normally');
  assert.equal(replacement.hasUnsaved(), false);
  replacement.dispose();
}
console.log('AUTO_SAVE_CONFLICT_OK codeAndStatusLatched=true localResultsPreserved=true');

{
  const clock = fakeClock();
  const writes = [];
  const controller = new AutoSaveController({ name: '交互', canvas: canvas(), write: async (value) => writes.push(value),
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
  let latest;
  for (const reason of ['dragging', 'resizing', 'importing']) {
    for (let index = 1; index <= 4; index += 1) {
      latest = canvas(); latest.nodes[1].position.x += index * 10;
      // A throwing serializer proves observe does not serialize in-progress gestures.
      latest.toJSON = () => { throw new Error('Must not serialize during gesture'); };
      controller.observe('交互', latest, { defer: true });
      await clock.advance(3000);
    }
    assert.equal(writes.length, 0, `${reason}: even long stationary holds do not save`);
  }
  delete latest.toJSON;
  controller.observe('交互', latest);
  await clock.advance(400);
  assert.equal(writes.length, 1, 'release/import completion merges the final snapshot');
  assert.equal(writes[0].canvas.nodes[1].position.x, 240);
  assert.equal(controller.hasUnsaved(), false);
}

{
  const initial = canvas();
  initial.nodes.push({ id: 'asset', type: 'media', data: { assetPath: 'assets/one.png', url: '', localFile: true } });
  initial.edges.push({ id: 'edge', source: 'old', target: 'active' });
  const changed = structuredClone(initial);
  changed.viewport = { x: 300, y: 200, zoom: 0.4 };
  changed.nodes[0].selected = true; changed.nodes[0].measured = { width: 700, height: 500 };
  changed.edges[0].selected = true; changed.nodes[2].data.url = 'blob:rehydrated';
  assert.deepEqual(autoSaveSignatures('项目', initial), autoSaveSignatures('项目', changed));
  changed.nodes[2].data.assetPath = 'assets/two.png';
  assert.notEqual(autoSaveSignatures('项目', initial).full, autoSaveSignatures('项目', changed).full, 'real media replacement remains durable');
  const storage = new Map(); const adapter = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  saveViewport('one', changed.viewport, adapter);
  assert.deepEqual(readViewport('one', initial.viewport, adapter), changed.viewport);
  assert.deepEqual(readViewport('two', initial.viewport, adapter), initial.viewport);
  assert.deepEqual(readViewport('one', initial.viewport, { getItem() { throw new Error('blocked'); } }), initial.viewport);
}
console.log('AUTO_SAVE_INTERACTIONS_OK gesturesDeferred=true hydrationIgnored=true viewportLocal=true');

{
  const clock = fakeClock();
  let writes = 0;
  const controller = new AutoSaveController({ name: '保存中开始导入', canvas: canvas(), write: async () => { writes += 1; },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
  const edited = canvas(); edited.nodes[1].data.title = '尚未写入';
  controller.observe('保存中开始导入', edited);
  const flushed = controller.flush();
  const rejected = assert.rejects(flushed, { code: 'SAVE_DEFERRED' }, 'IO idle after suspend must not report a successful save');
  controller.suspend();
  await clock.advance(0);
  await rejected;
  assert.equal(writes, 0);
  assert.equal(controller.hasUnsaved(), true);
  controller.observe('保存中开始导入', edited);
  const resumed = controller.flush();
  await clock.advance(0);
  await resumed;
  assert.equal(writes, 1);
}
