import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { H3_IMAGE_MODEL } from './src/h3-image.js';
import { chromium } from './test-browser.mjs';

// Synthetic browser fixture: every request is intercepted; no live inference/service.
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const origin = 'http://127.0.0.1:8799';
const expectedLocalTool = process.env.H3_EXPECT_LOCAL_TOOL || '';
const expectedLocalTools = process.env.H3_EXPECT_LOCAL_TOOLS
  ? JSON.parse(process.env.H3_EXPECT_LOCAL_TOOLS)
  : expectedLocalTool ? [{ preset: 'identity_edit', label: expectedLocalTool }] : [];
const browser = await chromium.launch({ headless: true });
const failures = [], queued = [];
let missingH3Node = false;
const makeProject = (readOnly = false) => ({ id: 'prj_qwen_fixture', name: 'Qwen references fixture', revision: 1, readOnly, shots: [], canvas: {
  viewport: { x: 20, y: 30, zoom: 0.9 },
  nodes: [
    ...['地编截图', '场景氛围', '手绘笔触'].map((title, i) => ({ id: `image${i + 1}`, type: 'media', position: { x: 20, y: 10 + i * 240 }, data: { kind: 'image', title, remoteName: `${i + 1}.png`, url: `${origin}/fixture-${i + 1}.svg` } })),
    { id: 'qwen', type: 'generator', selected: true, position: { x: 420, y: 40 }, data: { mode: 'qwenEdit', title: '保留的概念设计标题', prompt: '保留图1的路线，使用图2的场景氛围。', qwenSteps: 40, seed: 42, randomSeed: false, status: 'idle' } },
    { id: 'prompt', type: 'prompt', position: { x: -900, y: 0 }, data: { title: 'Prompt fixture', idea: '保留地形' } },
  ], edges: [
    { id: 'old-style', source: 'image2', target: 'qwen', sourceHandle: 'ref', targetHandle: 'identity' },
    { id: 'old-guide', source: 'image1', target: 'qwen', sourceHandle: 'ref', targetHandle: 'guide' },
  ],
} });
async function fixture(readOnly = false, textOnly = false) {
  let project = makeProject(readOnly);
  if (textOnly) { project.canvas.nodes.find(n => n.id === 'qwen').data = {mode:'image',imageModel:'h3_image',title:'H3-Image · 文生图',imageLora:'none',ratio:'1:1',prompt:'A red cup',seed:0,randomSeed:false,status:'idle'}; project.canvas.edges=[]; }
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
    if (url.pathname === '/api/import-video') return json({ name: 'download-fixture.mp4', title: '下载测试视频', sourceUrl: request.postDataJSON().url });
    if (url.pathname === '/api/health') return json({ok:true,comfy:{state:'ready'}});
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') {
      if (request.method() === 'POST') { queued.push(request.postDataJSON()); return json({ id: 'job-fixture', status: 'queued' }); }
      return json({ jobs: [] });
    }
    if (url.pathname.startsWith('/api/comfy/object_info/')) {
      const name = url.pathname.split('/').at(-1);
      if (missingH3Node && name === 'MiniMaxH3ImageConditioning') return json({});
      return json({ [name]: { input: { required: name === 'UNETLoader' ? { unet_name: [[H3_IMAGE_MODEL.unet]] } : name === 'CLIPLoader' ? { clip_name: [[H3_IMAGE_MODEL.clip]], type: [['minimax']] } : name === 'VAELoader' ? { vae_name: [[H3_IMAGE_MODEL.vae]] } : {} } } });
    }
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin); await page.locator('.project-open').click();
  await page.getByLabel(textOnly ? '生图模型' : 'Qwen 模型版本').waitFor();
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  return { page, context, call };
}
try {
 const { page, context, call } = await fixture();
 await page.getByLabel('Qwen 模型版本').selectOption('h3_image');
 await page.getByLabel('H3-Image 输出尺寸').waitFor();
 assert.equal(await page.getByLabel('Qwen 采样步数').count(),0);
 assert.equal(await page.getByLabel('图生图真人化强度').count(),0);
 assert.equal(await page.getByRole('button',{name:'+ 添加遮罩'}).count(),0);
 assert.equal(await page.locator('[data-handleid="mask"]').count(),0);
 await page.getByLabel('H3-Image 输出尺寸').selectOption('16MP');
 let state=await call('canvas_get_state');
 assert.equal(state.nodes.find(n=>n.id==='qwen').qwenModel,'h3_image');
 await call('canvas_update_node',{nodeId:'qwen',settings:{seed:0,randomSeed:false,h3ImageResolution:'4MP'}});
 await page.getByRole('button',{name:'本地生成',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.cancel'));
 assert.equal(queued.length,1);
 assert.equal(queued[0].workflow.sample.inputs.seed,0);
 assert.equal(queued[0].workflow.positive.class_type,'MiniMaxH3ImageConditioning');
 assert.deepEqual(queued[0].workflow.positive.inputs['images.image_1'],['reference_1',0]);
 assert.match(queued[0].workflow.positive.inputs.prompt,/<Picture 1>/);
 await context.close();
 const next=await fixture();
 await next.page.getByLabel('Qwen 模型版本').selectOption('h3_image');
 missingH3Node=true;
 await next.page.getByRole('button',{name:'本地生成',exact:true}).click();
 await next.page.getByText(/H3-Image 还缺少：ComfyUI 节点 MiniMaxH3ImageConditioning/).waitFor();
 assert.equal(queued.length,1,'missing native backend support must not enqueue');
 await next.page.mouse.click(1200,200,{button:'right'});
 const menu=next.page.getByRole('menu',{name:'添加节点'});await menu.waitFor();
 assert.equal(await menu.getByRole('button',{name:/^H3-Image 文生图/}).count(),1);
 assert.equal(await menu.getByRole('button',{name:/^H3-Image 多图编辑/}).count(),1);
 await menu.getByRole('button',{name:/^H3-Image 文生图/}).click();
 state=await next.call('canvas_get_state');
 const created=state.nodes.find(n=>n.title==='H3-Image · 文生图');assert.ok(created);
 assert.equal(created.mode,'image');
 assert.equal(created.imageModel,'h3_image');
 assert.equal(created.h3ImageResolution,'4MP');
 await next.context.close();
 const textFixture=await fixture(false,true);
 assert.equal(await textFixture.page.getByLabel('生图模型').inputValue(),'h3_image');
 assert.equal(await textFixture.page.getByLabel('图片风格').count(),0);
 const textToolbar=textFixture.page.locator('.creator-toolbar:visible');
 assert.ok((await textToolbar.innerText()).includes('6 步 · H3-Image'));
 assert.ok(!(await textToolbar.innerText()).includes('8 步 Turbo'));
 await mkdir('.cache/h3-image',{recursive:true});
 await textFixture.page.screenshot({path:'.cache/h3-image/canvas-h3-image.png'});
 assert.deepEqual(failures,[]);await textFixture.context.close();
 console.log('H3_IMAGE_UI_OK model selection, 4/16MP, ordered connected refs, native queue, dependency blocking, menu shortcuts; isolated synthetic browser');
} finally {await browser.close();}
