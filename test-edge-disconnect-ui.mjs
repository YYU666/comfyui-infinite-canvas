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
async function edgePoint(page, id) {
 return page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-interaction`).evaluate((path) => {
   const p = path.getPointAtLength(path.getTotalLength() * .5), matrix = path.getScreenCTM();
   const point = new DOMPoint(p.x, p.y).matrixTransform(matrix); return { x: point.x, y: point.y };
 });
}
try {
 const { page, context, call } = await fixture();
 const edge = page.locator('.react-flow__edge[data-id="old-guide"]');
 const button = page.locator('button.canvas-edge-disconnect[data-edge-id="old-guide"]');
 let point = await edgePoint(page, 'old-guide');
 await page.mouse.move(point.x, point.y); await button.waitFor();
 await page.mouse.click(point.x, point.y);
 assert.match(await edge.getAttribute('class'), /selected/);
 await page.mouse.move(1250, 950); await page.waitForTimeout(300);
 assert.equal(await button.isVisible(), true, 'selected edge keeps actionable button');
 await button.click(); await edge.waitFor({ state: 'detached' });
 assert.equal((await call('canvas_get_state')).nodeCount, 5, 'disconnect never deletes nodes');
 await page.keyboard.press('Control+z'); await edge.waitFor();
 point = await edgePoint(page, 'old-guide');
 await page.keyboard.down('Alt'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Alt');
 await edge.waitFor({ state: 'detached' });
 // Persist and reload: disconnect survives a page reload.
 await call('canvas_update_node', { nodeId: 'qwen', title: 'persist edges' });
 await page.reload(); await page.waitForFunction(() => window.fixtureTools.has('canvas_get_state'));
 assert.equal((await call('canvas_get_state')).edges.some((e) => e.id === 'old-guide'), false);
 await call('canvas_connect_nodes', { sourceId: 'image1', targetId: 'qwen' });
 await call('canvas_update_node', { nodeId: 'qwen', prompt: '编辑图1' });
 await call('canvas_generate_node', { nodeId: 'qwen' });
 const state = await call('canvas_get_state');
 const activeId = state.edges.find((e) => e.source === 'image1' && e.target === 'qwen').id;
 await call('canvas_focus_node', { nodeId: 'qwen' });
 await page.waitForTimeout(400);
 const active = page.locator(`.react-flow__edge[data-id="${activeId}"]`);
 point = await edgePoint(page, activeId);
 await page.mouse.move(point.x, point.y);
 const activeButton = page.locator(`button.canvas-edge-disconnect[data-edge-id="${activeId}"]`);
 await activeButton.click();
 assert.equal(await active.count(), 1, 'busy reference cannot be removed by button');
 await page.keyboard.down('Alt'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Alt');
 assert.equal((await call('canvas_get_state')).edges.some((e) => e.id === activeId), true, 'busy reference cannot be Alt-deleted');
 await context.close();
 const ro = await fixture(true);
 point = await edgePoint(ro.page, 'old-guide'); await ro.page.mouse.move(point.x, point.y);
 assert.equal(await ro.page.locator('.canvas-edge-disconnect').count(), 0);
 await ro.page.keyboard.down('Alt'); await ro.page.mouse.click(point.x, point.y); await ro.page.keyboard.up('Alt');
 assert.equal((await ro.call('canvas_get_state')).edges.length, 2, 'readonly Alt-click preserves graph');
 await ro.context.close();
 assert.deepEqual(failures, []);
 console.log('EDGE_DISCONNECT_OK hover/select/button, Alt-click, undo, saved reload, busy/readonly protected');
} finally { await browser.close(); }
