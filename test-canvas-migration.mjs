import assert from 'node:assert/strict';
import { migrateCanvas } from './src/canvas-migration.js';
import { persistentCanvas } from './src/auto-save.js';

const model = (id, operation) => ({
  id, type: 'native3d', position: { x: 100, y: 200 },
  data: { title: id, operation, assetPath: `assets/${'a'.repeat(64)}.glb`,
    adapterId: 'native', nativeParameters: { ratio: 0.5 },
    artifacts: [{ assetPath: `assets/${'b'.repeat(64)}.glb`, stage: 'lod_1' }],
    result: { topology: { triangles: 123 } }, status: 'done' },
});
const nodes = Array.from({ length: 27 }, (_, i) => model(`model-${i}`, i ? 'simplify' : 'analyze'));
nodes.push({ id: 'future', type: 'future-model', position: { x: 0, y: 0 }, data: { opaque: { version: 2 } } });
nodes.push({ id: 'note', type: 'note', position: { x: 0, y: 0 }, data: { title: 'Keep', text: 'Keep' } });
const edges = nodes.slice(1, 28).map((node, i) => ({
  id: `edge-${i}`, source: nodes[i].id, target: node.id,
  sourceHandle: 'model', targetHandle: 'mesh-input', type: 'default',
  data: { stage: 'lod_1' }, style: { strokeDasharray: '4 4' },
}));
const saved = { nodes, edges, viewport: { x: 2, y: 3, zoom: 0.7 } };
const reopen = (canvas) => migrateCanvas(JSON.parse(JSON.stringify(persistentCanvas(canvas))));
assert.deepEqual(reopen(saved), saved, 'reopen must retain native/future metadata and edge handles');
assert.deepEqual(reopen(reopen(saved)), saved, 'save/reopen remains stable');

const legacy = reopen({ nodes: [
  { id: 'image', type: 'image', position: { x: 0, y: 0 }, data: {} },
  { id: 'h3', type: 'h3', position: { x: 0, y: 0 }, data: { mode: 'reference' } },
], edges: [{ id: 'legacy', source: 'image', target: 'h3', sourceHandle: 'image', targetHandle: 'first' }] });
assert.equal(legacy.nodes[0].type, 'media');
assert.equal(legacy.nodes[1].type, 'generator');
assert.equal(legacy.edges[0].sourceHandle, 'ref');
assert.equal(legacy.edges[0].targetHandle, 'references');
console.log('Canvas migration: 27 native3d nodes, future nodes, metadata, edges and legacy migration preserved.');

const activeStates = ['uploading', 'queued', 'running', 'finishing', 'optimizing'];
const interrupted = ['generator', 'h3', 'media', 'image', 'video', 'prompt', 'note'].flatMap((type) => activeStates.map((status) => ({
  id: `${type}-${status}`, type, position: { x: 0, y: 0 },
  data: { status, progress: 42, stage: 'Working', prompt: 'Keep prompt', url: '/keep.png', runs: [{ status: 'done' }] },
})));
const original = structuredClone(interrupted);
const recovered = migrateCanvas({ nodes: interrupted, edges: [] });
for (const node of recovered.nodes) {
  assert.equal(node.data.status, 'idle', `${node.id} cannot resume browser-only work after reopening`);
  assert.equal(node.data.progress, 0);
  assert.equal(node.data.stage, '');
  assert.equal(node.data.prompt, 'Keep prompt');
  assert.equal(node.data.url, '/keep.png');
  assert.deepEqual(node.data.runs, [{ status: 'done' }]);
}
assert.deepEqual(interrupted, original, 'migration must not mutate the persisted document');
const owned = ['promptId', 'queueJobId'].flatMap((key) => activeStates.map((status) => ({
  id: `${key}-${status}`, type: 'generator', position: { x: 0, y: 0 },
  data: { [key]: 'backend-task', status, progress: 42, stage: 'Working' },
})));
for (const node of migrateCanvas({ nodes: owned, edges: [] }).nodes) {
  const before = owned.find((item) => item.id === node.id);
  assert.equal(node.data.status, before.data.status, 'identified backend tasks remain locked for reconciliation');
  assert.equal(node.data.progress, 42);
  assert.equal(node.data.stage, 'Working');
}
const extension = { id: 'extension-task', type: 'future-model', data: { status: 'running' } };
assert.deepEqual(migrateCanvas({ nodes: [extension], edges: [] }).nodes[0], extension);
console.log('Canvas migration: orphan browser task states recover; backend identities and extension tasks remain intact.');
