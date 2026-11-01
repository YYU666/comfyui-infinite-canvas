import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

const origin = 'http://127.0.0.1:8799';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const digest = 'b'.repeat(64);
const definition = { nodeDefinitionId: 'workflow', name: 'Catalog workflow', inputs: [], parameters: { type: 'object', properties: { model_name: { type: 'string', default: 'required.safetensors' } } }, outputs: [{ id: 'image', type: 'image', nodeId: 'save' }] };
const bundle = { digest, manifest: { packageId: 'fixture/catalog', name: 'Catalog workflow', version: '0.1.0', description: 'Fixture only' }, nodes: [{ definition, workflow: { model: { class_type: 'UNETLoader', inputs: { unet_name: 'required.safetensors' } }, save: { class_type: 'SaveImage', inputs: { images: ['model', 0], filename_prefix: 'safe' } } } }] };
let project = { id: 'prj_exchange_fixture', name: 'Exchange fixture', revision: 1, shots: [], canvas: { viewport: { x: 0, y: 0, zoom: .75 }, edges: [], nodes: [{ id: 'qwen', type: 'generator', selected: true, position: { x: 20, y: 50 }, data: { title: 'Qwen分享', mode: 'qwenEdit', prompt: 'PRIVATE CREATIVE PROMPT', seed: 42, ratio: '16:9' } }] } };
let missing = false; let downloaded = false; let longDownload = false; let failSave = false;
const imported = []; const reports = []; const shares = []; const downloads = []; const writes = []; const unexpected = []; const errors = [];
const model = (parameters = {}) => ({ id: 'model:unet_name', nodeId: 'model', inputName: 'unet_name', parameterId: 'model_name', category: 'diffusion_models', name: parameters.model_name || 'required.safetensors', status: missing && !downloaded && !parameters.model_name ? 'missing' : 'installed', candidates: [{ name: 'local.safetensors', compatibility: 'loader-option', reason: 'same loader' }], download: { path: 'diffusion_models/required.safetensors', bytes: 1024, sha256: null, url: 'https://example.invalid/trusted-fixture' } });
const report = (parameters = {}) => ({ models: [model(parameters)], comfyNodes: [{ classType: 'UNETLoader', installed: true }, { classType: 'SaveImage', installed: true }], ready: model(parameters).status === 'installed', summary: {} });
const browser = await chromium.launch({ headless: true });
try {
 const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
 await context.addInitScript(() => {
  window.fixtureTools = new Map();
  Object.defineProperty(document,'modelContext',{value:{registerTool(tool){window.fixtureTools.set(tool.name,tool);}}});
  window.EventSource = class { addEventListener() {} close() {} }; window.WebSocket = class { addEventListener() {} close() {} };
 });
 await context.route('**/*', async route => {
  const req = route.request(); const url = new URL(req.url());
  const json = (data,status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(url.origin === 'https://refmuse.cn') return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><h1>节点库</h1><input aria-label="搜索"><script>window.received=[];addEventListener('message',e=>{if(e.source!==parent||e.origin!=='${origin}')return;received.push(e.data);if(e.data.type==='refmuse.nodes.init')parent.postMessage({type:'refmuse.nodes.ready',version:1},e.origin);});window.addNode=(id,overrides={})=>parent.postMessage({type:'refmuse.nodes.add',version:1,requestId:id,packageId:'fixture/catalog',packageVersion:'0.1.0',digest:'${digest}',...overrides},'${origin}');</script>`});
  assert.equal(url.origin,origin,'no live network');
  if(url.pathname==='/api/extensions/catalog-import'){imported.push(req.postDataJSON());return json(bundle);}
  if(url.pathname===`/api/extensions/${digest}`) return json(bundle);
  if(url.pathname.endsWith('/dependencies')){const payload=req.postDataJSON();reports.push(payload);return json(report(payload.parameters));}
  if(url.pathname.endsWith('/models/download')){downloads.push(req.postDataJSON());return json({jobId:'job_fixture',status:'running',downloadedBytes:1,totalBytes:1024,total:1,completed:0});}
  if(url.pathname==='/api/extensions/download-jobs/job_fixture'){if(longDownload)return json({jobId:'job_fixture',status:'running',downloadedBytes:512,totalBytes:1024,total:1,completed:0});downloaded=true;return json({jobId:'job_fixture',status:'completed',downloadedBytes:1024,totalBytes:1024,total:1,completed:1});}
  if(url.pathname==='/api/extensions/share'){shares.push(req.postDataJSON());return json({...bundle,dependencyReport:report()});}
  if(url.pathname.endsWith('/download'))return route.fulfill({contentType:'application/zip',body:Buffer.from('fixture archive')});
  if(url.pathname==='/api/projects')return json({projects:[project]});
  if(url.pathname==='/api/projects/trash')return json({projects:[]});
  if(url.pathname==='/api/projects/open')return json(project);
  if(url.pathname===`/api/projects/${project.id}`){if(req.method()==='PUT'){if(failSave)return json({message:'Synthetic save failure'},500);writes.push(req.postDataJSON());project={...req.postDataJSON(),revision:project.revision+1};}return json(project);}
  if(url.pathname.startsWith('/api/agent/canvas/'))return json({message:'native fixture only'},503);
  if(url.pathname==='/api/settings')return json({notifications:false,checkUpdatesOnLaunch:false});
  if(url.pathname==='/api/queue'){if(req.method()!=='GET')unexpected.push(url.pathname);return json({jobs:[]});}
  if(url.pathname==='/api/comfy/system_stats')return json({devices:[]});
  if(url.pathname==='/api/hardware-metrics')return json({});
  if(url.pathname.startsWith('/api/')){if(!['GET','HEAD'].includes(req.method()))unexpected.push(url.pathname);return json({});}
  const file=path.join(dist,url.pathname==='/'?'index.html':url.pathname.slice(1));return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:await readFile(file)});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.locator('.project-open').click();
 await page.getByRole('button',{name:'节点库',exact:true}).click();
 const panel=page.getByRole('complementary',{name:'节点库'});await panel.waitFor();
 const remote=page.frames().find(frame=>frame.url().startsWith('https://refmuse.cn/open'));
 await remote.waitForFunction(()=>typeof window.addNode==='function');
 await remote.evaluate(()=>addNode('first'));
 await remote.waitForFunction(()=>received.some(message=>message.type==='refmuse.nodes.add.result'&&message.requestId==='first'&&message.ok));
 assert.equal(imported.length,1); assert.equal(project.canvas.nodes.filter(node=>node.data.mode==='customWorkflow').length,1);
 assert.ok(writes.length>0,'success ack follows saved canvas');
 await remote.evaluate(()=>{addNode('first');addNode('first',{packageId:'fixture/changed'});});
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='first'&&message.ok===false));
 assert.equal(imported.length,1,'duplicate and changed request IDs never import again');
 await page.evaluate(()=>{const source=document.querySelector('iframe[title="Refmuse 节点库"]').contentWindow;window.dispatchEvent(new MessageEvent('message',{origin:'https://evil.example',source,data:{type:'refmuse.nodes.add',version:1,requestId:'evil'}}));});
 assert.equal(imported.length,1);
 missing=true;
 await remote.evaluate(()=>addNode('missing'));
 const dialog=page.getByRole('dialog',{name:'添加工作流到画布'});await dialog.waitFor();
 assert.match(await dialog.innerText(),/不保证架构/);
 assert.equal(downloads.length,0,'does not auto-download');
 const selectsBefore=reports.length;
 await dialog.getByLabel('替换 required.safetensors').selectOption('local.safetensors');
 assert.equal(reports.length,selectsBefore,'selection alone does not apply replacement');
 await dialog.getByRole('button',{name:'确认使用此替换'}).click();
 await dialog.getByRole('button',{name:'添加到当前画布',exact:true}).click();
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='missing'&&message.ok));
 assert.equal(project.canvas.nodes.filter(node=>node.data.mode==='customWorkflow').length,2);
 assert.equal(project.canvas.nodes.at(-1).data.workflowParameters.model_name,'local.safetensors');
 await remote.evaluate(()=>addNode('download'));
 await dialog.waitFor();await dialog.getByRole('button',{name:/一键补齐/}).click();
 await dialog.getByRole('button',{name:'添加到当前画布',exact:true}).click();
 assert.deepEqual(downloads[0].modelIds,['model:unet_name']);
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='download'&&message.ok));
 downloaded=false;longDownload=true;
 await remote.evaluate(()=>addNode('long-download'));
 await dialog.waitFor();await dialog.getByRole('button',{name:/一键补齐/}).click();
 await dialog.getByText(/模型正在后台下载/).waitFor();
 await dialog.getByRole('button',{name:'关闭添加工作流到画布'}).click();
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='long-download'&&message.ok===false));
 assert.equal(await page.locator('.neo-canvas-wrap').evaluate(element=>element.inert),false,'long model downloads do not lock canvas');
 const downloadCount=downloads.length;
 await remote.evaluate(()=>addNode('resume-download'));
 await dialog.waitFor();await dialog.getByText(/模型正在后台下载/).waitFor();
 assert.equal(downloads.length,downloadCount,'reopening monitors original job without submitting a duplicate');
 longDownload=false;
 await dialog.getByRole('button',{name:'添加到当前画布',exact:true}).click();
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='resume-download'&&message.ok));
 await remote.evaluate(()=>addNode('cancelled'));
 // Ready dependencies import directly; a new missing item is used to exercise cancellation.
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='cancelled'&&message.ok));
 downloaded=false;
 await remote.evaluate(()=>addNode('cancel-review'));
 await dialog.waitFor();await dialog.getByRole('button',{name:'关闭添加工作流到画布'}).click();
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='cancel-review'&&message.ok===false));
 await panel.getByRole('button',{name:'关闭节点库'}).click();
 await panel.waitFor({state:'hidden'});
 await dialog.waitFor({state:'hidden'});
 await page.waitForFunction(()=>!document.querySelector('.neo-canvas-wrap').inert);
 // Existing unresolved nodes expose a later dependency check without importing another copy.
 const focusNode=async(nodeId)=>{
  const result=await page.evaluate(async(id)=>JSON.parse(await window.fixtureTools.get('canvas_focus_node').execute({nodeId:id})),nodeId);
  assert.equal(result.ok,true,'fixture must focus the existing node through the current canvas bridge');
 };
 const customId=project.canvas.nodes.find(node=>node.data.mode==='customWorkflow').id;
 await focusNode(customId);
 const custom=page.locator(`.react-flow__node[data-id="${customId}"]`);
 await custom.getByRole('button',{name:'检查依赖'}).click();
 await dialog.waitFor();await dialog.getByRole('button',{name:'关闭添加工作流到画布'}).click();
 await dialog.waitFor({state:'hidden'});
 await page.waitForFunction(()=>!document.querySelector('.neo-canvas-wrap').inert);
 // Share Qwen from its node footer: local preview first, no remote upload and no image upload.
 await focusNode('qwen');
 await page.locator('.react-flow__node[data-id="qwen"]').click();
 await page.locator('.creator-toolbar').getByRole('button',{name:'上传此节点'}).click();
 const share=page.getByRole('dialog',{name:'上传节点到节点库'});await share.waitFor();
 assert.equal(await share.getByRole('checkbox').isChecked(),false);
 await share.getByRole('button',{name:'整理依赖并预览'}).click();
 await share.getByRole('button',{name:'确认并前往 Refmuse 提交'}).waitFor();
 assert.equal(shares.length,1);assert.equal(shares[0].includePrompts,false);
 assert.equal(shares[0].workflow.source.inputs.image,'input_guide.png');
 await share.getByRole('button',{name:'确认并前往 Refmuse 提交'}).click();
 await remote.waitForFunction(()=>received.some(message=>message.type==='refmuse.nodes.share'));
 const shared=await remote.evaluate(()=>{const message=received.find(item=>item.type==='refmuse.nodes.share');return {summary:message.summary,bytes:message.package.byteLength};});
 assert.ok(shared.bytes>0);assert.deepEqual(Object.keys(shared.summary.models[0]).sort(),['category','name']);
 assert.equal(JSON.stringify(shared.summary).includes('local.safetensors'),false,'local replacement inventory never leaves this machine');
 missing=false;failSave=true;
 const savedNodeCount=project.canvas.nodes.length;
 await remote.evaluate(()=>addNode('save-failure'));
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='save-failure'&&message.ok===false));
 assert.equal(project.canvas.nodes.length,savedNodeCount,'save error never reports a delivered node');
 assert.equal(await remote.evaluate(()=>received.some(message=>message.requestId==='save-failure'&&message.ok===true)),false);
 const visibleAfterFailedSave=await page.locator('.react-flow__node').count();
 failSave=false;
 await remote.evaluate(()=>addNode('save-retry-new-request'));
 await remote.waitForFunction(()=>received.some(message=>message.requestId==='save-retry-new-request'&&message.ok===true));
 assert.equal(await page.locator('.react-flow__node').count(),visibleAfterFailedSave,'new request retries original visible node without duplication');
 assert.equal(project.canvas.nodes.length,savedNodeCount+1);
 assert.deepEqual(unexpected,[],'no generation or media upload'); assert.deepEqual(errors,[]);
 console.log('Workflow exchange UI passed: saved catalog import, idempotency/origin guards, explicit replacement, download job, cancellation, later dependency repair, Qwen share preview and bounded summary.');
 await context.close();
} finally {await browser.close();}
