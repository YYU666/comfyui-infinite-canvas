import assert from 'node:assert/strict';
import test from 'node:test';
import { PaintBuffer, previewRect } from './src/paint-engine.js';
import { createLocalHistory, palmBlocksStroke, pushLocalHistory, undoLocalHistory } from './src/paint-companion.js';

test('palm rejection blocks every touch stroke and keeps pen and mouse', () => {
  assert.equal(palmBlocksStroke(true, { pointerType: 'touch' }, 1), true);
  assert.equal(palmBlocksStroke(true, { pointerType: 'touch', width: 4 }, 1), true);
  assert.equal(palmBlocksStroke(true, { pointerType: 'pen' }, 1), false);
  assert.equal(palmBlocksStroke(true, { pointerType: 'mouse' }, 1), false);
  assert.equal(palmBlocksStroke(true, { pointerType: 'touch' }, 2), false);
  assert.equal(palmBlocksStroke(false, { pointerType: 'touch' }, 1), false);
});

test('companion history restores one layer and the base stays underneath', () => {
  const base = new PaintBuffer(32, 32, [240, 20, 20, 255]);
  const lower = new PaintBuffer(32, 32);
  const upper = new PaintBuffer(32, 32);
  upper.data[2] = 255;
  upper.data[3] = 255;
  const before = upper.clone();
  upper.data[3] = 0;
  const history = createLocalHistory();
  const buffers = new Map([['lower', lower], ['upper', upper]]);
  pushLocalHistory(history, { layerId: 'upper', x: 0, y: 0, width: 32, height: 32, before: before.data, after: upper.data.slice() });
  undoLocalHistory(history, buffers);
  assert.equal(upper.data[3], 255);
  assert.equal(upper.data[2], 255);
  const doc = {
    paper: { width: 32, height: 32, background: 'white', texture: 'none', textureOpacity: 0, guideGrid: 'none' },
    layers: [
      { id: 'lower', visible: true, opacity: 100, blendMode: 'normal', clippingMask: false },
      { id: 'upper', visible: true, opacity: 100, blendMode: 'normal', clippingMask: false },
    ],
    outputMode: 'composite',
    baseOverlay: { visible: true, opacity: 100, position: 'below' },
  };
  const patch = previewRect(doc, buffers, { x: 1, y: 1, width: 1, height: 1 }, { base });
  assert.ok(patch.pixels[0] > 200 && patch.pixels[2] < 80, 'base image was not visible under the layers');
});
