import assert from 'node:assert/strict';
import { findFreePosition } from './src/canvas-layout.js';

const media = (x, y) => ({ type: 'media', position: { x, y } });
assert.deepEqual(findFreePosition([], { x: 101, y: 203 }), { x: 110, y: 198 });
assert.deepEqual(findFreePosition([media(110, 198)], { x: 101, y: 203 }), { x: 110, y: 638 });
assert.deepEqual(findFreePosition([media(110, 638)], { x: 101, y: 203 }), { x: 110, y: 198 });
assert.deepEqual(findFreePosition([media(110, 198)], { x: 800, y: 203 }), { x: 792, y: 198 });
const crowded = Array.from({ length: 12 }, (_, index) => media(110, 198 + index * 440));
assert.deepEqual(findFreePosition(crowded, { x: 110, y: 198 }), { x: 660, y: 198 });
const generator = { type: 'generator', position: { x: 500, y: 200 } };
const result = findFreePosition([generator], { x: 510, y: 210 });
assert.notDeepEqual(result, { x: 506, y: 198 });
console.log('新建节点与结果节点自动避让测试通过');
