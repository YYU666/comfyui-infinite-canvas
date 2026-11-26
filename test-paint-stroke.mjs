import assert from 'node:assert/strict';
import test from 'node:test';
import { PaintBuffer, applyStroke, resizeStamp, clampStampMaxEdge, createStrokeSession, strokeTo, finishStroke, BASIC_ROUND_BRUSH } from './src/paint-engine.js';
import { createPaintData, addLayer, createHistory, pushHistory, undoHistory, structurePatch } from './src/paint-document.js';
import { mergeDown, stampVisible } from './src/paint-engine.js';

test('small stamps scale up to the requested diameter', () => {
  const tip = { width: 8, height: 8, alpha: new Uint8Array(64).fill(255) };
  const grown = resizeStamp(tip, 120);
  assert.equal(Math.max(grown.width, grown.height), 120);
  const pencil = resizeStamp({ width: 24, height: 24, alpha: new Uint8Array(24 * 24).fill(200) }, 120);
  assert.equal(Math.max(pencil.width, pencil.height), 120);
  assert.equal(Math.max(clampStampMaxEdge(grown, 512).width, clampStampMaxEdge(grown, 512).height), 120);
  const buffer = new PaintBuffer(400, 400);
  applyStroke(buffer, [{ x: 200, y: 200, pressure: 1, pointerType: 'mouse' }], {
    ...BASIC_ROUND_BRUSH, size: 120, spacing: 100, smoothing: 0, pressureSize: false, stamp: tip,
  }, '#111111');
  assert.ok(buffer.data[(200 * 400 + 250) * 4 + 3] > 0, 'a 120px stamp missed a pixel 50px from the center');
  assert.equal(buffer.data[(200 * 400 + 290) * 4 + 3], 0, 'a 120px stamp painted 90px away');
});

test('a long stroke on a 2K sheet stays incremental', () => {
  const buffer = new PaintBuffer(2048, 1152);
  const stamp = { width: 8, height: 8, alpha: new Uint8Array(64).fill(255) };
  const session = createStrokeSession(buffer, { ...BASIC_ROUND_BRUSH, size: 24, spacing: 12, smoothing: 0, pressureSize: false, stamp }, '#111111', { layerId: 'layer-1' });
  const started = performance.now();
  let largest = 0;
  for (let index = 0; index < 120; index += 1) {
    const dirty = strokeTo(session, { x: 30 + index * 12, y: 420, pressure: 0.8, pointerType: 'pen' });
    largest = Math.max(largest, dirty?.width || 0, dirty?.height || 0);
  }
  const elapsed = performance.now() - started;
  const entry = finishStroke(session);
  assert.ok(elapsed < 1200, `incremental stroke took ${elapsed}ms`);
  assert.ok(largest < 500, `segment dirty edge was ${largest}`);
  assert.ok(entry.width < 2048 && entry.height < 1152);
  assert.equal(buffer.data[(10 * 2048 + 10) * 4 + 3], 0);
  assert.ok(buffer.data[(420 * 2048 + 80) * 4 + 3] > 0);
});

test('merge and stamp history restores the previous layers', () => {
  const doc = createPaintData({ paper: { width: 64, height: 64 } });
  const added = addLayer(doc);
  const buffers = new Map([
    [doc.layers[0].id, new PaintBuffer(64, 64, [0, 0, 255, 255])],
    [added.doc.activeLayerId, new PaintBuffer(64, 64, [255, 0, 0, 128])],
  ]);
  const merged = mergeDown({ ...added.doc, activeLayerId: added.doc.layers.at(-1).id }, buffers);
  assert.equal(merged.error, undefined);
  const history = createHistory();
  const patch = structurePatch(buffers, merged.buffers);
  const beforeBuffers = new Map([...patch.keys()].map((id) => [id, buffers.get(id)?.clone() || null]));
  pushHistory(history, { type: 'doc', beforeDoc: added.doc, afterDoc: merged.doc, bufferPatch: patch, beforeBuffers });
  const undone = undoHistory(history);
  assert.equal(undone.beforeDoc.layers.length, added.doc.layers.length);
  assert.ok(undone.beforeBuffers.get(added.doc.activeLayerId));
  const stamped = stampVisible(doc, new Map([[doc.layers[0].id, new PaintBuffer(64, 64, [1, 2, 3, 255])]]));
  const stampHistory = createHistory();
  pushHistory(stampHistory, { type: 'doc', beforeDoc: doc, afterDoc: stamped.doc, bufferPatch: structurePatch(new Map([[doc.layers[0].id, new PaintBuffer(64, 64)]]), stamped.buffers), beforeBuffers: new Map() });
  assert.equal(undoHistory(stampHistory).beforeDoc.layers.length, 1);
});
