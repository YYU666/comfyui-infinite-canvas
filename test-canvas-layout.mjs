import assert from 'node:assert/strict';
import { CANVAS_SPACING, compactCanvasPositions, findFreePosition, findReferencePosition, planReferencePositions, nodeLayoutSize, visibleLayoutNodes } from './src/canvas-layout.js';

const media = (x, y) => ({ type: 'media', position: { x, y } });
assert.deepEqual(findFreePosition([], { x: 101, y: 203 }), { x: 110, y: 198 });
assert.deepEqual(findFreePosition([media(110, 198)], { x: 101, y: 203 }), { x: 594, y: 198 }, 'fill the next column before moving down');
assert.deepEqual(findFreePosition([media(110, 900)], { x: 101, y: 203 }), { x: 110, y: 198 });
assert.deepEqual(findFreePosition([media(110, 198)], { x: 800, y: 203 }), { x: 792, y: 198 });
const crowded = Array.from({ length: 12 }, (_, index) => media(110, 198 + index * 440));
assert.deepEqual(findFreePosition(crowded, { x: 110, y: 198 }), { x: 594, y: 198 });
const generator = { type: 'generator', position: { x: 500, y: 200 } };
const result = findFreePosition([generator], { x: 510, y: 210 });
assert.notDeepEqual(result, { x: 506, y: 198 });
const sized = (id, x, y, width, height) => ({ id, type: 'generator', position: { x, y }, measured: { width, height }, data: {} });
const separate = (a, b, sizes = nodeLayoutSize) => {
  const sa = sizes(a), sb = sizes(b);
  return a.position.x + sa.width + CANVAS_SPACING.horizontal <= b.position.x
    || b.position.x + sb.width + CANVAS_SPACING.horizontal <= a.position.x
    || a.position.y + sa.height + CANVAS_SPACING.vertical <= b.position.y
    || b.position.y + sb.height + CANVAS_SPACING.vertical <= a.position.y;
};
const assertNoOverlap = nodes => {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.ok(separate(nodes[i], nodes[j]), `${nodes[i].id} overlaps ${nodes[j].id}`);
};

// A whole row of different heights leaves just one small gap after its tallest card.
const mixed = [sized('a', 0, 0, 440, 760), sized('b', 500, 0, 440, 1200), sized('c', 0, 9000, 540, 900)];
const snapshot = structuredClone(mixed);
const layout = compactCanvasPositions(mixed, [], { rowWidth: 1000 });
assert.equal(layout.get('c').y, 1254);
assert.equal(layout.get('c').x, 0);
assert.deepEqual(mixed, snapshot, 'layout planning never edits source data');
assertNoOverlap(mixed.map(node => ({ ...node, position: layout.get(node.id) })));

// Hundreds of cards stay in bounded rows instead of 12-node vertical columns.
const many = Array.from({ length: 400 }, (_, i) => sized(`g${i}`, 0, i * 6000, 440, 740));
const packed = compactCanvasPositions(many);
const placed = many.map(node => ({ ...node, position: packed.get(node.id) }));
assertNoOverlap(placed);
assert.ok(Math.max(...placed.map(node => node.position.x + nodeLayoutSize(node).width)) <= 3200);
assert.ok(Math.max(...placed.map(node => node.position.y)) < 55000);
assert.deepEqual(compactCanvasPositions(placed), packed, 'repeated tidy is stable');

const owner = { ...sized('owner', 0, 0, 440, 740), data: { status: 'done', resultUrl: 'local-image' } };
const backing = { id: 'backing', type: 'media', position: { x: 10000, y: 10000 }, data: { kind: 'image', output: true, inlineImageOwnerId: 'owner' } };
assert.deepEqual(findFreePosition([owner, backing], { x: 10000, y: 10000 }), { x: 10010, y: 10010 }, 'hidden backing does not reserve a ghost position');
assert.deepEqual(visibleLayoutNodes([backing]), [backing], 'orphaned backing remains visible');
const hiddenLayout = compactCanvasPositions([owner, backing]);
assert.deepEqual(hiddenLayout.get('backing'), hiddenLayout.get('owner'));

const resultNodes = [sized('source', 0, 0, 440, 740), sized('unrelated', 0, 10, 440, 740), { ...sized('result', 0, 5000, 440, 740), data: { output: true } }];
const resultEdges = [{ source: 'source', target: 'result', targetHandle: 'preview' }];
const adjacent = compactCanvasPositions(resultNodes, resultEdges);
assert.ok(adjacent.get('source').x < adjacent.get('result').x && adjacent.get('result').x < adjacent.get('unrelated').x, 'processing result stays beside source');
assert.equal(compactCanvasPositions([], []).size, 0);
assert.equal(compactCanvasPositions(resultNodes, [...resultEdges, { source: 'result', target: 'source', targetHandle: 'preview' }]).size, 3, 'cycles cannot hang tidy');

const dense = Array.from({ length: 300 }, (_, i) => ({ ...media((i % 10) * 352, Math.floor(i / 10) * 308), id: `dense-${i}` }));
const free = findFreePosition(dense, { x: 0, y: 0 });
assert.ok(dense.every(node => separate({ ...media(free.x, free.y), id: 'new' }, node)), 'no collision-blind fallback after 240 occupied slots');
console.log('Compact canvas layout passed: bounded rows, real sizes, row gaps, hidden outputs, stable repeat, dense placement.');

// References imported after their consumers still appear before them.
const flowNodes = [sized('edit', 0, 0, 440, 550), sized('mother', 0, 5000, 440, 550), sized('photo', 0, 10000, 440, 550), sized('final', 0, 15000, 440, 550)];
const flowEdges = [{source:'mother',target:'edit'}, {source:'photo',target:'edit'}, {source:'edit',target:'final'}];
const flowLayout = compactCanvasPositions(flowNodes, flowEdges);
assert.ok(flowLayout.get('mother').x < flowLayout.get('edit').x);
assert.ok(flowLayout.get('photo').x < flowLayout.get('edit').x);
assert.ok(flowLayout.get('edit').x < flowLayout.get('final').x);
assert.deepEqual(compactCanvasPositions(flowNodes.map(n=>({...n,position:flowLayout.get(n.id)})), flowEdges), flowLayout);
const viaBacking = compactCanvasPositions([owner,backing,sized('consumer',0,0,440,550)], [{source:'backing',target:'consumer'}]);
assert.ok(viaBacking.get('owner').x < viaBacking.get('consumer').x, 'hidden backing edges resolve to displayed mother');
assert.deepEqual(nodeLayoutSize({type:'media',data:{kind:'image'}}),nodeLayoutSize({type:'generator',data:{status:'done',resultUrl:'image'}}));

const target = sized('target',0,0,440,550);
const input1 = findReferencePosition([target],target);
assert.ok(input1.x+440+CANVAS_SPACING.horizontal<=target.position.x);
const inputNode = {id:'input',type:'media',position:input1};
const input2 = findReferencePosition([target,inputNode],target);
assert.equal(input2.x,input1.x);
assert.ok(input2.y>input1.y);
assert.ok(separate(inputNode,{...inputNode,id:'input2',position:input2}));

const batchPositions = planReferencePositions([target,inputNode],target,10);
assert.equal(batchPositions.length,10);
assert.equal(new Set(batchPositions.map(p=>`${p.x},${p.y}`)).size,10);
assertNoOverlap([target,inputNode,...batchPositions.map((position,i)=>({id:`batch-${i}`,type:'media',position}))]);
assert.ok(batchPositions.every(p=>p.x+440+CANVAS_SPACING.horizontal<=target.position.x));
