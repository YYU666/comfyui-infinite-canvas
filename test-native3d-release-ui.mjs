import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

const origin = 'http://native3d-fixture.test';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
let project = { id: 'prj_native3d_fixture', name: 'Native3D fixture', revision: 1, shots: [],
  canvas: { viewport: { x: 0, y: 0, zoom: 0.8 }, nodes: [
    { id: 'saved-model', type: 'native3d', position: { x: 150, y: 450 },
      data: { title: 'Saved model', operation: 'analyze', status: 'completed', assetPath: 'assets/cube.glb' } },
    { id: 'pixal-glb', type:'media', position:{x:320,y:450}, data:{title:'Pixal result',kind:'model',output:true,
      assetPath:'assets/'+'a'.repeat(64)+'.glb',filename:'lamp.glb',type:'output'} },
  ], edges: [] } };
const browser = await chromium.launch({headless: true});
try {
  const context = await browser.newContext({viewport:{width: 1500,height: 900},serviceWorkers:'block'});
  await context.addInitScript(({key,id}) => {
    sessionStorage.setItem(key,JSON.stringify({version:1,id,readOnly:false}));
    window.fixtureTools = new Map();
    Object.defineProperty(document,'modelContext',{value:{registerTool(tool){window.fixtureTools.set(tool.name, tool);}}});
    window.EventSource = class { addEventListener() {} close() {} };
  }, {key:PROJECT_SESSION_KEY,id:project.id});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const json = data => route.fulfill({json:data});
    if (url.href === 'https://docs.comfy.org/tutorials/3d/pixal3d') return route.fulfill({body:'Guide opened',contentType:'text/plain'});
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/projects/open') return json(project);
    if (url.pathname === '/api/projects/'+project.id) {
      if(route.request().method()==='PUT') project={...project,...route.request().postDataJSON(),revision:project.revision+1};
      return json(project);
    }
    if(url.pathname==='/api/health') return json({ok:true,comfy:{running:false},native3d:{service:true}});
    if(url.pathname==='/api/native3d/capabilities') return json({ready:false,missing:['Fixture: optional engine is unavailable'],operations:[],adapters:[]});
    if(url.pathname==='/api/settings') return json({notifications:false,checkUpdatesOnLaunch:false});
    if(url.pathname.startsWith('/api/')) return json({});
    const filename=path.join(dist,url.pathname==='/'?'index.html':url.pathname.slice(1));
    return route.fulfill({contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html',body:await readFile(filename)});
  });
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.stack));
  await page.goto(origin);
  await page.waitForFunction(()=>window.fixtureTools.has('canvas_create_node')).catch(error=>{throw new Error(error.message + ': ' + errors.join(', '));});
  const call = (name, args) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  const created = await call('canvas_create_node', { preset: 'model_asset', x: 150, y: 160 });
  assert.equal(created.ok, true, created.error);
  assert.equal(project.canvas.nodes.find(node => node.id === created.node.id)?.data.operation, 'analyze');
  const lod = await call('canvas_create_node', { preset: 'model_lod', x: 620, y: 160 });
  assert.equal(lod.ok, true, lod.error);
  const unsaved = await call('canvas_connect_nodes', { sourceId: created.node.id, targetId: lod.node.id });
  assert.equal(unsaved.ok, false, 'an empty model card cannot supply geometry');
  const link = await call('canvas_connect_nodes', { sourceId: 'saved-model', targetId: lod.node.id });
  assert.equal(link.ok, true, link.error);
  assert.equal(project.canvas.edges[0]?.target, lod.node.id);
  await page.locator('.react-flow__edge').waitFor();
  const capabilities = await call('canvas_native3d_capabilities', {});
  assert.equal(capabilities.ok, true, capabilities.error);
  const direct = await call('canvas_connect_nodes', { sourceId:'pixal-glb', targetId:lod.node.id });
  assert.equal(direct.ok,true,direct.error);
  await call('canvas_update_node',{nodeId:lod.node.id,settings:{nativeParameters:{lodCount:5}}});
  const updated=await call('canvas_update_node',{nodeId:lod.node.id,settings:{nativeParameters:{lodCount:2}}});
  assert.equal(updated.ok,true,updated.error);
  const cold = await context.newPage();
  cold.on('pageerror',error=>errors.push(error.stack));
  await cold.goto(origin);
  await cold.waitForFunction(()=>window.fixtureTools.has('canvas_get_state'));
  const state = await cold.evaluate(async (nodeId) => JSON.parse(await window.fixtureTools.get('canvas_get_state').execute({nodeId})),lod.node.id);
  assert.equal(state.ok,true,state.error);
  assert.equal(project.canvas.nodes.find(n=>n.id===lod.node.id).data.nativeParameters.lodCount,2);
  assert.equal(project.canvas.edges.find(e=>e.target===lod.node.id&&e.targetHandle==='model').source,'pixal-glb');
  await cold.getByTitle('添加元素',{exact:true}).click();
  const guide=cold.getByRole('link',{name:'Pixal3D 节点与权重配置'});
  assert.equal(await guide.getAttribute('href'),'https://docs.comfy.org/tutorials/3d/pixal3d');
  const [popup] = await Promise.all([context.waitForEvent('page',{timeout:6000}),guide.click({timeout:5000})]);
  await popup.waitForURL('https://docs.comfy.org/tutorials/3d/pixal3d');
  assert.deepEqual(errors,[]);
  console.log('NATIVE3D_CANVAS_SMOKE_OK');
} finally { await browser.close(); }
