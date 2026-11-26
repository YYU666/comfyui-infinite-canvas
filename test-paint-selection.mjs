import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaintData, addLayer, LAYER_LIMIT_MESSAGE } from './src/paint-document.js';
import {
  PaintBuffer, createBuffers, applyStroke, BASIC_ROUND_BRUSH, countInk, restoreRect,
  rectSelection, ellipseSelection, lassoSelection, magicWandSelection, combineSelection, invertSelection,
  offsetSelection, featherSelection, growSelection, moveSelectionPixels, copySelection, clearSelection,
  fillColor, floodFill, compositeLayers,
} from './src/paint-engine.js';

const brush = { ...BASIC_ROUND_BRUSH, size: 1, hardness: 100, spacing: 100, smoothing: 0, pressureSize: false, kind: 'pixel' };

function inkAt(buffer, x, y) {
  const offset = (y * buffer.width + x) * 4;
  return [buffer.data[offset], buffer.data[offset + 1], buffer.data[offset + 2], buffer.data[offset + 3]];
}

test('rect, ellipse, lasso and magic wand selections cover the expected pixels', () => {
  const buffer = new PaintBuffer(12, 12);
  const rect = rectSelection(12, 12, 1, 1, 4, 4);
  assert.equal(rect.data[1 * 12 + 1], 255);
  assert.equal(rect.data[0], 0);
  const ellipse = ellipseSelection(12, 12, 0, 0, 10, 10);
  assert.equal(ellipse.data[5 * 12 + 5] > 0, true);
  assert.equal(ellipse.data[0], 0);
  const lasso = lassoSelection(12, 12, [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 4, y: 8 }]);
  assert.equal(lasso.data[3 * 12 + 4] > 0, true);
  assert.equal(lasso.data[10 * 12 + 10], 0);
  for (let x = 2; x <= 6; x += 1) buffer.data[(4 * 12 + x) * 4 + 3] = 255;
  buffer.data[(4 * 12 + 4) * 4] = 200;
  const wand = magicWandSelection(buffer, 4, 4, 0);
  assert.equal(wand.data[4 * 12 + 4], 255);
  assert.equal(wand.data[4 * 12 + 2], 0);
  const loose = magicWandSelection(buffer, 4, 4, 100);
  assert.equal(loose.data[4 * 12 + 2], 255);
});

test('add, subtract and invert change only the selection mask', () => {
  const rect = rectSelection(8, 8, 0, 0, 3, 3);
  const extra = rectSelection(8, 8, 3, 3, 6, 6);
  const added = combineSelection(rect, extra, 'add');
  assert.equal(added.data[0], 255);
  assert.equal(added.data[6 * 8 + 6], 255);
  const removed = combineSelection(added, rect, 'subtract');
  assert.equal(removed.data[0], 0);
  assert.equal(removed.data[6 * 8 + 6], 255);
  const inverted = invertSelection(rect);
  assert.equal(inverted.data[0], 0);
  assert.equal(inverted.data[7 * 8 + 7], 255);
});

test('moving the marching ants leaves pixels in place, and V moves only selected pixels', () => {
  const buffer = new PaintBuffer(8, 8);
  buffer.data[(2 * 8 + 2) * 4] = 255;
  buffer.data[(2 * 8 + 2) * 4 + 3] = 255;
  const selection = rectSelection(8, 8, 1, 1, 3, 3);
  const movedFrame = offsetSelection(selection, 2, 0);
  assert.deepEqual(inkAt(buffer, 2, 2), [255, 0, 0, 255]);
  assert.equal(movedFrame.data[2 * 8 + 4], 255);
  assert.equal(selection.data[2 * 8 + 2], 255);
  const moved = moveSelectionPixels(buffer, selection, 3, 0);
  assert.equal(inkAt(buffer, 2, 2)[3], 0);
  assert.deepEqual(inkAt(buffer, 5, 2), [255, 0, 0, 255]);
  assert.equal(moved.selection.data[2 * 8 + 5], 255);
});

test('copy, cut and paste create a new layer until the 12 layer cap', () => {
  let doc = createPaintData({ paper: { width: 8, height: 8 } });
  const buffers = createBuffers(doc);
  const buffer = buffers.get('layer-1');
  buffer.data[0] = 10; buffer.data[1] = 20; buffer.data[2] = 30; buffer.data[3] = 255;
  const selection = rectSelection(8, 8, 0, 0, 1, 1);
  const copied = copySelection(buffer, selection);
  assert.equal(copied.pixels[3], 255);
  clearSelection(buffer, selection);
  assert.equal(buffer.data[3], 0);
  const added = addLayer(doc);
  doc = added.doc;
  const pasted = new PaintBuffer(8, 8);
  pasted.data.set(copied.pixels.subarray(0, 4), (copied.originY * 8 + copied.originX) * 4);
  buffers.set(doc.activeLayerId, pasted);
  assert.equal(doc.layers.length, 2);
  assert.equal(buffers.get(doc.activeLayerId).data[3], 255);
  while (doc.layers.length < 12) doc = addLayer(doc).doc;
  assert.equal(addLayer(doc).error, LAYER_LIMIT_MESSAGE);
});

test('feather and grow change the mask edge, and tools cannot paint outside the selection', () => {
  const hard = rectSelection(10, 10, 2, 2, 6, 6);
  const soft = featherSelection(hard, 2);
  assert.ok(soft.data[4 * 10 + 4] > 200);
  assert.ok(soft.data[1 * 10 + 4] > 0 && soft.data[1 * 10 + 4] < 255);
  const grown = growSelection(hard, 2);
  assert.equal(grown.data[1 * 10 + 4], 255);
  const shrunk = growSelection(hard, -1);
  assert.equal(shrunk.data[2 * 10 + 2], 0);
  assert.equal(shrunk.data[4 * 10 + 4], 255);
  const buffer = new PaintBuffer(10, 10);
  applyStroke(buffer, [{ x: 1, y: 1, pressure: 1 }, { x: 8, y: 8, pressure: 1 }], brush, '#ff0000', { selection: hard });
  assert.equal(inkAt(buffer, 1, 1)[3], 0);
  assert.ok(countInk(buffer) > 0);
  const filled = new PaintBuffer(10, 10);
  fillColor(filled, '#00ff00', hard, false);
  assert.equal(inkAt(filled, 1, 1)[3], 0);
  assert.equal(inkAt(filled, 4, 4)[1], 255);
  const erased = filled.clone();
  const outside = inkAt(erased, 8, 8)[3];
  applyStroke(erased, [{ x: 4, y: 4, pressure: 1 }, { x: 8, y: 8, pressure: 1 }], brush, '#000', { selection: hard, eraser: true });
  assert.equal(inkAt(erased, 8, 8)[3], outside);
  assert.equal(inkAt(erased, 4, 4)[3] < 255, true);
});

test('foreground fill and flood fill respect alpha lock, selection and expand', () => {
  const buffer = new PaintBuffer(8, 8);
  buffer.data[3] = 255;
  const selection = rectSelection(8, 8, 0, 0, 2, 2);
  fillColor(buffer, '#112233', selection, true);
  assert.deepEqual(inkAt(buffer, 0, 0), [0x11, 0x22, 0x33, 255]);
  assert.equal(inkAt(buffer, 1, 0)[3], 0);
  const region = new PaintBuffer(6, 6, [255, 255, 255, 255]);
  region.data[(2 * 6 + 2) * 4] = 0;
  region.data[(2 * 6 + 2) * 4 + 1] = 0;
  region.data[(2 * 6 + 2) * 4 + 2] = 0;
  floodFill(region, 0, 0, [0, 0, 255, 255], { tolerance: 0, expand: 0 });
  assert.equal(inkAt(region, 0, 0)[2], 255);
  assert.equal(inkAt(region, 2, 2)[2], 0);
  const expanded = new PaintBuffer(6, 6, [255, 255, 255, 255]);
  floodFill(expanded, 0, 0, [0, 0, 255, 255], { tolerance: 10, expand: 1 });
  assert.equal(countInk(expanded), 6 * 6);
  const current = new PaintBuffer(5, 5);
  const reference = new PaintBuffer(5, 5, [0, 0, 0, 255]);
  for (let x = 0; x < 5; x += 1) reference.data[(2 * 5 + x) * 4] = 255;
  floodFill(current, 0, 0, [255, 0, 0, 255], { tolerance: 0, reference });
  assert.equal(inkAt(current, 0, 1)[3], 255);
  assert.equal(inkAt(current, 0, 3)[3], 0);
  const layers = [
    { id: 'base', visible: true, opacity: 100, blendMode: 'normal', clippingMask: false },
    { id: 'clip', visible: true, opacity: 100, blendMode: 'multiply', clippingMask: true },
  ];
  const buffers = new Map([['base', new PaintBuffer(2, 2)], ['clip', new PaintBuffer(2, 2, [0, 0, 255, 255])]]);
  buffers.get('base').data[3] = 255;
  const flat = compositeLayers(2, 2, layers, buffers);
  assert.equal(flat.data[3], 255);
  assert.equal(flat.data[7], 0);
});

test('undo of a clipped stroke restores the dirty rectangle exactly', () => {
  const doc = createPaintData({ paper: { width: 16, height: 16 } });
  const buffer = createBuffers(doc).get('layer-1');
  const selection = rectSelection(16, 16, 4, 4, 10, 10);
  const entry = applyStroke(buffer, [{ x: 0, y: 0, pressure: 0.2 }, { x: 12, y: 12, pressure: 1 }], { ...brush, size: 3 }, '#abcdef', { selection, pressureCurve: 'hard' });
  assert.equal(inkAt(buffer, 0, 0)[3], 0);
  const snapshot = buffer.clone();
  restoreRect(buffer, { ...entry, pixels: entry.before });
  assert.equal(countInk(buffer), 0);
  restoreRect(buffer, { ...entry, pixels: entry.after });
  assert.equal(countInk(buffer), countInk(snapshot));
});
