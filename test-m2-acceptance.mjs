import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, samePath } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || process.env.PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-m2-acceptance-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const holdMs = Number(process.env.H3_TEST_QUEUE_HOLD_MS || 8000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const upstreamJobs = new Map();
let submissions = 0;
let backend;
let browser;
let base;
let token;
let page;
let upstream;
let env;

function send(response, status, body, type = 'application/json') {
  response.writeHead(status, { 'Content-Type': type });
  response.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function entry(job) {
  return {
    status: { completed: true, status_str: 'success', messages: [] },
    outputs: { save: { images: [{ filename: 'H3_Image_M2_acceptance.png', subfolder: '', type: 'output' }] } },
  };
}

async function startUpstream() {
  upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/system_stats') return send(response, 200, { devices: [] });
    if (request.method === 'GET' && url.pathname === '/queue') {
      const running = [...upstreamJobs.values()].filter((job) => Date.now() - job.createdAt < holdMs).map((job) => [1, job.id]);
      return send(response, 200, { queue_running: running, queue_pending: [] });
    }
    if (request.method === 'POST' && url.pathname === '/prompt') {
      await body(request);
      const id = `prompt-m2-${++submissions}`;
      upstreamJobs.set(id, { id, createdAt: Date.now() });
      return send(response, 200, { prompt_id: id });
    }
    if (request.method === 'GET' && url.pathname === '/view') return send(response, 200, png, 'image/png');
    if (request.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      const job = upstreamJobs.get(id);
      return send(response, 200, job && Date.now() - job.createdAt >= holdMs ? { [id]: entry(job) } : {});
    }
    if (request.method === 'GET' && url.pathname === '/history') {
      const result = {};
      for (const job of upstreamJobs.values()) if (Date.now() - job.createdAt >= holdMs) result[job.id] = entry(job);
      return send(response, 200, result);
    }
    if (request.method === 'POST' && ['/interrupt', '/queue', '/free'].includes(url.pathname)) {
      await body(request);
      return send(response, 200, {});
    }
    return send(response, 404, { error: `fake ComfyUI: ${request.method} ${url.pathname}` });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${upstream.address().port}`;
}

async function startBackend(comfyUrl) {
  env = {
    ...process.env,
    H3_WORKBENCH_RUNTIME_DIR: runtime,
    H3_PROJECTS_ROOT: projects,
    H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'),
    H3_WORKBENCH_NO_BROWSER: '1',
    H3_WORKBENCH_TEST_MODE: '1',
    H3_COMFY_URL: comfyUrl,
  };
  backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  backend.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let instance;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { instance = JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); break; }
    catch { if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}: ${stderr}`); await sleep(100); }
  }
  assert(instance?.pid > 0, 'isolated runtime instance identity');
  base = `http://127.0.0.1:${instance.port}`;
  token = instance.token;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.pid, instance.pid);
  assert(samePath(health.projectsRoot, projects), 'health must prove the unique temporary project root');
}

async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
  for (let count = 0; count < 100 && backend.exitCode === null; count += 1) await sleep(100);
  if (backend.exitCode === null) backend.kill();
}

async function api(route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { ...options.headers, 'X-H3-Token': token } });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
  return result;
}

function json(method, value) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('acceptance condition timed out');
}

async function openProject(name) {
  await page.locator('.project-entry').filter({ hasText: name }).getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('.neo-app').waitFor();
}

try {
  const comfyUrl = await startUpstream();
  await startBackend(comfyUrl);
  const noteNodes = Array.from({ length: 200 }, (_, index) => ({
    id: `note-${index + 1}`, type: 'note', position: { x: (index % 20) * 340, y: Math.floor(index / 20) * 280 },
    data: { title: `备注 ${index + 1}`, text: `200 节点性能夹具 ${index + 1}`, status: 'idle', progress: 0 },
  }));
  await api('/api/projects', json('POST', {
    name: 'M2-200节点', template: 'blank', canvas: { nodes: noteNodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  }));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  const openStarted = Date.now();
  await openProject('M2-200节点');
  await page.locator('.react-flow__node').first().waitFor();
  const openMs = Date.now() - openStarted;
  assert(openMs <= 1000, `200-node project must open within 1s, actual ${openMs}ms`);

  const first = page.locator('.react-flow__node').first();
  const box = await first.boundingBox();
  assert(box, 'first fixture node is visible');
  const dragStarted = Date.now();
  await page.mouse.move(box.x + 5, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 95, box.y + 42, { steps: 24 });
  await page.mouse.up();
  const dragMs = Date.now() - dragStarted;
  assert(dragMs < 2000, `200-node drag must remain responsive, actual ${dragMs}ms`);
  const summaries = await api('/api/projects');
  const performanceId = summaries.projects.find((item) => item.name === 'M2-200节点').id;
  const dragged = await waitFor(async () => {
    const document = await api(`/api/projects/${performanceId}`);
    return document.canvas.nodes.find((node, index) => {
      const original = noteNodes[index].position;
      return node.position.x !== original.x || node.position.y !== original.y;
    })?.position;
  });
  assert(dragged, 'drag gesture is persisted to the project');
  await page.locator('.launcher-return').click();
  await page.getByRole('heading', { name: '最近项目' }).waitFor();

  const generator = {
    id: 'generator-lifecycle', type: 'generator', position: { x: 80, y: 80 },
    data: { title: '后台队列验收', mode: 'image', prompt: '测试后台队列', status: 'idle', progress: 0, seed: 42, ratio: '16:9' },
  };
  const lifecycle = await api('/api/projects', json('POST', {
    name: 'M2-后台队列', template: 'blank', canvas: { nodes: [generator], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  }));
  await page.getByLabel('刷新项目').click();
  await openProject('M2-后台队列');
  await page.locator('.generator-shell').waitFor();
  const job = await api('/api/queue', json('POST', {
    projectId: lifecycle.id, nodeId: generator.id, clientId: 'm2-acceptance', workflow: { 1: { class_type: 'AcceptanceFake', inputs: { seed: 42 } } },
  }));
  await waitFor(async () => (await api(`/api/queue/${job.id}`)).status === 'running');
  await waitFor(async () => {
    const document = await api(`/api/projects/${lifecycle.id}`);
    const current = document.canvas.nodes.find((node) => node.id === generator.id);
    return current?.data.queueJobId === job.id && current?.data.promptId;
  }, 7000);
  await page.close();
  page = null;
  const finished = await waitFor(async () => {
    const current = await api(`/api/queue/${job.id}`);
    return current.status === 'done' ? current : null;
  }, holdMs + 10000);
  assert.equal(finished.progress, 100);
  assert.equal(submissions, 1, 'browser-independent execution submits exactly once');

  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await openProject('M2-后台队列');
  await page.locator('.media-shell img').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.media-shell img').count(), 1, 'completed job materializes its result after reopening');
  await stopBackend();
  await startBackend(comfyUrl);
  const recovered = await api(`/api/queue/${job.id}`);
  assert.equal(recovered.status, 'done');
  assert.equal(recovered.comfyPromptId, finished.comfyPromptId);
  assert.equal(submissions, 1, 'queue restart does not duplicate a completed prompt');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, nodes: 200, openMs, dragMs, browserClosedQueueDone: true, queueRestartRecovered: true, submissions }));
} catch (error) {
  if (page) console.error('M2_ACCEPTANCE_DEBUG', (await page.locator('body').innerText()).slice(0, 4000));
  throw error;
} finally {
  if (browser) await browser.close();
  await stopBackend();
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
