import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// All network traffic is intercepted. Never open a second live project writer.
const origin = 'http://127.0.0.1:8799';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
let project = { id: 'prj_moss_fixture', name: 'Synthetic pose QA', revision: 1, shots: [], canvas: { viewport: { x: 50, y: 15, zoom: 0.85 }, nodes: [
  { id: 'pose', type: 'generator', position: { x: 100, y: 10 }, data: { mode: 'mossPose', title: 'MOSS 姿势控制', prompt: 'A single person in a studio', seed: 42, randomSeed: false } },
  { id: 'input', type: 'media', position: { x: -650, y: 10 }, data: { kind: 'image', remoteName: 'pose.png', title: 'Synthetic pose', url: `${origin}/fixture.svg` } },
], edges: [{ id: 'e1', source: 'input', target: 'pose', sourceHandle: 'ref', targetHandle: 'guide' }] } };
const browser = await chromium.launch({ headless: true });
const errors = [], queued = [];
let bridgeReady = false;
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1040 } });
  await context.addInitScript(() => {
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin);
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/fixture.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><path d="M128 35V150L70 225M128 150L190 225M60 85L128 100L200 85" stroke="cyan" stroke-width="5"/></svg>' });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') return json(project);
    if (url.pathname === `/api/projects/${project.id}`) {
      if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
      return json(project);
    }
    if (url.pathname.startsWith('/api/comfy/object_info/')) return json({}, 404);
    if (url.pathname === '/api/health') return json({ ok: true, comfy: { state: 'ready' } });
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname === '/api/queue') {
      if (request.method() === 'POST') queued.push(request.postDataJSON());
      return json({ jobs: [] });
    }
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/agent/canvas/heartbeat' && bridgeReady) return json({ epoch: 'moss-fixture-epoch' });
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({}, 503);
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('.project-open').click();
  const node = page.getByTestId('rf__node-pose');
  await node.getByLabel('姿势输入').waitFor();
  const connected = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_connect_nodes').execute({ sourceId: 'input', targetId: 'pose' })));
  assert.equal(connected.ok, true, 'page bridge infers the guide port when targetHandle is omitted');
  assert.match(await node.innerText(), /待实测/);
  assert.match(await node.innerText(), /手工安装 comfyui_controlnet_aux/);
  assert.match(await node.innerText(), /不会自动下载/);
  await node.getByLabel('姿势输入').selectOption('skeleton');
  assert.doesNotMatch(await node.innerText(), /照片预处理另需手工安装/);
  await node.getByLabel('姿势输入').selectOption('photo');
  assert.equal(await node.locator('[data-handleid="guide"]').count(), 1);
  assert.equal(await node.locator('[data-handleid="identity"]').count(), 1);
  await node.getByLabel('MOSS 步数').fill('31');
  await node.getByLabel('种子', { exact: true }).fill('123');
  const generate = node.getByRole('button', { name: '生成姿势', exact: true });
  const alert = node.getByRole('alert');
  await generate.click();
  await alert.waitFor();
  assert.match(await alert.innerText(), /没有连接到当前可写画布/);
  assert.equal(queued.length, 0, 'a disconnected canvas cannot enqueue a generation');
  const activeHeartbeat = page.waitForResponse(response => response.ok()
    && new URL(response.url()).pathname === '/api/agent/canvas/heartbeat'
    && response.request().postDataJSON().projectId === project.id);
  bridgeReady = true;
  await activeHeartbeat;
  await generate.click();
  await alert.filter({ hasText: 'H3CheckedDWPose' }).waitFor();
  assert.equal(queued.length, 0, 'missing node cannot enqueue a generation');
  await node.locator('.model-license-notice summary').click();
  assert.match(await node.innerText(), /Apache-2.0/);
  const qa = path.resolve('.cache/feature-dev/qa'); await mkdir(qa, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1600 });
  await page.evaluate(async () => window.fixtureTools.get('canvas_focus_node').execute({ nodeId: 'pose' }));
  await node.screenshot({ path: path.join(qa, 'moss-pose-node.png') });
  assert.deepEqual(errors, []);
  await context.close();
  console.log('MOSS UI: ports, settings, license, missing-node feedback and no enqueue passed.');
} finally { await browser.close(); }
