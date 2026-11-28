import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { forwardPaintViewport, invertPaintViewport, clientToCanvasPoint } from './src/paint-viewport.js';
import { classifyPointerDown, coalescedPointerEvents, hoverShouldFinish, inputSourceLabel, isForeignPointer, isPalmTouch } from './src/paint-pointer.js';

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

test('a cached viewport inverse is reused without reading the live transform', () => {
  globalThis.DOMPoint = globalThis.DOMPoint || class DOMPoint {
    constructor(x, y) { this.x = x; this.y = y; }
  };
  const inverse = { transformPoint(point) { return { x: point.x / 2, y: point.y / 2 }; } };
  const frame = { transform() { throw new Error('live style'); } };
  const local = clientToCanvasPoint(20, 40, frame, { inverse, layoutLeft: 0, layoutTop: 0 });
  assert.ok(Math.abs(local.x - 10) < 0.001);
  assert.ok(Math.abs(local.y - 20) < 0.001);
});

test('coalesced samples are read from the native event', () => {
  const nativeSamples = [{ clientX: 4 }, { clientX: 9 }];
  const event = {
    clientX: 1,
    getCoalescedEvents: () => [{ clientX: 99 }],
    nativeEvent: { getCoalescedEvents: () => nativeSamples },
  };
  assert.deepEqual(coalescedPointerEvents(event), nativeSamples);
  const empty = { clientX: 3, nativeEvent: { clientX: 3, getCoalescedEvents: () => [] } };
  assert.deepEqual(coalescedPointerEvents(empty), [empty.nativeEvent]);
  const bare = { clientX: 8 };
  assert.deepEqual(coalescedPointerEvents(bare), [bare]);
});

test('pen buttons pan, ignore, or erase instead of drawing', () => {
  assert.equal(classifyPointerDown({ button: 1, buttons: 4 }), 'pan');
  assert.equal(classifyPointerDown({ button: 2, buttons: 2 }), 'ignore');
  assert.equal(classifyPointerDown({ button: 5, buttons: 32 }), 'eraser');
  assert.equal(classifyPointerDown({ button: 0, buttons: 33 }), 'eraser');
  assert.equal(classifyPointerDown({ button: 3, buttons: 8 }), 'ignore');
  assert.equal(classifyPointerDown({ button: 4, buttons: 16 }), 'ignore');
  assert.equal(classifyPointerDown({ button: 0, buttons: 1 }), 'draw');
  assert.equal(isForeignPointer(7, 8), true);
  assert.equal(isForeignPointer(7, 7), false);
  assert.equal(isPalmTouch(true, 'touch', true), true);
  assert.equal(isPalmTouch(true, 'pen', true), false);
  assert.equal(isPalmTouch(false, 'touch', true), false);
});

test('a hovering pointer with no buttons ends an open stroke', () => {
  for (const kind of ['brush', 'eraser', 'smudge', 'select-rect', 'select-ellipse', 'move']) {
    assert.equal(hoverShouldFinish(kind, 0), true);
    assert.equal(hoverShouldFinish(kind, 1), false);
  }
  assert.equal(hoverShouldFinish('pan', 0), true);
  assert.equal(inputSourceLabel({ pointerType: 'pen', pressure: 0.64, buttons: 1 }), '笔 64%');
  assert.equal(inputSourceLabel({ pointerType: 'pen', pressure: 0.4, button: 5, buttons: 32 }), '橡皮端');
  assert.equal(inputSourceLabel({ pointerType: 'mouse', pressure: 0.5, buttons: 1 }), '鼠标');
});

test('the paint stage wires native samples, button guards, and the input capsule', () => {
  const source = readFileSync(new URL('./src/PaintEditor.jsx', import.meta.url), 'utf8');
  assert.match(source, /coalescedPointerEvents\(event\)/);
  assert.doesNotMatch(source, /event\.getCoalescedEvents/);
  assert.match(source, /onLostPointerCapture=\{onPointerUp\}/);
  assert.match(source, /onContextMenu=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(source, /data-testid="paint-input-source"/);
  assert.match(source, /capturePaintViewport\(/);
});
