import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// Synthetic browser fixture: every request is intercepted; no live inference/service.
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const origin = 'http://127.0.0.1:8799';
const browser = await chromium.launch({ headless: true });
const failures = [], queued = [];
const makeProject = (readOnly = false) => ({ id: 'prj_qwen_fixture', name: 'Qwen references fixture', revision: 1, readOnly, shots: [], canvas: {
  viewport: { x: 20, y: 30, zoom: 0.9 },
  nodes: [
    ...['地编截图', '场景氛围', '手绘笔触'].map((title, i) => ({ id: `image${i + 1}`, type: 'media', position: { x: 20, y: 10 + i * 240 }, data: { kind: 'image', title, remoteName: `${i + 1}.png`, url: `${origin}/fixture-${i + 1}.svg` } })),
    { id: 'qwen', type: 'generator', selected: true, position: { x: 420, y: 40 }, data: { mode: 'qwenEdit', title: '保留的概念设计标题', prompt: '保留图1的路线，使用图2的场景氛围。', qwenSteps: 40, seed: 42, randomSeed: false, status: 'idle' } },
    { id: 'renderer', type: 'generator', position: {x:-1400,y:500}, data: {mode:'image',title:'Renderer fixture',status:'done',resultUrl:`${origin}/fixture-current.svg`} },
    { id: 'rendered', type: 'media', position:{x:-900,y:500}, data:{kind:'image',title:'Current result',url:`${origin}/fixture-current.svg`,output:true,sourceGeneratorId:'renderer'} },
    { id: 'prompt', type: 'prompt', position: { x: -900, y: 0 }, data: { title: 'Prompt fixture', idea: '保留地形' } },
  ], edges: [
    { id: 'old-style', source: 'image2', target: 'qwen', sourceHandle: 'ref', targetHandle: 'identity' },
    { id: 'old-guide', source: 'image1', target: 'qwen', sourceHandle: 'ref', targetHandle: 'guide' },
  ],
} });
async function fixture(readOnly = false) {
  let project = makeProject(readOnly);
  const context = await browser.newContext({ viewport: { width: 1360, height: 1040 } });
  await context.addInitScript(() => {
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'no external request may escape fixture');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname.startsWith('/fixture-')) return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${url.pathname.includes('1') ? '#526477' : url.pathname.includes('2') ? '#6e6960' : '#807169'}"/><path d="M0 150L110 60L220 120L320 25V180H0" fill="#aaa79b"/></svg>` });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') return readOnly && !request.postDataJSON()?.readOnly ? json({ error: 'locked' }, 423) : json(project);
    if (url.pathname === `/api/projects/${project.id}`) {
      if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
      return json(project);
    }
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'native fixture only' }, 503);
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') {
      if (request.method() === 'POST') { queued.push(request.postDataJSON()); return json({ id: 'job-fixture', status: 'queued' }); }
      return json({ jobs: [] });
    }
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin); await page.locator('.project-open').click();
  await page.getByLabel('Qwen 模型版本').waitFor();
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  return { page, context, call };
}
async function center(locator) {
 const b=await locator.boundingBox(); assert.ok(b); return {x:b.x+b.width/2,y:b.y+b.height/2};
}
async function clickNode(page,id) {
 await page.getByTestId(`rf__node-${id}`).locator('.neo-node-title').click({position:{x:8,y:12}});
}
try {
 const {page,context,call}=await fixture();
 // Small hand motion remains a click, including on an image's large drag surface.
 const third=page.getByTestId('rf__node-image3');
 let p=await center(third.locator('.media-drag-surface'));
 await page.mouse.move(p.x,p.y); await page.mouse.down(); await page.mouse.move(p.x+2,p.y+1); await page.mouse.up();
 assert.match(await third.getAttribute('class'), /selected/);
 const source=third.locator('.react-flow__handle.source');
 const target=page.getByTestId('rf__node-qwen').locator('.react-flow__handle[data-handleid="references"]');
 const before=await center(source); await page.mouse.move(before.x,before.y); const after=await center(source);
 assert.ok(Math.abs(before.x-after.x)<.1 && Math.abs(before.y-after.y)<.1,'hover does not shift handle');
 assert.ok((await source.boundingBox()).width>=22,'handle hit area remains comfortable at fixture zoom');
 // Release near (not precisely on) input: snap and persist a real edge.
 const to=await center(target); await page.mouse.move(after.x,after.y); await page.mouse.down();
 await page.mouse.move(to.x-17,to.y+2,{steps:14}); await page.mouse.up();
 await page.waitForTimeout(150);
 let state=await call('canvas_get_state');
 assert.ok(state.edges.some(e=>e.source==='image3'&&e.target==='qwen'&&e.targetHandle==='references'),'near-handle drag connects');
 // Wrong socket never silently accepts a normal image as mask.
 const maskTarget=page.getByTestId('rf__node-qwen').locator('.react-flow__handle[data-handleid="mask"]');
 await source.click(); await maskTarget.click();
 await page.getByRole('status').filter({hasText:'局部遮罩修改'}).waitFor();
 state=await call('canvas_get_state'); assert.equal(state.edges.some(e=>e.source==='image3'&&e.targetHandle==='mask'),false);
 await source.click();
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('.canvas-connecting').count(),0,'Escape cancels click connection');
 const bad=await call('canvas_connect_nodes',{sourceId:'image3',targetId:'qwen',targetHandle:'mask'});
 assert.equal(bad.ok,false); assert.match(JSON.stringify(bad),/局部遮罩修改/);
 // Two explicit click targets work; changing mode refreshes the real handle geometry.
 const created=await call('canvas_create_node',{preset:'frames_video',x:900,y:40,focus:false}); assert.equal(created.ok,true);
 state=await call('canvas_get_state'); const frames=state.nodes.find(n=>n.mode==='frames');
 await page.mouse.click(1250,950);
 await call('canvas_focus_node',{nodeId:frames.id}); await page.waitForTimeout(400); await clickNode(page,frames.id);
 await page.locator('.creator-modes').getByRole('button',{name:'全能参考',exact:true}).click();
 await page.locator('.creator-modes').getByRole('button',{name:'首尾帧',exact:true}).click();
 assert.equal(await page.getByTestId(`rf__node-${frames.id}`).locator('[data-handleid=first]').count(),1);
 assert.equal(await page.getByTestId(`rf__node-${frames.id}`).locator('[data-handleid=last]').count(),1);
 // API uses the same validation, and repeated single-port connections are idempotent.
 const rendered=await call('canvas_connect_nodes',{sourceId:'renderer',targetId:frames.id,targetHandle:'last'});
 assert.equal(rendered.ok,true); assert.equal(rendered.edge.source,'rendered','generator connects saved visible result, not future run');
 const first=await call('canvas_connect_nodes',{sourceId:'image1',targetId:frames.id,targetHandle:'first'}); assert.equal(first.ok,true);
 const again=await call('canvas_connect_nodes',{sourceId:'image1',targetId:frames.id,targetHandle:'first'}); assert.equal(again.ok,true);
 await call('canvas_update_node',{nodeId:frames.id,title:'video persisted'});
 await page.reload(); await page.waitForFunction(()=>window.fixtureTools.has('canvas_get_state'));
 state=await call('canvas_get_state'); assert.ok(state.edges.some(e=>e.source==='image3'&&e.target==='qwen'));
 assert.ok(state.edges.some(e=>e.source==='rendered'&&e.target===frames.id&&e.targetHandle==='last'));
 await call('canvas_focus_node',{nodeId:frames.id}); await page.waitForTimeout(400);
 const frameNode=page.getByTestId(`rf__node-${frames.id}`);
 const origin=await center(frameNode.locator('.generator-preview'));
 await page.mouse.move(origin.x,origin.y); await page.mouse.wheel(0,1000); await page.waitForTimeout(600);
 const f=await frameNode.locator('[data-handleid=first]').boundingBox(), l=await frameNode.locator('[data-handleid=last]').boundingBox();
 assert.ok(f&&l); assert.ok(f.y+f.height<=l.y,'adjacent ports do not overlap in overview');
 assert.equal(queued.length,0); assert.deepEqual(failures,[]); await context.close();
 console.log('PASS interaction UI: jitter selection, stable enlarged handles, near-socket snapping, invalid feedback, mode ports, API parity and persistence');
} finally {await browser.close();}
