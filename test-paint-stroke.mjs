import assert from 'node:assert/strict';
import test from 'node:test';
import { PaintBuffer, applyStroke, resizeStamp, clampStampMaxEdge, createStrokeSession, strokeTo, finishStroke, BASIC_ROUND_BRUSH, brushStamp, brushStampCacheSize, clearBrushStampCache, previewRect, previewFitCacheStats, resetPreviewFitCache, restoreRect, createBuffers } from './src/paint-engine.js';
import { createPaintData, addLayer, createHistory, pushHistory, undoHistory, structurePatch } from './src/paint-document.js';
import { mergeDown, stampVisible } from './src/paint-engine.js';
import { BUILTIN_BRUSHES, IMPORT_BRUSH_PARAMS } from './src/paint-brushes.js';

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

test('a stroke keeps one layer snapshot and crops it when the stroke ends', () => {
  const buffer = new PaintBuffer(48, 32);
  buffer.data[0] = 7;
  const session = createStrokeSession(buffer, { ...BASIC_ROUND_BRUSH, id: 'snap', size: 6, spacing: 40, smoothing: 0, pressureSize: false }, '#ff0000', { layerId: 'layer-1' });
  const snapshot = session.beforeSnapshot;
  assert.equal(snapshot.length, buffer.data.length);
  assert.equal(snapshot[0], 7);
  strokeTo(session, { x: 8, y: 8, pressure: 1, pointerType: 'pen' });
  strokeTo(session, { x: 30, y: 12, pressure: 0.4, pointerType: 'pen' });
  assert.equal(session.beforeSnapshot, snapshot);
  assert.equal(snapshot[0], 7);
  assert.equal(session.before, undefined);
  assert.ok(session.dirty.width > 6 && session.dirty.height > 6);
  const entry = finishStroke(session);
  assert.equal(session.beforeSnapshot, null);
  assert.equal(entry.before.length, entry.width * entry.height * 4);
  assert.equal(entry.after.length, entry.before.length);
  let painted = false;
  for (let index = 3; index < entry.after.length; index += 4) {
    if (entry.after[index] === 0) continue;
    assert.equal(entry.before[index], 0);
    painted = true;
    break;
  }
  assert.equal(painted, true);
  restoreRect(buffer, { x: entry.x, y: entry.y, width: entry.width, height: entry.height, pixels: entry.before });
  assert.equal(buffer.data[(8 * buffer.width + 8) * 4 + 3], 0);
  assert.equal(buffer.data[0], 7);
});

test('brush stamps stay in a 64-entry cache', () => {
  clearBrushStampCache();
  const brush = { id: 'cache-round', kind: 'round', hardness: 80 };
  const first = brushStamp(brush, 1);
  const again = brushStamp(brush, 1.2);
  assert.equal(again, first);
  assert.equal(brushStamp({ ...brush, hardness: 10 }, 1), brushStamp({ ...brush, hardness: 10 }, 1));
  assert.notEqual(brushStamp({ ...brush, hardness: 10 }, 1), first);
  const pixel = brushStamp({ id: 'cache-round', kind: 'pixel', hardness: 80 }, 1);
  assert.notEqual(pixel, first);
  for (let diameter = 2; diameter <= 65; diameter += 1) brushStamp(brush, diameter);
  assert.equal(brushStampCacheSize(), 64);
  const rebuilt = brushStamp(brush, 1);
  assert.notEqual(rebuilt, first);
  assert.equal(brushStamp(brush, 1), rebuilt);
});

test('previewRect fits a reference image once per base and paper size', () => {
  resetPreviewFitCache();
  const doc = createPaintData({ paper: { width: 8, height: 6, background: 'white' }, baseOverlay: { visible: true, opacity: 100, position: 'below' } });
  const buffers = createBuffers(doc);
  const base = new PaintBuffer(2, 2, [20, 30, 40, 255]);
  const first = previewRect(doc, buffers, { x: 0, y: 0, width: 4, height: 3 }, { base });
  const second = previewRect(doc, buffers, { x: 1, y: 1, width: 2, height: 2 }, { base });
  assert.equal(first.pixels.length, 4 * 3 * 4);
  assert.equal(second.pixels.length, 2 * 2 * 4);
  assert.deepEqual(previewFitCacheStats(), { hits: 1, misses: 1 });
  previewRect({ ...doc, paper: { ...doc.paper, width: 10, height: 6 } }, buffers, { x: 0, y: 0, width: 2, height: 2 }, { base });
  assert.equal(previewFitCacheStats().misses, 2);
});

test('common drawing brushes default to a short smoothing range', () => {
  assert.ok(BASIC_ROUND_BRUSH.smoothing >= 8 && BASIC_ROUND_BRUSH.smoothing <= 12, BASIC_ROUND_BRUSH.smoothing);
  const hard = BUILTIN_BRUSHES.find((brush) => brush.id === 'builtin-hard-round');
  assert.ok(hard.params.smoothing >= 8 && hard.params.smoothing <= 12, hard.params.smoothing);
  assert.ok(IMPORT_BRUSH_PARAMS.smoothing >= 8 && IMPORT_BRUSH_PARAMS.smoothing <= 12);
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
