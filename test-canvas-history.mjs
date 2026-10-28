import assert from 'node:assert/strict';
import { CanvasHistory, restoreHistoryNodes } from './src/canvas-history.js';

const node = (id, title = id, x = 0) => ({ id, type: 'note', position: { x, y: 0 }, data: { title, text: title, status: 'idle', progress: 0 } });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });

{
  const history = new CanvasHistory([node('a')], []);
  history.observe([node('a'), node('b')], []);
  history.observe([node('a', '改名'), node('b')], []);
  history.observe([node('a', '改名')], []);
  history.observe([node('a', '改名')], [edge('a', 'b')]);
  assert.equal(history.past.length, 4);
  assert.equal(history.undo().edges.length, 0, 'undo connection');
  assert.equal(history.undo().nodes.length, 2, 'undo deletion');
  assert.equal(history.undo().nodes[0].data.title, 'a', 'undo edit');
  assert.equal(history.undo().nodes.length, 1, 'undo addition');
  assert.equal(history.undo(), null);
  assert.equal(history.redo().nodes.length, 2, 'redo addition');
  assert.equal(history.redo().nodes[0].data.title, '改名', 'redo edit');
  assert.equal(history.redo().nodes.length, 1, 'redo deletion');
  assert.equal(history.redo().edges.length, 1, 'redo connection');
  console.log('CANVAS_HISTORY_CRUD_OK additions edits deletions connections');
}

{
  const history = new CanvasHistory([node('a')], []);
  for (let index = 1; index <= 20; index += 1) history.observe([{ ...node('a', 'a', index), dragging: true }], [], { coalesce: true });
  history.observe([node('a', 'a', 20)], []);
  assert.equal(history.past.length, 1, 'one drag gesture is one history entry');
  assert.equal(history.undo().nodes[0].position.x, 0);
  assert.equal(history.redo().nodes[0].position.x, 20);
  console.log('CANVAS_HISTORY_DRAG_OK steps=1');
}

{
  const history = new CanvasHistory([node('a')], []);
  for (let index = 1; index <= 60; index += 1) history.observe([node('a', `编辑-${index}`)], []);
  assert.equal(history.past.length, 50, 'history is capped at 50 steps');
  assert.equal(history.past[0].snapshot.nodes[0].data.title, '编辑-10');
  for (let index = 0; index < 50; index += 1) assert(history.undo());
  assert.equal(history.undo(), null);
  console.log('CANVAS_HISTORY_LIMIT_OK steps=50');
}

{
  const history = new CanvasHistory([node('a')], []);
  const running = node('a'); running.data = { ...running.data, status: 'running', progress: 70, stage: '采样', queueJobId: 'job_runtime_only' };
  history.observe([running], []);
  assert.equal(history.past.length, 0, 'generation progress never creates history entries');
  const edited = [node('a', '改标题')];
  history.observe(edited, []);
  const target = history.undo();
  const restored = restoreHistoryNodes(target.nodes, [{ ...running, data: { ...running.data, status: 'done', progress: 100 } }]);
  assert.equal(restored[0].data.title, 'a');
  assert.equal(restored[0].data.status, 'done', 'undo does not resurrect an old runtime state');
  assert.equal(restored[0].data.progress, 100);
  assert.equal(history.redo().nodes[0].data.title, '改标题', 'new edits preserve redo');
  history.observe([node('a', '另一条分支')], []);
  assert.equal(history.future.length, 0, 'new edit clears redo branch');
  console.log('CANVAS_HISTORY_RUNTIME_OK silent=true runtimePreserved=true');
}
