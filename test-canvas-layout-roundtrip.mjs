import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { persistentCanvas } from './src/auto-save.js';
import { compactCanvasPositions, nodeLayoutSize, visibleLayoutNodes } from './src/canvas-layout.js';
import { inlineImageView } from './src/image-inline-output.js';

// Public, synthetic 406-node/431-edge fixture. Contains no production IDs,
// media, prompts, paths or serialized user-project data.
const nodes = Array.from({ length: 307 }, (_, i) => ({
  id: `card-${i}`, type: i % 6 ? 'generator' : 'media',
  position: { x: (i % 4) * 900, y: i * 2400 },
  data: i % 6 ? { title: `Process ${i}`, mode: 'qwenEdit', status: 'done', resultUrl: `fixture-result-${i}` }
    : { title: `Reference ${i}`, kind: 'image', url: `fixture-reference-${i}` },
}));
const edges = [];
for (let i = 0; i < nodes.length; i++) {
  if (i % 6) edges.push({ id: `wire-${edges.length}`, source: `card-${i - 1}`, target: `card-${i}`, targetHandle: 'references' });
}
for (let start = 0; start + 5 < 307 && edges.length < 332; start += 6) {
  for (let j = 2; j < 6 && edges.length < 332; j++) edges.push({ id: `wire-${edges.length}`, source: `card-${start}`, target: `card-${start + j}`, targetHandle: 'references' });
}
for (let i = 0; i < 99; i++) {
  const owner = nodes.filter(n => n.type === 'generator')[i];
  const id = `backing-${i}`;
  owner.data.inlineImageOutputId = id;
  nodes.push({ id, type: 'media', position: { x: 9000, y: i * 2400 }, data: { kind: 'image', output: true, inlineImageOwnerId: owner.id, sourceGeneratorId: owner.id, url: owner.data.resultUrl } });
  edges.push({ id: `preview-${i}`, source: owner.id, target: id, targetHandle: 'preview' });
}
assert.equal(nodes.length, 406); assert.equal(edges.length, 431);
const before = persistentCanvas({ nodes, edges });
const positions = compactCanvasPositions(before.nodes, before.edges);
const packed = { ...before, nodes: before.nodes.map(node => ({ ...node, position: positions.get(node.id) })) };
const reloaded = JSON.parse(JSON.stringify(persistentCanvas(packed)));
assert.deepEqual(reloaded, packed, 'saved geometry and all immutable references survive reload');
const content = canvas => ({ nodes: canvas.nodes.map(({ position, ...node }) => node), edges: canvas.edges });
assert.deepEqual(content(reloaded), content(before), 'tidy changes only positions');
assert.deepEqual(compactCanvasPositions(reloaded.nodes, reloaded.edges), positions, 'same dimensions give stable repeat layout');
const visible = visibleLayoutNodes(reloaded.nodes);
assert.equal(visible.length, 307);
for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
  const a = visible[i], b = visible[j], sa = nodeLayoutSize(a), sb = nodeLayoutSize(b);
  assert.ok(a.position.x + sa.width <= b.position.x || b.position.x + sb.width <= a.position.x || a.position.y + sa.height <= b.position.y || b.position.y + sb.height <= a.position.y, 'visible cards do not overlap');
}
const original = structuredClone(reloaded);
const view = inlineImageView(reloaded.nodes, reloaded.edges);
assert.deepEqual(reloaded, original, 'presentation must not mutate saved identities');
assert.equal(view.nodes.filter(n => n.hidden).length, 99);
const signature = createHash('sha256').update(JSON.stringify(content(reloaded))).digest('hex');
console.log(JSON.stringify({ nodes: 406, edges: 431, visible: 307, savedReloadEqual: true, contentSignature: signature }));
