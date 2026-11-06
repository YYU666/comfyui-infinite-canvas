import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
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
    if (url.pathname === '/api/import-video') return json({ name: 'download-fixture.mp4', title: '下载测试视频', sourceUrl: request.postDataJSON().url });
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
try {
 const { page, context, call } = await fixture();
 await page.mouse.click(1200, 200, { button: 'right' });
 const menu = page.getByRole('menu', { name: '添加节点' }); await menu.waitFor();
 assert.equal(await menu.getByRole('button', { name: /^视频生成/ }).count(), 1);
 assert.equal(await menu.getByRole('button', { name: /^文生图/ }).count(), 1);
 assert.doesNotMatch(await menu.innerText(), /提示词优化|本地生图/);
 if (!expectedLocalTools.length) {
   assert.doesNotMatch(await menu.innerText(), /四视图/);
   assert.equal(await menu.getByRole('button',{name:/^母图编辑|^角色替换|^角色四视图/}).count(),0);
 }
 assert.ok((await menu.innerText()).includes('第三方工具'));
 assert.equal(await menu.getByRole('button',{name:/^已安装的节点工具/}).count(),1);
 const groups = await menu.evaluate((element) => {
   let group = ''; const result = {};
   for (const child of element.children) {
     if (child.classList.contains('add-menu-title')) { group = child.textContent; result[group] = []; }
     else if (child.tagName === 'BUTTON') result[group]?.push(child.querySelector('span')?.firstChild?.textContent || child.textContent);
   }
   return result;
 });
 for (const name of ['图片调色', '图像混合', 'RGBA 通道合并']) assert.ok(groups['官方节点'].includes(name), `${name} belongs to official nodes`);
 assert.deepEqual(groups['第三方工具'], [...expectedLocalTools.map(tool => tool.label), '已安装的节点工具']);
 for (const tool of expectedLocalTools) assert.ok(!groups['官方节点'].includes(tool.label), `${tool.label} stays in third-party tools`);
 if (!expectedLocalTools.length) {
   const qa = path.resolve('.cache/feature-dev/qa'); await mkdir(qa, {recursive:true});
   await menu.screenshot({path:path.join(qa,'node-classification-official.png')});
   await menu.evaluate((element) => { element.scrollTop = element.scrollHeight; });
   await menu.screenshot({path:path.join(qa,'node-classification-third-party.png')});
   await menu.evaluate((element) => { element.scrollTop = 0; });
 }
 await menu.getByRole('button', { name: /^视频生成/ }).click();
 let state = await call('canvas_get_state');
 const video = state.nodes.find(n => n.mode === 'reference'); assert.equal(video.title, '视频生成');
 await page.waitForTimeout(500);
 await call('canvas_focus_node', { nodeId: video.id }); await page.waitForTimeout(500);
 await page.getByTestId(`rf__node-${video.id}`).locator('.neo-node-title').click({ position: {x: 10, y: 10} });
 await call('canvas_focus_node', { nodeId: video.id }); await page.waitForTimeout(500);
 assert.deepEqual(await page.locator('.creator-modes > button').allTextContents(), ['全能参考', '首尾帧']);
 await page.locator('.creator-modes').getByRole('button', {name:'首尾帧', exact:true}).click();
 state = await call('canvas_get_state', {nodeId: video.id});
 assert.equal(state.nodes[0].mode, 'frames'); assert.equal(state.nodes[0].title, '视频生成');
 await page.locator('.creator-modes').getByRole('button', {name:'全能参考', exact:true}).click();
 const download = await call('canvas_create_node', {preset:'video_download', x:4000, y:0}); assert.equal(download.ok, true);
 state = await call('canvas_get_state'); const dn = state.nodes.find(n => n.title === '视频链接下载'); assert.ok(dn);
 await page.waitForTimeout(500); await call('canvas_focus_node', {nodeId:dn.id}); await page.waitForTimeout(500);
 const node = page.getByTestId(`rf__node-${dn.id}`);
 await node.getByPlaceholder('粘贴抖音 / 小红书分享文字或链接').fill('https://example.com/video');
 await node.getByRole('button', {name:'加载视频链接'}).click();
 await page.waitForFunction(() => document.querySelectorAll('.video-url-error').length === 0);
 let found;
 for (let i=0;i<30;i++) { state=await call('canvas_get_state'); found=state.nodes.find(n=>n.title==='下载测试视频'); if(found)break; await page.waitForTimeout(100); }
 assert.ok(found, 'download creates media despite existing image generator');
 assert.equal(found.kind, 'video');
 assert.equal(queued.length,0,'no generation submitted');
 for (const preset of ['color_adjust', 'color_hsl', 'color_levels', 'color_curves', 'image_blend', 'rgba_pack']) {
   const created = await call('canvas_create_node', {preset, x:6000, y:0, focus:false});
   assert.equal(created.ok,true,`official image preset ${preset} is available`);
   assert.equal(created.node.type,'imageProcess');
 }
 for (const preset of ['identity_edit','character_swap','character_sheet','local_realism','outfit_edit','outfit_qwen21_turbo','outfit_qwen21_turbo_7b','outfit_muse_v4']) {
   const created = await call('canvas_create_node', {preset,x:7000,y:0,focus:false});
   assert.equal(created.ok,expectedLocalTools.some(tool => tool.preset === preset),`only explicitly registered local tools can create ${preset}`);
 }
 await call('canvas_update_node', {nodeId:dn.id,title:'视频链接下载'});
 await page.reload(); await page.waitForFunction(() => window.fixtureTools.has('canvas_get_state'));
 state=await call('canvas_get_state'); assert.ok(state.nodes.some(n=>n.title==='下载测试视频'));
 assert.ok(state.nodes.some(n=>n.title==='视频链接下载'));
 assert.deepEqual(failures, []); await context.close();
 console.log(`OFFICIAL_NODES_OK official photo/blend/RGBA grouping, public/local isolation, video modes, download import persisted, no generation localTools=${expectedLocalTools.length}`);
} finally {await browser.close();}
