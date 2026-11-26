import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from './test-browser.mjs';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

const root = process.env.H3_NATIVE3D_REAL_BROWSER_ROOT;
const lamp = process.env.H3_NATIVE3D_REAL_BROWSER_GLB;
assert.ok(root && lamp, 'Set isolated backend root and source GLB fixture');
const projectId = (await readFile(join(root, 'project-id.txt'), 'utf8')).trim();
const instance = JSON.parse(await readFile(join(root, 'runtime', 'instance.json'), 'utf8'));
const origin = 'http://127.0.0.1:' + instance.port;
async function request(path, payload) {
  const response = await fetch(origin + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {'X-H3-Token': instance.token, 'Content-Type':'application/json'},
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message || JSON.stringify(value)), {status:response.status});
  return value;
}
async function eventually(read, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await sleep(150);
  }
  throw Error('Timed out waiting for isolated browser state');
}
const current = () => eventually(async () => {
  try { return await request('/api/agent/canvas/current?projectId='+projectId); }
  catch (error) { if (error.status !== 409 && error.status !== 404) throw error; }
});
async function call(tool,args, verifySubmission = () => {}) {
  const page = await current();
  const opId = 'browser-lod-' + randomUUID();
  await request('/api/agent/canvas/commands',{...page,opId,tool,args});
  verifySubmission(opId);
  return eventually(async () => {
    const command = await request('/api/agent/canvas/commands/'+opId);
    if (['expired','unknown'].includes(command.status)) throw Error(tool + ' command ' + command.status);
    return command.status==='done' ? command.result : null;
  });
}
const ok = async (tool,args) => {
  const result = await call(tool,args);
  assert.equal(result.ok,true,result.error);
  return result;
};
const browser = await chromium.launch({headless:true});
const glb = await readFile(lamp);
const errors = [];
let sourceReads = 0;
async function open() {
  const context = await browser.newContext({viewport:{width:1520,height:1000}});
  await context.addInitScript(({key,projectId}) => sessionStorage.setItem(key,JSON.stringify({version:1,id:projectId,readOnly:false})),{key:PROJECT_SESSION_KEY,projectId});
  // Only the upstream historical ComfyUI download is substituted. Native3D,
  // file persistence, app, HTTP page bridge and viewer markup are unmocked.
  await context.route('**/api/comfy/view?*', route => {
    sourceReads++;
    return route.fulfill({body:glb,contentType:'model/gltf-binary'});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await current();
  return {context,page};
}
try {
  const initial = await open();
  const node = process.env.H3_NATIVE3D_TEST_UPLOAD_RECOVERY === '1'
    ? await eventually(async () => {
      const project = await request('/api/projects/'+projectId);
      const draft = project.canvas.nodes.find(n=>n.id==='stale-upload');
      return draft?.data.status==='idle' && draft.data.nativeSourceImport===null ? draft : null;
    })
    : (await ok('canvas_create_node',{preset:'model_lod',x:650,y:300})).node;
  if (process.env.H3_NATIVE3D_TEST_UPLOAD_RECOVERY === '1') {
    assert.equal((await request('/api/native3d/jobs?projectId='+projectId)).jobs.length,0);
  }
  const edge = await ok('canvas_connect_nodes',{sourceId:'pixal-generated',targetId:node.id,sourceHandle:'model',targetHandle:'model'});
  assert.equal(edge.edge.sourceHandle,'model');
  assert.equal(edge.edge.targetHandle,'model');
  await ok('canvas_update_node',{nodeId:node.id,settings:{nativeParameters:{lodCount:5}}});
  await ok('canvas_update_node',{nodeId:node.id,settings:{nativeParameters:{lodCount:2,lod0KeepPercent:100,lod1KeepPercent:95}}});
  let opId;
  const submitted = await call('canvas_generate_node',{nodeId:node.id,wait:false}, id => { opId=id; });
  assert.equal(submitted.ok,true,submitted.error);
  const jobId = submitted.jobId;
  assert.match(jobId,/^n3d_[a-f0-9]{32}$/);
  const pending = await ok('canvas_native3d_sync_task',{nodeId:node.id});
  assert.equal(pending.jobId,jobId);
  await eventually(async () => {
    const value=await request('/api/projects/'+projectId);
    return value.canvas.nodes.find(n=>n.id===node.id)?.data.nativeDeliveredJobId===jobId;
  },200000);
  const job=await request('/api/native3d/jobs/'+jobId);
  assert.deepEqual(job.canvasSubmission,{origin:'agent',opId,projectId,nodeId:node.id});
  assert.equal(job.parameters.lodCount,2);
  await assert.rejects(request('/api/native3d/jobs',{opId,projectId,nodeId:node.id,operation:job.operation,
    source:job.source,parameters:job.parameters}), error=>error.status===403);
  assert.equal(job.result.metadata.geometry.status,'accepted');
  const before=await request('/api/projects/'+projectId);
  const source=before.canvas.nodes.find(n=>n.id==='pixal-generated');
  assert.equal(job.source.assetPath,source.data.assetPath);
  assert.equal(sourceReads,1);
  const oldPage = await current();
  await initial.page.getByTitle('返回项目启动器').click();
  await initial.context.close();
  await eventually(async () => {
    try {
      const active = await request('/api/agent/canvas/current?projectId='+projectId);
      return active.sessionId !== oldPage.sessionId;
    } catch (error) { if (error.status===404 || error.status===409) return true; throw error; }
  });

  const reopened=await open();
  const restored=await request('/api/projects/'+projectId);
  assert.equal(restored.canvas.nodes.find(n=>n.id===node.id).data.nativeParameters.lodCount,2);
  assert.equal(restored.canvas.edges.find(e=>e.target===node.id&&e.targetHandle==='model').source,'pixal-generated');
  assert.equal((await ok('canvas_native3d_sync_task',{nodeId:node.id})).jobId,jobId);
  assert.equal((await request('/api/native3d/jobs?projectId='+projectId)).jobs.filter(j=>j.nodeId===node.id).length,1);
  if (process.env.H3_NATIVE3D_VERIFY_DERIVED === '1') {
    const countJobs = async () => (await request('/api/native3d/jobs?projectId='+projectId)).jobs.length;
    const {node: high} = await ok('canvas_create_node',{preset:'model_asset',x:50,y:650});
    const previousCount = await countJobs();
    const imported = await ok('canvas_import_asset',{nodeId:high.id,assetPath:source.data.assetPath,name:'approved-high.glb'});
    assert.equal(imported.node.id,high.id);
    assert.equal(await countJobs(),previousCount);
    const analyzed = await ok('canvas_generate_node',{nodeId:high.id,wait:false});
    assert.match(analyzed.jobId,/^n3d_[a-f0-9]{32}$/);
    await eventually(async () => (await request('/api/projects/'+projectId)).canvas.nodes.find(n=>n.id===high.id)?.data.nativeDeliveredJobId===analyzed.jobId,90000);
    await ok('canvas_native3d_stage',{sourceId:node.id,stage:'lod0'});
    assert.equal(await countJobs(),previousCount+1);
    const staged = await request('/api/projects/'+projectId);
    const stage = staged.canvas.nodes.find(n=>n.data.nativeStage==='lod1'&&n.data.sourceJobId===jobId);
    assert.ok(stage?.id,'there must be a delivered LOD1 stage');
    let retryOpId;
    const retry = await call('canvas_native3d_retry_stage',{nodeId:stage.id}, id=>{retryOpId=id;});
    assert.equal(retry.ok,true,retry.error);
    assert.match(retry.jobId,/^n3d_[a-f0-9]{32}$/);
    const child = await request('/api/native3d/jobs/'+retry.jobId);
    assert.deepEqual(child.canvasSubmission,{origin:'agent',opId:retryOpId,projectId,nodeId:retry.nodeId,
      originNodeId:stage.id,tool:'canvas_native3d_retry_stage'});
    assert.equal(child.parameters.retryStage,'lod1');
    assert.equal(await countJobs(),previousCount+2);
    const finished = await eventually(async () => {
      const current = await request('/api/native3d/jobs/'+retry.jobId);
      return ['succeeded','failed','cancelled'].includes(current.status) ? current : null;
    },120000);
    assert.equal(finished.status,'succeeded',JSON.stringify(finished.error));
    console.log('NATIVE3D_REAL_DERIVED_OK', JSON.stringify({analyzeJobId:analyzed.jobId,retryJobId:retry.jobId,
      originNodeId:stage.id,retryOpId,retryGeometry:finished.result.metadata.geometry.status}));
  }
  assert.deepEqual(errors,[]);
  console.log('NATIVE3D_REAL_BROWSER_OK', JSON.stringify({jobId,opId,lodCount:2,sourceReads,pending:pending.pending}));
} finally { await browser.close(); }
