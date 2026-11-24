import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const source = process.argv[2] ? path.resolve(process.argv[2], 'src') : path.resolve('src');
const load = (name) => import(pathToFileURL(path.join(source, name)));
const { createProductionZone, editProductionZone, moveProductionZone, productionZoneFrames } = await load('canvas-production-zones.js');
const { CanvasHistory, restoreHistoryNodes } = await load('canvas-history.js');
const { persistentCanvas } = await load('auto-save.js');
const { migrateCanvas } = await load('canvas-migration.js');
const { copyCanvasSelection } = await load('canvas-clipboard.js');

const base = migrateCanvas({
  nodes: [
    { id: 'input', type: 'image', position: { x: 0, y: 0 }, data: { kind: 'image' } },
    { id: 'render', type: 'h3', position: { x: 600, y: 20 }, data: { mode: 'qwenEdit', prompt: '灯笼', qwenModel: 'h3_image' } },
    { id: 'result', type: 'media', position: { x: 600, y: 20 }, data: { kind: 'image', output: true, inlineImageOwnerId: 'render' } },
    { id: 'note', type: 'note', position: { x: 1200, y: 0 }, data: { title: '独立节点' } },
  ],
  edges: [{ id: 'reference', source: 'input', target: 'render', sourceHandle: 'image', targetHandle: 'guide' }],
}, 'test');
assert.deepEqual(productionZoneFrames(base.nodes), []);
assert.equal(createProductionZone(base.nodes, 'zone-one'), base.nodes);
const selected = base.nodes.map((node) => ({ ...node, selected: node.id !== 'note' }));
const history = new CanvasHistory(selected, base.edges);
const grouped = createProductionZone(selected, 'zone-one');
assert.deepEqual(grouped.slice(0, 2).map((node) => node.selected), [false, false]);
assert.equal(grouped[2].data.productionZone, undefined);
assert.equal(grouped[3], selected[3]);
assert.equal(productionZoneFrames(grouped).length, 1);
assert.equal(productionZoneFrames(grouped)[0].x, -24);
const renamed = editProductionZone(grouped, 'zone-one', '  灯笼出图  ');
history.observe(renamed, base.edges);
const moved = moveProductionZone(renamed, 'zone-one', { x: -61, y: 28 });
history.observe(moved, base.edges);
assert.deepEqual(moved.map((node) => node.position), [{ x: -61, y: 28 }, { x: 539, y: 48 }, { x: 539, y: 48 }, { x: 1200, y: 0 }]);
assert.deepEqual(restoreHistoryNodes(history.undo().nodes, moved).map((node) => node.position), renamed.map((node) => node.position));
assert.deepEqual(history.redo().edges, base.edges);

const snapshot = persistentCanvas({ nodes: moved, edges: base.edges, viewport: { x: 0, y: 0, zoom: 1 } });
const reopened = migrateCanvas(JSON.parse(JSON.stringify(snapshot)), 'test');
assert.deepEqual(reopened.edges, base.edges);
assert.deepEqual(reopened.nodes.map((node) => node.type), ['media', 'generator', 'media', 'note']);
assert.equal(reopened.nodes[1].data.prompt, '灯笼');
assert.equal(reopened.nodes[1].data.qwenModel, 'h3_image');
assert.deepEqual(productionZoneFrames(reopened.nodes), productionZoneFrames(moved));
const remaining = reopened.nodes.filter((node) => node.id !== 'input');
assert.equal(productionZoneFrames(remaining)[0].title, '灯笼出图');
assert.deepEqual(productionZoneFrames(editProductionZone(remaining, 'zone-one', null)), []);
const clip = copyCanvasSelection(reopened.nodes.map((node) => ({ ...node, selected: true })), reopened.edges);
assert.ok(clip.nodes.every((node) => !node.data.productionZone));
console.log('Production zones passed: legacy migration, membership, rename, movement, undo/redo, save/reopen, removal, clipboard, and unchanged edges.');
