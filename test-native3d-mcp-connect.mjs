import assert from 'node:assert/strict';
import { registerCanvasMcp } from './src/canvas-mcp.js';
import { planCanvasConnection } from './src/canvas-connections.js';
const nodes=[
 {id:'saved',type:'native3d',data:{operation:'analyze',assetPath:'assets/source.glb',status:'completed'}},
 {id:'ai',type:'native3d',data:{operation:'ai_lowpoly',status:'error',error:'Missing weight configuration'}},
 {id:'uv',type:'native3d',data:{operation:'uv',status:'idle'}},
 {id:'planner',type:'native3d',data:{operation:'uv_plan',status:'completed',nativeJobId:'plan-job'}},
 {id:'plan-result',type:'native3d',data:{operation:'analyze',status:'completed',nativeUVPlan:{jobId:'plan-job'}}},
 {id:'image',type:'media',data:{kind:'image',url:'/image.png'}},
 {id:'videoGen',type:'generator',data:{mode:'reference'}},
];
const tools=new Map();let saves=0;let stopped=false;const requests=[];
const latest={current:{projectId:'prj_synthetic',nodesRef:{current:nodes},edgesRef:{current:[]},readOnly:false,actions:{
 onConnect:connection=>{
   requests.push(connection);
   const plan=planCanvasConnection(connection,latest.current.nodesRef.current,latest.current.edgesRef.current);
   if(plan.error)return plan;
   const edge={...plan.connection,id:`edge-${requests.length}`};latest.current.edgesRef.current.push(edge);return {edgeId:edge.id,...plan.connection};
 },persistProject:async()=>{saves++;},
}}};
const dispose=registerCanvasMcp(latest,{context:{registerTool:tool=>tools.set(tool.name,tool)},startPage:()=>()=>{stopped=true;}});
const execute=async(name,args)=>JSON.parse(await tools.get(name).execute(args));
try{
 const inferred=await execute('canvas_connect_nodes',{sourceId:'saved',targetId:'ai'});
 assert.equal(inferred.ok,true);assert.equal(inferred.edge.sourceHandle,'model');assert.equal(inferred.edge.targetHandle,'model');
 assert.deepEqual(requests[0],{source:'saved',target:'ai',sourceHandle:'model',targetHandle:'model'});
 const explicit=await execute('canvas_connect_nodes',{sourceId:'saved',targetId:'uv',targetHandle:'model'});
 assert.equal(explicit.ok,true);assert.equal(explicit.edge.sourceHandle,'model');
 const directPlan=await execute('canvas_connect_nodes',{sourceId:'plan-result',targetId:'uv'});
 assert.equal(directPlan.ok,true);assert.equal(directPlan.edge.source,'plan-result');assert.equal(directPlan.edge.sourceHandle,'plan');assert.equal(directPlan.edge.targetHandle,'plan');
 const producedPlan=await execute('canvas_connect_nodes',{sourceId:'planner',targetId:'uv',targetHandle:'plan'});
 assert.equal(producedPlan.ok,true);assert.equal(producedPlan.edge.source,'plan-result');assert.equal(producedPlan.edge.sourceHandle,'plan');assert.equal(producedPlan.edge.targetHandle,'plan');
 const inferredProducedPlan=await execute('canvas_connect_nodes',{sourceId:'planner',targetId:'uv'});
 assert.equal(inferredProducedPlan.ok,true);assert.equal(inferredProducedPlan.edge.source,'plan-result');assert.equal(inferredProducedPlan.edge.targetHandle,'plan');
 for(const args of [{sourceId:'plan-result',targetId:'ai'},{sourceId:'planner',targetId:'ai',targetHandle:'plan'},{sourceId:'plan-result',targetId:'uv',targetHandle:'model'}]) {
   const rejected=await execute('canvas_connect_nodes',args);assert.equal(rejected.ok,false);assert.match(rejected.error,/方案/);
 }
 const invalid=await execute('canvas_connect_nodes',{sourceId:'saved',targetId:'uv',targetHandle:'guide'});
 assert.equal(invalid.ok,false);assert.match(invalid.error,/模型输入/);
 const standard=await execute('canvas_connect_nodes',{sourceId:'image',targetId:'videoGen'});
 assert.equal(standard.ok,true);assert.equal(standard.edge.sourceHandle,'ref');assert.equal(standard.edge.targetHandle,'references');
 const state=await execute('canvas_get_state',{});
 assert.equal(state.nodes.find(n=>n.id==='saved').hasMedia,true);
 assert.equal(state.nodes.find(n=>n.id==='ai').hasMedia,false);
 assert.equal(state.nodes.find(n=>n.id==='ai').error,'Missing weight configuration');
 assert.equal(saves,6);
 latest.current.readOnly=true;
 const readOnly=await execute('canvas_connect_nodes',{sourceId:'saved',targetId:'uv'});
 assert.equal(readOnly.ok,false);assert.match(readOnly.error,/只读/);assert.equal(saves,6);
}finally{dispose();}
assert.equal(stopped,true);
console.log('NATIVE3D_MCP_CONNECT_OK actual registered execute: inferred/explicit model and plan ports, immutable planner output resolution, invalid targets, image compatibility, saved media/error summaries, readonly');
