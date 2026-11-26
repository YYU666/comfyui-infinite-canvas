import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getElementsToRemove } from '@xyflow/system';
import { inlineImageView } from './src/image-inline-output.js';

// Exercise the actual component callback with the installed ReactFlow deletion
// algorithm, without mounting the workbench or touching a project/service.
const source = readFileSync(new URL('./src/CanvasWorkbench.jsx', import.meta.url), 'utf8');
const callback = source.match(/const handleBeforeDelete = useCallback\(([\s\S]*?), \[project\.readOnly\]\);/)[1];
assert.match(source, /onBeforeDelete=\{handleBeforeDelete\}/);
const nodes = [
  { id: 'owner', type: 'generator', data: { inlineImageOutputId: 'media' } },
  { id: 'media', type: 'media', data: { kind: 'image', output: true, inlineImageOwnerId: 'owner' } },
  { id: 'target', type: 'generator', data: {} },
];
const edges = [
  { id: 'preview', source: 'owner', target: 'media' },
  { id: 'frozen', source: 'media', target: 'target' },
];
const beforeDelete = (readOnly = false) => new Function('project', 'switchingRef', 'edgesRef', `return (${callback});`)(
  { readOnly }, { current: false }, { current: edges });
async function deletion(nodeIds, edgeSelected = false, readOnly = false) {
  const view = inlineImageView(nodes, edges.map(edge => ({ ...edge, selected: edge.id === 'frozen' && edgeSelected })));
  return getElementsToRemove({ nodes: view.nodes, edges: view.edges,
    nodesToRemove: nodeIds.map(id => ({ id })), edgesToRemove: edgeSelected ? [{ id: 'frozen' }] : [],
    onBeforeDelete: beforeDelete(readOnly) });
}
const ownerOnly = await deletion(['owner']);
assert.deepEqual(ownerOnly.nodes.map(node => node.id), ['owner']);
assert.deepEqual(ownerOnly.edges.map(edge => edge.id), ['preview']);
const remainingNodes = nodes.filter(node => !ownerOnly.nodes.some(removed => removed.id === node.id));
const remainingEdges = edges.filter(edge => !ownerOnly.edges.some(removed => removed.id === edge.id));
assert.deepEqual(remainingEdges, [edges[1]], 'canonical historical downstream reference survives');
assert.equal(inlineImageView(remainingNodes, remainingEdges).nodes.find(node => node.id === 'media').hidden, undefined);
assert.deepEqual((await deletion([], true)).edges.map(edge => edge.id), ['frozen'], 'explicit edge deletion works');
assert.deepEqual((await deletion(['owner'], true)).edges.map(edge => edge.id), ['preview', 'frozen'], 'explicit edge selection wins');
assert.ok((await deletion(['target'])).edges.some(edge => edge.id === 'frozen'), 'real target deletion removes edge');
assert.ok((await deletion(['owner', 'target'])).edges.some(edge => edge.id === 'frozen'));
const revealed = inlineImageView(remainingNodes, remainingEdges);
const deleteRevealed = await getElementsToRemove({ ...revealed, nodesToRemove: [{ id: 'media' }], onBeforeDelete: beforeDelete() });
assert.ok(deleteRevealed.edges.some(edge => edge.id === 'frozen'), 'revealed real source deletion removes edge');
assert.deepEqual(await deletion(['owner'], false, true), { nodes: [], edges: [] });
console.log('INLINE_IMAGE_KEYBOARD_DELETE_OK ownerPreservesReferences=true explicitEdgeDelete=true realEndpoints=true');
