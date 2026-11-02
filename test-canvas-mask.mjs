import assert from 'node:assert/strict';
import { canvasMaskGuide, validateCanvasMask } from './src/canvas-mask.js';
import { qwenCanvasReferences } from './src/qwen-references.js';
import { copyCanvasSelection, pasteCanvasSelection } from './src/canvas-clipboard.js';
const source = { id: 'source', type: 'media', selected: true, position: { x: 0, y: 0 }, data: { kind: 'image', url: '/a.png', assetPath: 'assets/a.png' } };
const mask = { id: 'mask', type: 'media', selected: true, position: { x: 400, y: 0 }, data: { kind: 'image', mediaRole: 'mask', url: '/mask.png', maskSourceId: 'source', maskSourceKey: 'assets/a.png' } };
const node = { id: 'qwen', type: 'generator', selected: true, position: { x: 800, y: 0 }, data: { mode: 'qwenEdit' } };
const nodes = [source, mask, node];
const edges = [
 { id: 'a', source: 'source', target: 'qwen', targetHandle: 'references' },
 { id: 'b', source: 'source', target: 'mask', targetHandle: 'guide' },
 { id: 'c', source: 'mask', target: 'qwen', targetHandle: 'mask' },
];
assert.equal(canvasMaskGuide('mask', nodes, edges), source);
assert.equal(validateCanvasMask(node, nodes, edges).data.slot, 'mask');
assert.deepEqual(qwenCanvasReferences(node, nodes, edges).map((item) => item.id), ['source']);
assert.equal(validateCanvasMask(node, nodes, edges.slice(0, 2)), null);
assert.throws(() => validateCanvasMask(node, nodes, [...edges, { ...edges[2], id: 'duplicate' }]), /一个/);
assert.throws(() => validateCanvasMask(node, nodes.map((n) => n.id === 'source' ? { ...n, data: { ...n.data, assetPath: 'assets/replaced.png' } } : n), edges), /底图已变化/);
assert.throws(() => validateCanvasMask(node, nodes, edges.filter((e) => e.id !== 'b')), /底图必须/);
assert.throws(() => validateCanvasMask(node, nodes.map((n) => n.id === 'mask' ? { ...n, data: { ...n.data, url: '' } } : n), edges), /绘制或导入/);
let next = 0;
const pasted = pasteCanvasSelection(copyCanvasSelection(nodes, edges), nodes, () => `copy${next++}`);
const copiedGenerator = pasted.nodes.find((n) => n.type === 'generator');
assert.equal(validateCanvasMask(copiedGenerator, pasted.nodes, pasted.edges).data.maskSourceId, pasted.idMap.get('source'));
console.log('CANVAS_MASK_OK base identity, stale/missing/duplicate rejection, numbering, clipboard remap');
