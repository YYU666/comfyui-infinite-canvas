import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LAYERS, HISTORY_LIMIT, LAYER_LIMIT_MESSAGE, LAYER_BLEND_MODES, LAYER_BLEND_MODE_LABELS,
  BACKGROUND_LABELS, TEXTURE_LABELS, GUIDE_LABELS,
  createPaintData, normalizeOpacity, normalizeBlendMode, addLayer, deleteLayer, duplicateLayer,
  paintSignature, matchBaseSize, initialPaperForBase, createHistory, pushHistory, undoHistory, redoHistory,
} from './src/paint-document.js';
import {
  PaintBuffer, createBuffers, applyStroke, exportPaint, mergeDown, stampVisible, tintBuffer,
  BASIC_ROUND_BRUSH, countInk, restoreRect,
} from './src/paint-engine.js';

test('a new paint document has one layer and normalizes opacity and blend modes', () => {
  const doc = createPaintData();
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.layers[0].id, 'layer-1');
  assert.equal(doc.outputMode, 'transparent');
  assert.equal(doc.paper.width, 1280);
  assert.equal(doc.paper.height, 720);
  assert.equal(normalizeOpacity(140), 100);
  assert.equal(normalizeOpacity(-4), 0);
  assert.equal(normalizeOpacity(40.6), 41);
  for (const mode of LAYER_BLEND_MODES) assert.equal(normalizeBlendMode(mode), mode);
  assert.deepEqual(LAYER_BLEND_MODES.map((mode) => LAYER_BLEND_MODE_LABELS[mode]), ['正常', '正片叠底', '滤色', '添加', '叠加', '柔光']);
  assert.deepEqual(Object.values(BACKGROUND_LABELS), ['透明', '白色', '暖色', '深色']);
  assert.deepEqual(Object.values(TEXTURE_LABELS), ['无', '素描', '水彩']);
  assert.deepEqual(Object.values(GUIDE_LABELS), ['无', '三分法', '网格', '分镜 2×2', '分镜 3×2']);
  assert.equal(normalizeBlendMode('darken'), 'normal');
  assert.equal(normalizeBlendMode('color-dodge'), 'normal');
});

test('layer creation stops at 12 and names the required next step', () => {
  let doc = createPaintData({ paper: { width: 64, height: 64 } });
  for (let index = 1; index < MAX_LAYERS; index += 1) {
    const added = addLayer(doc);
    assert.equal(added.error, undefined);
    doc = added.doc;
  }
  assert.equal(doc.layers.length, 12);
  const blocked = addLayer(doc);
  assert.equal(blocked.error, LAYER_LIMIT_MESSAGE);
  assert.equal(blocked.doc.layers.length, 12);
  const removed = deleteLayer(doc, doc.layers[0].id);
  assert.equal(removed.doc.layers.length, 11);
  const last = deleteLayer(createPaintData());
  assert.match(last.error, /至少保留/);
});

test('duplicate, tint, merge down and stamp visible stay inside the layer cap', () => {
  let doc = createPaintData({ paper: { width: 8, height: 8 } });
  const buffers = createBuffers(doc);
  buffers.get('layer-1').data[3] = 255;
  const copied = duplicateLayer(doc);
  doc = copied.doc;
  buffers.set(doc.activeLayerId, buffers.get(copied.sourceId).clone());
  tintBuffer(buffers.get(doc.activeLayerId), '#3366ff');
  assert.equal(buffers.get(doc.activeLayerId).data[2], 255);
  doc = { ...doc, activeLayerId: doc.layers[1].id };
  const merged = mergeDown(doc, buffers);
  assert.equal(merged.doc.layers.length, 1);
  assert.equal(merged.buffers.get(merged.doc.layers[0].id).data[3] > 0, true);
  const stamped = stampVisible(merged.doc, merged.buffers);
  assert.equal(stamped.doc.layers.length, 2);
  let full = stamped.doc;
  const fullBuffers = stamped.buffers;
  while (full.layers.length < 12) {
    const added = addLayer(full);
    full = added.doc;
    fullBuffers.set(full.activeLayerId, new PaintBuffer(8, 8));
  }
  const blocked = stampVisible(full, fullBuffers);
  assert.equal(blocked.error, LAYER_LIMIT_MESSAGE);
});

test('output modes change the signature and the flattened pixels', () => {
  const doc = createPaintData({ paper: { width: 4, height: 4, background: 'white', texture: 'sketch', textureOpacity: 80, textureInOutput: false, guideGrid: 'thirds' } });
  const buffers = createBuffers(doc);
  const pixel = buffers.get('layer-1');
  pixel.data[0] = 20; pixel.data[1] = 30; pixel.data[2] = 40; pixel.data[3] = 255;
  const transparent = exportPaint({ ...doc, outputMode: 'transparent' }, buffers);
  const composite = exportPaint({ ...doc, outputMode: 'composite' }, buffers);
  const mask = exportPaint({ ...doc, outputMode: 'mask' }, buffers);
  assert.equal(transparent.data[3], 255);
  assert.equal(transparent.data[7], 0);
  assert.equal(composite.data[4], 255);
  assert.equal(composite.data[7], 255);
  assert.deepEqual([mask.data[0], mask.data[1], mask.data[2]], [255, 255, 255]);
  assert.deepEqual([mask.data[4], mask.data[5], mask.data[6]], [0, 0, 0]);
  const guides = exportPaint({ ...doc, outputMode: 'composite', paper: { ...doc.paper, guideGrid: 'none' } }, buffers);
  assert.equal(guides.data[4], composite.data[4]);
  const textured = exportPaint({ ...doc, outputMode: 'composite', paper: { ...doc.paper, textureInOutput: true, guideGrid: 'none' } }, buffers);
  assert.notEqual(textured.data[4], composite.data[4]);
  const base = new PaintBuffer(4, 4, [10, 20, 30, 255]);
  const withBase = exportPaint({ ...doc, outputMode: 'composite' }, buffers, { base });
  assert.notEqual(withBase.data[4], composite.data[4]);
  const signA = paintSignature({ ...doc, assetPath: 'assets/a.png', outputMode: 'transparent' });
  const signB = paintSignature({ ...doc, assetPath: 'assets/a.png', outputMode: 'mask' });
  const signC = paintSignature({ ...doc, assetPath: 'assets/b.png', outputMode: 'transparent' });
  assert.notEqual(signA, signB);
  assert.notEqual(signA, signC);
});

test('history keeps a single dirty rectangle and drops entries past the cap', () => {
  const doc = createPaintData({ paper: { width: 32, height: 32 } });
  const buffers = createBuffers(doc);
  for (let index = 1; index < 12; index += 1) buffers.set(`extra-${index}`, new PaintBuffer(32, 32));
  const history = createHistory(HISTORY_LIMIT);
  const entry = applyStroke(buffers.get('layer-1'), [{ x: 4, y: 4, pressure: 1 }, { x: 6, y: 5, pressure: 1 }], { ...BASIC_ROUND_BRUSH, size: 4, spacing: 50, smoothing: 0 }, '#000000', { layerId: 'layer-1' });
  assert.ok(entry.before.length < 32 * 32 * 4);
  assert.equal(entry.before.length, entry.width * entry.height * 4);
  assert.equal(entry.layerId, 'layer-1');
  pushHistory(history, entry);
  assert.ok(countInk(buffers.get('layer-1')) > 0);
  restoreRect(buffers.get('layer-1'), { ...entry, pixels: entry.before });
  assert.equal(countInk(buffers.get('layer-1')), 0);
  for (let index = 0; index < 45; index += 1) pushHistory(history, { type: 'pixels', serial: index, before: new Uint8ClampedArray(8), after: new Uint8ClampedArray(8) });
  assert.equal(history.undo.length, 40);
  assert.equal(history.undo[0].serial, 5);
  const undone = undoHistory(history);
  assert.equal(undone.serial, 44);
  assert.equal(redoHistory(history).serial, 44);
  assert.equal(undoHistory(createHistory()), null);
});

test('first blank visit matches the base image and caps the long edge at 4096', () => {
  assert.deepEqual(matchBaseSize(8000, 2000), { width: 4096, height: 1024 });
  assert.deepEqual(matchBaseSize(100, 50), { width: 100, height: 64 });
  const fresh = createPaintData();
  assert.deepEqual(initialPaperForBase(fresh, { width: 800, height: 200 }).width, 800);
  assert.equal(initialPaperForBase({ ...fresh, touched: true }, { width: 800, height: 200 }).width, 1280);
});
