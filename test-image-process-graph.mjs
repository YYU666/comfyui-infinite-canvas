import test from 'node:test';
import assert from 'node:assert/strict';
import { imageProcessSnapshot, acceptsImageProcessConnection } from './src/image-process-graph.js';
import { DEFAULT_PHOTO_SETTINGS } from './src/photo-adjustments.js';
import { validateModelSettings } from './src/canvas-mcp.js';

const fixture = () => ({
  nodes: [
    { id: 'photo', type: 'media', data: { kind: 'image', assetPath: 'assets/photo.png', url: 'blob:first' } },
    { id: 'layer', type: 'media', data: { kind: 'image', assetPath: 'assets/layer.png' } },
    { id: 'adjust', type: 'imageProcess', data: { mode: 'colorAdjust', title: '调色', brightness: 10 } },
    { id: 'blend', type: 'imageProcess', data: { mode: 'imageBlend', title: '混合', blendMode: 'multiply' } },
  ],
  edges: [{ source: 'photo', target: 'adjust', targetHandle: 'guide' }, { source: 'adjust', target: 'blend', targetHandle: 'base' }, { source: 'layer', target: 'blend', targetHandle: 'overlay' }],
});

test('direct chains require a saved output matching current inputs and settings', () => {
  const { nodes, edges } = fixture();
  assert.throws(() => imageProcessSnapshot('blend', nodes, edges), /重新输出/);
  const adjust = nodes.find((node) => node.id === 'adjust');
  adjust.data.processedSignature = imageProcessSnapshot('adjust', nodes, edges).signature;
  adjust.data.processedAssetPath = 'assets/output.png';
  const blend = imageProcessSnapshot('blend', nodes, edges);
  assert.equal(blend.refs.find((ref) => ref.data.slot === 'base').data.assetPath, 'assets/output.png');
  adjust.data.brightness = 20;
  assert.throws(() => imageProcessSnapshot('blend', nodes, edges), /重新输出/);
});

test('blob hydration does not invalidate saved inputs; replacing an asset does', () => {
  const { nodes, edges } = fixture();
  const before = imageProcessSnapshot('adjust', nodes, edges).signature;
  nodes[0].data.url = 'blob:second';
  assert.equal(imageProcessSnapshot('adjust', nodes, edges).signature, before);
  nodes[0].data.assetPath = 'assets/replaced.png';
  assert.notEqual(imageProcessSnapshot('adjust', nodes, edges).signature, before);
});

test('ports reject wrong media, unknown handles, self connections and cycles', () => {
  const { nodes, edges } = fixture();
  assert.equal(acceptsImageProcessConnection({ source: 'photo', target: 'blend', targetHandle: 'mask' }, nodes, edges), true);
  assert.equal(acceptsImageProcessConnection({ source: 'photo', target: 'blend', targetHandle: 'guide' }, nodes, edges), false);
  assert.equal(acceptsImageProcessConnection({ source: 'blend', target: 'adjust', targetHandle: 'guide' }, nodes, edges), false);
  assert.equal(acceptsImageProcessConnection({ source: 'adjust', target: 'adjust', targetHandle: 'guide' }, nodes, edges), false);
  nodes[0].data.kind = 'video';
  assert.equal(acceptsImageProcessConnection({ source: 'photo', target: 'adjust', targetHandle: 'guide' }, nodes, edges), false);
});

test('missing required inputs and cyclic persisted graphs fail clearly', () => {
  const { nodes, edges } = fixture();
  assert.throws(() => imageProcessSnapshot('blend', nodes, edges.filter((edge) => edge.source !== 'adjust')), /底图/);
  assert.throws(() => imageProcessSnapshot('adjust', nodes, [{ source: 'adjust', target: 'adjust', targetHandle: 'guide' }]), /循环/);
});


test('active adjustment settings affect signatures while panel selection and inactive families do not', () => {
  const { nodes, edges } = fixture();
  const adjust = nodes.find((node) => node.id === 'adjust');
  adjust.data.adjustmentType = 'hsl';
  const before = imageProcessSnapshot('adjust', nodes, edges).signature;
  adjust.data.hslChannel = 'red'; adjust.data.brightness = 99;
  adjust.data.levels = { rgb: { gamma: 2 } };
  assert.equal(imageProcessSnapshot('adjust', nodes, edges).signature, before);
  adjust.data.hsl = { red: { hue: 30 } };
  assert.notEqual(imageProcessSnapshot('adjust', nodes, edges).signature, before);
  adjust.data.adjustmentType = 'levels';
  const levels = imageProcessSnapshot('adjust', nodes, edges).signature;
  adjust.data.levelsChannel = 'blue';
  assert.equal(imageProcessSnapshot('adjust', nodes, edges).signature, levels);
  adjust.data.levels.blue = { inputBlack: 20 };
  assert.notEqual(imageProcessSnapshot('adjust', nodes, edges).signature, levels);
});

test('default blend masks preserve literal V1 signatures and new mask settings invalidate output', () => {
  const { nodes, edges } = fixture();
  const direct = edges.filter((edge) => edge.target !== 'blend');
  direct.push({ source: 'photo', target: 'blend', targetHandle: 'base' }, { source: 'layer', target: 'blend', targetHandle: 'overlay' });
  const blend = nodes.find((node) => node.id === 'blend');
  const old = JSON.stringify(['imageBlend', { mode: 'multiply', opacity: 100, fit: 'cover' }, [['photo', 'base', 'assets/photo.png'], ['layer', 'overlay', 'assets/layer.png']]]);
  assert.equal(imageProcessSnapshot('blend', nodes, direct).signature, old);
  blend.data.maskChannel = 'red';
  assert.notEqual(imageProcessSnapshot('blend', nodes, direct).signature, old);
  blend.data.maskChannel = 'luminance'; blend.data.maskInvert = true;
  assert.notEqual(imageProcessSnapshot('blend', nodes, direct).signature, old);
});

test('bridge accepts photo controls and rejects malformed channels and invalid levels', () => {
  assert.doesNotThrow(() => validateModelSettings({ adjustmentType: 'hsl', hsl: { red: { hue: 120 } }, hslChannel: 'red' }));
  assert.doesNotThrow(() => validateModelSettings({ adjustmentType: 'levels', levels: { rgb: { inputBlack: 100, inputWhite: 200 } }, maskChannel: 'alpha', maskInvert: true }));
  for (const settings of [{ adjustmentType: 'unknown' }, { maskChannel: 'pink' }, { maskInvert: 1 }, { hsl: null }, { hsl: { purple: {} } }, { hsl: { red: { hue: 181 } } }, { levels: { rgb: { inputBlack: 200, inputWhite: 100 } } }, { levels: { blue: { outputBlack: 220, outputWhite: 20 } } }, { exposure: { exposure: 99 } }, { curves: { rgb: [{ x: 0, y: 0 }, { x: 0, y: 255 }] } }, { photoFilter: { color: 'invalid' } }, { colorBalanceRange: 'pink' }, { vibrance: { extra: true } }]) assert.throws(() => validateModelSettings(settings));
  assert.doesNotThrow(() => validateModelSettings({ adjustmentType: 'curves', curves: { rgb: [{ x: 0, y: 0 }, { x: 128, y: 160 }, { x: 255, y: 255 }] } }));
});


test('all new photo families sign active settings and exclude other families and UI selection', () => {
  for (const mode of Object.keys(DEFAULT_PHOTO_SETTINGS)) {
    const { nodes, edges } = fixture(); const node = nodes.find((n) => n.id === 'adjust');
    node.data.adjustmentType = mode;
    const before = imageProcessSnapshot('adjust', nodes, edges);
    assert.equal(before.settings.adjustmentType, mode);
    node.data.curvesChannel = 'red'; node.data.selectiveColorRange = 'blacks'; node.data.channelMixerChannel = 'blue'; node.data.colorBalanceRange = 'highlights'; node.data.brightness = 80;
    assert.equal(imageProcessSnapshot('adjust', nodes, edges).signature, before.signature, mode);
  }
  const { nodes, edges } = fixture(); const node = nodes.find((n) => n.id === 'adjust'); node.data.adjustmentType = 'curves';
  const before = imageProcessSnapshot('adjust', nodes, edges).signature;
  node.data.curves = { rgb: [{ x: 0, y: 0 }, { x: 128, y: 190 }, { x: 255, y: 255 }] };
  assert.notEqual(imageProcessSnapshot('adjust', nodes, edges).signature, before);
});

test('RGBA ports require an input, retain fallback channels, and sign raw TGA identity', () => {
  const { nodes } = fixture();
  nodes.push({ id: 'pack', type: 'imageProcess', data: { mode: 'channelPack' } });
  assert.throws(() => imageProcessSnapshot('pack', nodes, []), /至少连接/);
  const edges = [{ source: 'photo', target: 'pack', targetHandle: 'green' }];
  assert.equal(acceptsImageProcessConnection({ source: 'photo', target: 'pack', targetHandle: 'alpha' }, nodes, edges), true);
  assert.equal(acceptsImageProcessConnection({ source: 'photo', target: 'pack', targetHandle: 'guide' }, nodes, edges), false);
  const pack = nodes.at(-1); const initial = imageProcessSnapshot('pack', nodes, edges);
  assert.equal(initial.settings.channels.alpha.value, 255);
  pack.data.packPreview = 'alpha';
  assert.equal(imageProcessSnapshot('pack', nodes, edges).signature, initial.signature);
  nodes[0].data.tgaAssetPath = 'assets/raw-one.tga';
  const raw = imageProcessSnapshot('pack', nodes, edges);
  assert.equal(raw.refs[0].data.rawAssetPath, 'assets/raw-one.tga');
  nodes[0].data.tgaAssetPath = 'assets/raw-two.tga';
  assert.notEqual(imageProcessSnapshot('pack', nodes, edges).signature, raw.signature);
  assert.doesNotThrow(() => validateModelSettings({ packChannels: { red: { source: 'alpha', invert: true, value: 255 } }, packPreview: 'rgb' }));
  for (const value of [{ packChannels: null }, { packChannels: { purple: {} } }, { packChannels: { red: { source: 'pink' } } }, { packChannels: { red: { value: 300 } } }, { packChannels: { red: { invert: 1 } } }, { packPreview: 'pink' }]) assert.throws(() => validateModelSettings(value));
});

test('shared RGBA ancestry stays bounded and later reads detect edited upstream inputs', () => {
  const nodes = [{ id: 'map', type: 'media', data: { kind: 'image', assetPath: 'assets/map.png' } }];
  const edges = [];
  let modeReads = 0;
  for (let index = 0; index < 9; index += 1) {
    const id = `pack-${index}`;
    const node = { id, type: 'imageProcess', data: { get mode() { modeReads += 1; return 'channelPack'; } } };
    nodes.push(node);
    for (const channel of ['red', 'green', 'blue', 'alpha']) edges.push({ source: index ? `pack-${index - 1}` : 'map', target: id, targetHandle: channel });
    node.data.processedSignature = imageProcessSnapshot(id, nodes, edges).signature;
    node.data.processedAssetPath = `assets/${id}.png`;
  }
  modeReads = 0;
  const snapshot = imageProcessSnapshot('pack-8', nodes, edges);
  assert.equal(snapshot.refs.length, 4);
  assert.ok(modeReads < 250, `shared ancestors were repeatedly expanded (${modeReads} reads)`);
  nodes[0].data.assetPath = 'assets/replaced.png';
  assert.throws(() => imageProcessSnapshot('pack-8', nodes, edges), /重新输出/);
  edges.push({ source: 'pack-8', target: 'pack-0', targetHandle: 'red' });
  assert.throws(() => imageProcessSnapshot('pack-8', nodes, edges), /循环/);
});
