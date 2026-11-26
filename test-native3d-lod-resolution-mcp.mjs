import assert from 'node:assert/strict';
import {registerCanvasMcp} from './src/canvas-mcp.js';
let calls=[];const map=new Map();const latest={current:{readOnly:false,actions:{native3dCreateResolution:async(...args)=>{calls.push(args);return {nodeId:'draft',generated:false,reused:false};},persistProject:async()=>{}}}};
const stop=registerCanvasMcp(latest,{context:{registerTool:t=>map.set(t.name,t)},startPage:()=>()=>{}});
const t=map.get('canvas_native3d_create_resolution');assert.equal(t.inputSchema.properties.keepPercent.type,'number');const result=JSON.parse(await t.execute({nodeId:'source',keepPercent:1.5}));assert.equal(result.generated,false);assert.deepEqual(calls,[['source',1.5]]);latest.current.readOnly=true;assert.equal(JSON.parse(await t.execute({nodeId:'source',keepPercent:1.5})).ok,false);assert.equal(calls.length,1);stop();console.log('LOD_RESOLUTION_MCP_OK same UI action/no generation/read-only guard');
