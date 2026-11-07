import assert from 'node:assert/strict';
import {moveSpecifiedNodes} from './src/canvas-move.js';
const nodes=[{id:'a',position:{x:0,y:0},data:{keep:true}},{id:'b',position:{x:2,y:3},data:{value:9}}];
const moved=moveSpecifiedNodes(nodes,[{nodeId:'a',x:5,y:-4}]);assert.deepEqual(moved[0].position,{x:5,y:-4});assert.equal(moved[0].data,nodes[0].data);assert.equal(moved[1],nodes[1]);assert.deepEqual(nodes[0].position,{x:0,y:0});
for(const bad of [[],[{nodeId:'missing',x:0,y:0}],[{nodeId:'a',x:Infinity,y:0}],[{nodeId:'a',x:1,y:1},{nodeId:'a',x:2,y:2}],[{nodeId:'a',x:1,y:1,script:true}]])assert.throws(()=>moveSpecifiedNodes(nodes,bad));
console.log('CANVAS_MOVE_OK validated batch, immutable unrelated nodes, duplicate/missing/nonfinite rejected');
