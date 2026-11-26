import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

const origin = 'https://visible-image-tools-fixture.test';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const settings = { mode: 'reference', title: '合成视频节点', prompt: '原始提示词', ratio: '16:9', duration: 5, status: 'idle' };
const projectId = 'prj_image_tools_fixture';
let project = { id: projectId, name: 'Image tools synthetic', revision: 1, readOnly: false, shots: [], canvas: {
  nodes: [
    { id: 'optimizer', type: 'prompt', position: { x: 65, y: 90 }, data: { title: '合成提示词优化', idea: '合成创意', status: 'idle' } },
    { id: 'generator', type: 'generator', position: { x: 580, y: 90 }, data: settings },
  ],
  edges: [{ id: 'e-prompt', source: 'optimizer', target: 'generator', sourceHandle: 'prompt', targetHandle: 'prompt' }],
  viewport: { x: 0, y: 0, zoom: 1 },
} };
const calls = [], unexpected = [], requests = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1650, height: 1100 }, serviceWorkers: 'block' });
  await context.addInitScript(({ key, id }) => {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, id, readOnly: false }));
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) {
      window.fixtureTools.set(tool.name, tool);
      options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name));
    } } });
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  }, { key: PROJECT_SESSION_KEY, id: projectId });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push(request.method() + ' ' + url.pathname);
    assert.equal(url.origin, origin, 'no external provider or user canvas allowed');
    const json = (body, status = 200) => route.fulfill({ json: body, status });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/open') return json(project);
    if (url.pathname === '/api/projects/' + projectId) {
      if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
      return json(project);
    }
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/optimize-prompt') {
      const node = project.canvas.nodes.find(node => node.id === 'optimizer');
      calls.push({ route, payload: request.postDataJSON(), saved: structuredClone(node.data) });
      return;
    }
    if (url.pathname === '/api/queue' && request.method() === 'POST') unexpected.push('generation attempted');
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    if (url.pathname === '/api/settings') return json({ notifications: false, updates: { autoCheck: false } });
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({}, 503);
    if (url.pathname.startsWith('/api/')) return json({});
    const asset = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(asset.startsWith(dist + path.sep));
    return route.fulfill({ body: await readFile(asset), contentType: asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin);
  const optimizer = page.locator('.react-flow__node[data-id="optimizer"]');
  const button = optimizer.getByRole('button', { name: /优化并填入|重新优化并填入/ });
  const until = async (read) => {
    for (let i = 0; i < 160; ++i) {
      const result = read();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Fixture state did not arrive: ' + JSON.stringify({ requests, data: project.canvas.nodes, ui: await optimizer.innerText(), pageErrors }));
  };
  const data = (id) => project.canvas.nodes.find(node => node.id === id).data;
  await button.click();
  const first = await until(() => calls[0]);
  assert.equal(first.saved.imageRun.phase, 'prepared');
  assert.equal(first.saved.imageRun.parameters.targetNodeId, 'generator');
  assert.equal(first.payload.currentPrompt, settings.prompt);
  await first.route.fulfill({ json: { prompt: '模拟改写成功', model: 'stub' } });
  await until(() => data('optimizer').imageRun?.phase === 'done');
  assert.equal(data('generator').prompt, '模拟改写成功');

  await button.click();
  const delayed = await until(() => calls[1]);
  const editResult = await page.evaluate(async () => window.fixtureTools.get('canvas_update_node').execute({
    nodeId: 'generator', prompt: '等待期间我手动修改的提示词',
  }));
  assert.doesNotMatch(JSON.stringify(editResult), /"ok":false/);
  await until(() => data('generator').prompt === '等待期间我手动修改的提示词');
  await delayed.route.fulfill({ json: { prompt: '旧结果不能覆盖新改动', model: 'stub' } });
  await until(() => data('optimizer').imageRun?.phase === 'error');
  assert.equal(data('generator').prompt, '等待期间我手动修改的提示词');
  assert.match(data('optimizer').error, /已变化/);

  await button.click();
  await until(() => calls[2]);
  await page.reload();
  await optimizer.getByRole('button', { name: /重新优化并填入/ }).waitFor();
  await optimizer.getByText(/上次操作随页面中断/).waitFor();
  assert.equal(calls.length, 3, 'reopen must not request the provider again');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(pageErrors, []);
  console.log('IMAGE_VISIBLE_PROMPT_UI_OK saved before request, late response rejected, reopen interrupted without replay');
} finally { await browser.close(); }
