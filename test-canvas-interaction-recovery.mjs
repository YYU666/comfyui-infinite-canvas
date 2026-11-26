import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AutoSaveController } from './src/auto-save.js';

const source = readFileSync(new URL('./src/CanvasWorkbench.jsx', import.meta.url), 'utf8');
const effect = source.match(/useEffect\((function recoverEndedInteraction\(\) \{[\s\S]*?), \[project\.id, setNodes\]\);/)[1];
assert.match(source, /defer: interactionRef\.current \|\| nodes\.some\(\(node\) => node\.dragging \|\| node\.resizing\) \|\| mediaWritesRef\.current\.size > 0/);

function fixture({ flags = true, media = false } = {}) {
  let nodes = [{ id: 'node', position: { x: 0, y: 0 }, data: {}, dragging: flags, resizing: flags }];
  const interactionRef = { current: true };
  const mediaWrites = new Map(media ? [['upload', Promise.resolve()]] : []);
  const writes = [];
  const controller = new AutoSaveController({ name: 'fixture', canvas: { nodes, edges: [] },
    write: async snapshot => writes.push(snapshot), debounceMs: 0, minIntervalMs: 0 });
  const listeners = new Map();
  const timers = new Map();
  let nextId = 0;
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    setTimeout(callback) { timers.set(++nextId, callback); return nextId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const observe = () => controller.observe('fixture', { nodes, edges: [] }, {
    defer: interactionRef.current || nodes.some(node => node.dragging || node.resizing) || mediaWrites.size > 0,
  });
  const cleanup = new Function('window', 'interactionRef', 'setNodes', `return (${effect})();`)(window, interactionRef, update => {
    nodes = update(nodes); observe();
  });
  observe();
  return { controller, writes, mediaWrites, observe, cleanup, listeners, timers, interactionRef,
    nodes: () => nodes,
    finalPosition: () => { nodes = nodes.map(node => ({ ...node, position: { x: 123, y: 456 } })); },
    emit: (type, buttons = 0) => listeners.get(type)?.({ type, buttons }),
    tick: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
  };
}

for (const event of ['pointerup', 'pointercancel', 'mouseup', 'blur']) {
  const f = fixture();
  await assert.rejects(f.controller.flush(), { code: 'SAVE_DEFERRED' });
  f.emit(event);
  assert.equal(f.interactionRef.current, true, 'wait for final ReactFlow updates');
  f.finalPosition();
  f.tick();
  await f.controller.flush();
  assert.equal(f.interactionRef.current, false);
  assert.equal(f.nodes()[0].dragging, false);
  assert.equal(f.nodes()[0].resizing, false);
  assert.deepEqual(f.writes[0].canvas.nodes[0].position, { x: 123, y: 456 });
  f.cleanup(); f.controller.dispose();
}
const refOnly = fixture({ flags: false });
refOnly.finalPosition(); refOnly.emit('blur'); refOnly.tick();
await refOnly.controller.flush();
assert.equal(refOnly.writes.length, 1, 'ref-only suspension resumes observation');
refOnly.cleanup(); refOnly.controller.dispose();

const upload = fixture({ media: true });
upload.finalPosition(); upload.emit('pointerup'); upload.tick();
await assert.rejects(upload.controller.flush(), { code: 'SAVE_DEFERRED' });
assert.equal(upload.mediaWrites.size, 1, 'interaction recovery cannot clear media writes');
assert.equal(upload.writes.length, 0);
upload.mediaWrites.clear(); upload.observe(); await upload.controller.flush();
assert.equal(upload.writes.length, 1);
upload.cleanup(); upload.controller.dispose();

const newer = fixture();
newer.emit('pointerup'); newer.emit('pointerdown'); newer.tick();
assert.equal(newer.interactionRef.current, true, 'new interaction cancels stale release recovery');
newer.emit('mouseup', 1); newer.tick();
assert.equal(newer.interactionRef.current, true, 'held buttons keep interaction active');
newer.emit('blur'); newer.cleanup(); newer.tick();
assert.equal(newer.interactionRef.current, true, 'cleanup cancels old-project callback');
assert.equal(newer.listeners.size, 0);
newer.controller.dispose();
console.log('CANVAS_INTERACTION_RECOVERY_OK finalPosition=true pointerCancelBlur=true mediaGuard=true newDragAndCleanup=true');
