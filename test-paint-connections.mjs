import test from 'node:test';
import assert from 'node:assert/strict';
import { planCanvasConnection } from './src/canvas-connections.js';
import { acceptsImageProcessConnection, imageProcessSnapshot } from './src/image-process-graph.js';
import { canvasEdgeLook, canvasNodeModality } from './src/canvas-obsidian.js';
import { createPaintData, paintSignature } from './src/paint-document.js';

const paint = (id, extra = {}) => ({ id, type: 'paint', data: createPaintData({ title: id, assetPath: `assets/${id}.png`, url: `/api/${id}.png`, paintSignature: paintSignature({ assetPath: `assets/${id}.png` }), ...extra }) });
const media = (id, kind = 'image') => ({ id, type: 'media', data: { kind, assetPath: `assets/${id}.png`, url: `/${id}.png` } });
const process = (id, mode, extra = {}) => ({ id, type: 'imageProcess', data: { mode, status: 'idle', title: id, ...extra } });
const generator = (id, mode, extra = {}) => ({ id, type: 'generator', data: { mode, status: 'idle', ...extra } });
const conn = (source, target, handle, sourceHandle = 'ref') => ({ source, target, targetHandle: handle, sourceHandle });

test('paint uses the violet modality and pearl image ports', () => {
  assert.equal(canvasNodeModality('paint'), 'violet');
  const look = canvasEdgeLook(paint('sketch'), 'ref', process('blend', 'imageBlend'), 'overlay');
  assert.equal(look.from, '#e6ddc7');
  assert.equal(look.to, '#e6ddc7');
});

test('paint cannot cycle into itself and can feed image, color, channel and generator nodes', () => {
  const sketch = paint('sketch');
  const repair = paint('repair');
  const blend = process('blend', 'imageBlend');
  const adjust = process('adjust', 'colorAdjust');
  const pack = process('pack', 'channelPack');
  const image = generator('image', 'image');
  const nodes = [sketch, repair, blend, adjust, pack, image, media('photo')];
  assert.match(planCanvasConnection(conn('sketch', 'repair', 'base'), nodes, [{ source: 'repair', target: 'sketch', targetHandle: 'base' }]).error, /循环/);
  assert.equal(planCanvasConnection(conn('sketch', 'sketch', 'base'), nodes, []).error !== undefined, true);
  assert.equal(planCanvasConnection(conn('photo', 'sketch', 'base'), nodes, []).connection.targetHandle, 'base');
  assert.equal(planCanvasConnection(conn('adjust', 'sketch', 'base'), nodes, []).connection.targetHandle, 'base');
  for (const [target, handle] of [['blend', 'overlay'], ['blend', 'base'], ['blend', 'mask'], ['adjust', 'guide'], ['pack', 'red'], ['image', 'guide']]) {
    const plan = planCanvasConnection(conn('sketch', target, handle), nodes, []);
    assert.equal(plan.error, undefined, `${target}:${handle} ${plan.error || ''}`);
    assert.equal(plan.connection.sourceHandle, 'ref');
  }
  assert.equal(acceptsImageProcessConnection({ source: 'sketch', target: 'blend', targetHandle: 'overlay' }, nodes, []), true);
  assert.equal(acceptsImageProcessConnection({ source: 'blend', target: 'adjust', targetHandle: 'guide' }, nodes, [{ source: 'adjust', target: 'blend', targetHandle: 'base' }]), false);
});

test('only a mask-mode paint output may enter the qwen mask port', () => {
  const drawing = paint('drawing', { outputMode: 'transparent' });
  const mask = paint('mask', { outputMode: 'mask' });
  const qwen = generator('qwen', 'qwenEdit');
  const h3 = generator('h3', 'qwenEdit', { qwenModel: 'h3_image' });
  const nodes = [drawing, mask, qwen, h3];
  assert.match(planCanvasConnection(conn('drawing', 'qwen', 'mask'), nodes, []).error, /黑白遮罩/);
  assert.equal(planCanvasConnection(conn('mask', 'qwen', 'mask'), nodes, []).connection.targetHandle, 'mask');
  assert.match(planCanvasConnection(conn('mask', 'h3', 'mask'), nodes, []).error, /H3-Image/);
  const native = { id: 'mesh', type: 'native3d', data: { operation: 'image_to_3d', status: 'idle' } };
  assert.equal(planCanvasConnection(conn('mask', 'mesh', 'image'), [...nodes, native], []).connection.targetHandle, 'image');
});

test('a paint signature change invalidates downstream image processing', () => {
  const source = paint('sketch');
  const adjust = process('adjust', 'colorAdjust', { brightness: 0 });
  const nodes = [source, adjust];
  const edges = [{ source: 'sketch', target: 'adjust', targetHandle: 'guide' }];
  const before = imageProcessSnapshot('adjust', nodes, edges);
  assert.equal(before.refs[0].data.assetPath, 'assets/sketch.png');
  assert.ok(before.signature.includes(source.data.paintSignature));
  source.data.paintSignature = paintSignature({ ...source.data, assetPath: 'assets/sketch-v2.png' });
  source.data.assetPath = 'assets/sketch-v2.png';
  const after = imageProcessSnapshot('adjust', nodes, edges);
  assert.notEqual(after.signature, before.signature);
  adjust.data.processedSignature = before.signature;
  adjust.data.processedAssetPath = 'assets/old.png';
  const blend = process('blend', 'imageBlend');
  assert.throws(() => imageProcessSnapshot('blend', [...nodes, blend], [...edges, { source: 'adjust', target: 'blend', targetHandle: 'base' }, { source: 'sketch', target: 'blend', targetHandle: 'overlay' }]), /重新输出/);
});
