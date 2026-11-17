import assert from 'node:assert/strict';
import { compactInlineImages, imageCompactArgs, inlineImageView } from './src/image-inline-output.js';
import { registerCanvasMcp } from './src/canvas-mcp.js';
import { CanvasHistory } from './src/canvas-history.js';
import { imageInlineFixture } from './test-fixtures/image-inline-fixture.mjs';

const { nodes, edges } = imageInlineFixture();
const original = structuredClone({ nodes, edges });
const result = compactInlineImages(nodes, edges, ['g1', 'multi', 'missing', 'g1']);
assert.deepEqual(result.compacted, [{ nodeId: 'g1', outputId: 'current', backingIds: ['current', 'historical'] }]);
assert.deepEqual(result.skipped.map(item => item.id), ['multi', 'missing']);
assert.equal(result.edges, edges, 'persistent edges retain identity and contents');
assert.deepEqual({ nodes, edges }, original, 'planning never mutates inputs');
for (const node of result.nodes) {
  const { inlineImageOwnerId, inlineImageOutputId, ...data } = node.data;
  assert.deepEqual(data, original.nodes.find(item => item.id === node.id).data, 'all immutable media and execution history are preserved');
}
const view = inlineImageView(result.nodes, result.edges);
assert.deepEqual(view.nodes.filter(node => node.hidden).map(node => node.id), ['current', 'historical']);
assert.equal(view.edges.find(edge => edge.id === 'historical-reference').source, 'g1');
assert.equal(view.edges.find(edge => edge.id === 'historical-reference').data.inlineImageSourceId, 'historical');
assert.equal(result.edges.find(edge => edge.id === 'historical-reference').source, 'historical');
const history = new CanvasHistory(nodes, edges);
history.observe(result.nodes, result.edges);
assert.deepEqual(history.undo(), { nodes, edges }, 'presentation changes participate in undo');

for (const patch of [{ status: 'idle' }, { status: 'cancelled' }, { status: 'error' }, { status: 'optimizing' }, { error: 'failed' }, { promptId: 'contradictory' }]) {
  const changed = structuredClone(nodes); Object.assign(changed[0].data, patch);
  assert.equal(compactInlineImages(changed, edges, ['g1']).compacted.length, 0);
}
for (const patch of [{ sourceGeneratorId: 'other' }, { inlineImageOwnerId: 'other' }, { sourcePromptId: null, sourceQueueJobId: null }]) {
  const changed = structuredClone(nodes); Object.assign(changed.find(node => node.id === 'current').data, patch);
  assert.equal(compactInlineImages(changed, edges, ['g1']).compacted.length, 0, 'ambiguous or unowned output stays independent');
}
assert.equal(compactInlineImages(nodes, [...edges, { source: 'other', target: 'current', targetHandle: 'preview' }], ['g1']).compacted.length, 0);
for (const args of [{}, { nodeIds: [] }, { nodeIds: ['a/b'] }, { nodeIds: [1] }, { nodeIds: ['x'], dryRun: 'false' }, { nodeIds: ['x'], extra: true }, { nodeIds: Array(101).fill('x') }]) assert.throws(() => imageCompactArgs(args));
assert.deepEqual(imageCompactArgs({ nodeIds: ['g1'] }), { nodeIds: ['g1'], dryRun: true });

let saves = 0, calls = 0, failSave = false;
const latest = { current: { nodesRef: { current: nodes }, edgesRef: { current: edges }, readOnly: false, actions: {
  imageCompact: args => { calls++; return args; },
  persistProject: async () => { saves++; if (failSave) throw new Error('revision conflict'); },
} } };
const tools = [];
const stop = registerCanvasMcp(latest, { context: { registerTool(tool) { tools.push(tool); } }, startPage: () => () => {} });
try {
  const tool = tools.find(item => item.name === 'canvas_image_compact');
  assert.ok(tool, 'tool is actually registered');
  assert.equal(JSON.parse(await tool.execute({ nodeIds: ['g1'] })).dryRun, true);
  assert.equal(saves, 0, 'default preview never saves');
  assert.equal(JSON.parse(await tool.execute({ nodeIds: ['g1'], dryRun: false })).ok, true);
  assert.equal(saves, 1, 'explicit mutation saves exactly once');
  failSave = true;
  const conflict = JSON.parse(await tool.execute({ nodeIds: ['g1'], dryRun: false }));
  assert.equal(conflict.ok, false); assert.equal(conflict.localChangesRetained, true);
  assert.match(conflict.error, /revision conflict/);
  latest.current.readOnly = true;
  const before = calls;
  assert.equal(JSON.parse(await tool.execute({ nodeIds: ['g1'], dryRun: false })).ok, false);
  assert.equal(calls, before, 'read-only mutation never reaches action');
  latest.current.readOnly = false;
  assert.equal(JSON.parse(await tool.execute({ nodeIds: ['g1'], dryRun: 0 })).ok, false);
  assert.equal(JSON.parse(await tool.execute(null)).ok, false);
  assert.equal(calls, before, 'invalid native tool args never reach action');
  assert.equal(saves, 2);
} finally { stop(); }
console.log('IMAGE_INLINE_OUTPUT_OK immutable=true history=true partialMetadataMultiOutput=true dryRunNoSave=true conflictRetained=true');
