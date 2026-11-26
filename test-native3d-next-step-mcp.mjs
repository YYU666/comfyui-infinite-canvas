import assert from 'node:assert/strict';
import {registerCanvasMcp} from './src/canvas-mcp.js';
let calls=[];const map=new Map();const latest={current:{readOnly:false,actions:{native3dNextStep:async(...args)=>{calls.push(args);return {nodeId:'draft',generated:false,reused:false};},persistProject:async()=>{}}}};
const stop=registerCanvasMcp(latest,{context:{registerTool:t=>map.set(t.name,t)},startPage:()=>()=>{}});
const t=map.get('canvas_native3d_next_step');assert.deepEqual(t.inputSchema.properties.action.enum,['next_lod','uv_plan','uv_plan_reviewed','unwrap','bake']);const result=JSON.parse(await t.execute({nodeId:'source',action:'next_lod'}));assert.equal(result.generated,false);assert.deepEqual(calls,[['source','next_lod']]);latest.current.readOnly=true;assert.equal(JSON.parse(await t.execute({nodeId:'source',action:'next_lod'})).ok,false);assert.equal(calls.length,1);stop();console.log('NEXT_STEP_MCP_OK same UI action/no generation/read-only guard');
