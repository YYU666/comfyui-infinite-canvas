import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardPaintViewport, invertPaintViewport } from './src/paint-viewport.js';

test('a 45 degree viewport maps a pixel back to itself', () => {
  const view = { layoutLeft: 12, layoutTop: 28, panX: 40, panY: 16, zoom: 1.25, rotation: 45, flip: false };
  const client = forwardPaintViewport(100, 80, view);
  const local = invertPaintViewport(client.x, client.y, view);
  assert.ok(Math.abs(local.x - 100) < 0.001, local.x);
  assert.ok(Math.abs(local.y - 80) < 0.001, local.y);
  const mirrored = { ...view, flip: true, rotation: -30, zoom: 0.8 };
  const other = forwardPaintViewport(40, 70, mirrored);
  const back = invertPaintViewport(other.x, other.y, mirrored);
  assert.ok(Math.abs(back.x - 40) < 0.001);
  assert.ok(Math.abs(back.y - 70) < 0.001);
});
