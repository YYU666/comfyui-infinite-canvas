import assert from 'node:assert/strict';
import { startCurrentCanvasPage, validateCanvasArgs } from './src/canvas-current-page.js';

const schema = { type: 'object', properties: { nodeId: { type: 'string' }, wait: { type: 'boolean' } }, required: ['nodeId'], additionalProperties: false };
assert.throws(() => validateCanvasArgs({}, schema), /required/);
assert.throws(() => validateCanvasArgs({ nodeId: 2 }, schema), /string/);
assert.throws(() => validateCanvasArgs({ nodeId: 'a', script: 'x' }, schema), /unsupported/);
const moveSchema={type:'object',properties:{nodes:{type:'array',minItems:1,maxItems:30,items:{type:'object',properties:{nodeId:{type:'string'},x:{type:'number'},y:{type:'number'}},required:['nodeId','x','y'],additionalProperties:false}}},required:['nodes'],additionalProperties:false};
validateCanvasArgs({nodes:[{nodeId:'model-a',x:100,y:200},{nodeId:'model-b',x:-1,y:0}]},moveSchema);
assert.throws(()=>validateCanvasArgs({nodes:{}},moveSchema),/expected array/);
assert.throws(()=>validateCanvasArgs({nodes:[]},moveSchema),/minItems/);
assert.throws(()=>validateCanvasArgs({nodes:Array(31).fill({nodeId:'a',x:0,y:0})},moveSchema),/maxItems/);
assert.throws(()=>validateCanvasArgs({nodes:[{nodeId:'a',x:0}]},moveSchema),/args.nodes\[0\].y: required/);
assert.throws(()=>validateCanvasArgs({nodes:[{nodeId:'a',x:Infinity,y:0}]},moveSchema),/args.nodes\[0\].x: expected number/);
assert.throws(()=>validateCanvasArgs({nodes:[{nodeId:'a',x:0,y:0,script:'x'}]},moveSchema),/unsupported argument/);
assert.throws(()=>validateCanvasArgs({nodes:[[1,2]]},moveSchema),/expected object/);
assert.throws(()=>validateCanvasArgs({nodes:[{nodeId:'a',x:0,y:0}],other:true},moveSchema),/unsupported argument/);
validateCanvasArgs([[1,2],[3]],{type:'array',items:{type:'array',minItems:1,maxItems:2,items:{type:'integer'}}});
assert.throws(()=>validateCanvasArgs([[1,'x']],{type:'array',items:{type:'array',items:{type:'integer'}}}),/args\[0\]\[1\]: expected integer/);
let moveExecutions=0;const moveResults=[];
const moveCommands=[{nodes:[{nodeId:'model-a',x:125,y:250}]},{nodes:[{nodeId:'model-a',x:'invalid',y:250}]},{nodes:[{nodeId:'model-a',x:300,y:400}]}];
const stopMoves=startCurrentCanvasPage({intervalMs:5,
 getPage:()=>({projectId:'prj_moves',visible:true,readOnly:moveResults.length>=2}),
 tools:[{name:'canvas_move_nodes',inputSchema:moveSchema,execute:async args=>{moveExecutions++;return JSON.stringify({ok:true,moved:args.nodes});}}],
 fetchImpl:async(url,options)=>{
  const payload=JSON.parse(options.body);
  if(url.endsWith('/result')){moveResults.push(payload.result);return {ok:true,json:async()=>({})};}
  if(url.endsWith('/release'))return {ok:true,json:async()=>({})};
  const index=moveResults.length;
  return {ok:true,json:async()=>({epoch:'move_epoch',command:index<moveCommands.length?{epoch:'move_epoch',sessionId:payload.sessionId,projectId:'prj_moves',opId:`move-${index}`,tool:'canvas_move_nodes',args:moveCommands[index]}:null})};
 }});
try{
 for(let i=0;i<200 && moveResults.length<3;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(moveResults.length,3);assert.equal(moveResults[0].ok,true);
 assert.deepEqual(moveResults[0].moved,moveCommands[0].nodes);
 assert.equal(moveResults[1].ok,false);assert.match(moveResults[1].error,/expected number/);
 assert.equal(moveResults[2].ok,false);assert.equal(moveExecutions,1,'malformed arrays and readonly pages must never execute movement');
}finally{stopMoves();}
let visible = true;
let executions = 0;
let heartbeat = 0;
let deliveryAttempts = 0;
let released = false;
const results = [];
const stop = startCurrentCanvasPage({
  intervalMs: 5,
  getPage: () => ({ projectId: 'prj_test', visible }),
  tools: [{ name: 'canvas_generate_node', inputSchema: schema, execute: async () => {
    executions += 1;
    return JSON.stringify({ ok: true, node: { queueJobId: 'job_once' } });
  } }],
  fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith('/release')) { released = true; return { ok: true, json: async () => ({}) }; }
    if (url.endsWith('/result')) {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error('lost result response');
      results.push(payload);
      return { ok: true, json: async () => ({}) };
    }
    heartbeat += 1;
    let command = null;
    if (!payload.busy && heartbeat <= 5) command = { epoch: 'epoch', sessionId: payload.sessionId, projectId: payload.projectId,
      opId: 'once', tool: 'canvas_generate_node', args: { nodeId: 'g1', wait: false } };
    if (results.length && !visible) command = { epoch: 'epoch', sessionId: payload.sessionId, projectId: payload.projectId,
      opId: 'hidden', tool: 'canvas_generate_node', args: { nodeId: 'g1', wait: false } };
    return { ok: true, json: async () => ({ epoch: 'epoch', command }) };
  },
});
try {
  const until = async (read) => {
    for (let i = 0; i < 200 && !read(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(read(), 'current page test timed out');
  };
  await until(() => results.length > 0);
  assert.equal(results[0].result.node.queueJobId, 'job_once');
  await until(() => heartbeat >= 6);
  assert.equal(executions, 1, 'lost receipts and duplicate delivery never rerun generation');
  visible = false;
  await until(() => results.some((result) => result.opId === 'hidden'));
  assert.equal(executions, 1, 'visibility checked again before tool execution');
  assert.equal(results.find((result) => result.opId === 'hidden').result.ok, false);
} finally { stop(); }
assert.equal(released, true);
console.log('CURRENT_CANVAS_TRANSPORT_OK dedup=true resultRetryOnly=true hiddenBlocked=true');

// Backend restart invalidates old receipts, never the page's execution dedup.
let restartEpoch = 'old'; let restartExecutions = 0; let abandoned = 0; let replayObserved = false;
let oldDelivery = false; let newResult = false;
const stopRestart = startCurrentCanvasPage({
  intervalMs: 5,
  getPage: () => ({ projectId: 'prj_restart', visible: true }),
  tools: [{ name: 'canvas_generate_node', inputSchema: schema,
    execute: async () => { restartExecutions++; return JSON.stringify({ ok: true }); },
    onResultDeliveryAbandoned: () => { abandoned++; },
  }],
  fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith('/result')) {
      if (payload.epoch === 'old') { oldDelivery = true; throw new Error('backend stopped before receipt'); }
      newResult = true;
      return { ok: true, json: async () => ({}) };
    }
    if (url.endsWith('/release')) return { ok: true, json: async () => ({}) };
    let opId = 'same-generation';
    if (restartEpoch === 'new' && replayObserved) opId = 'new-generation';
    if (restartEpoch === 'new') replayObserved = true;
    return { ok: true, json: async () => ({ epoch: restartEpoch, command: {
      epoch: restartEpoch, sessionId: payload.sessionId, projectId: payload.projectId,
      opId, tool: 'canvas_generate_node', args: { nodeId: 'g1', wait: false },
    } }) };
  },
});
const waitRestart = async (read) => {
  for (let i = 0; i < 200 && !read(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(read(), 'restart bridge timed out');
};
try {
  await waitRestart(() => oldDelivery);
  restartEpoch = 'new';
  await waitRestart(() => newResult);
  assert.equal(abandoned, 1, 'old pending receipt abandoned on backend epoch change');
  assert.equal(restartExecutions, 2, 'old op not rerun; only the new op executes after restart');
} finally { stopRestart(); }
console.log('CURRENT_CANVAS_RESTART_OK oldReceiptAbandoned=true duplicateGenerationBlocked=true newCommandAccepted=true');
