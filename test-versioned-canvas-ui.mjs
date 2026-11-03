import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, samePath } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-versioned-page-ui-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects,
  H3_WORKBENCH_DIST_DIR: process.env.H3_TEST_DIST_DIR || path.join(root, 'dist'), H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1' };
const backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
backend.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-4000); });
let browser;
let base;
let token;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read) => {
  for (let i = 0; i < 150; i += 1) { const value = await read(); if (value) return value; await sleep(100); }
  throw new Error('Isolated current-page test timed out');
};
const request = async (route, payload, method = payload ? 'POST' : 'GET') => {
  const response = await fetch(base + route, { method, headers: { 'X-H3-Token': token,
    ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message), { code: result.code });
  return result;
};
try {
  const instance = await until(async () => {
    try { return JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); }
    catch { if (backend.exitCode !== null) throw new Error(`Isolated backend exited: ${logs}`); return null; }
  });
  token = instance.token;
  base = `http://127.0.0.1:${instance.port}`;
  const health = await request('/api/health');
  assert.equal(health.pid, backend.pid);
  assert.ok(samePath(health.projectsRoot, projects), 'verify isolated project root before writing');
  await assert.rejects(request('/api/agent/canvas/current'), (error) => error.code === 'NO_VISIBLE_CANVAS');
  const source = await request('/api/projects', { name: 'Untouched source fixture', canvas: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4ioAAAAASUVORK5CYII=', 'base64');
  const upload = await fetch(`${base}/api/projects/${source.id}/assets/reference.png`, { method: 'PUT', headers: { 'X-H3-Token': token, 'Content-Type': 'image/png', 'If-Match': String(source.revision) }, body: bytes });
  assert.equal(upload.ok, true);
  const asset = await upload.json();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  const activePage = async (projectId) => until(async () => {
    try { return await request(`/api/agent/canvas/current?projectId=${projectId}`); }
    catch (error) { if (error.code === 'NO_VISIBLE_CANVAS') return null; throw error; }
  });
  let serial = 0;
  const invoke = async (scope, tool, args) => {
    const active = await activePage(scope);
    const opId = `versioned_${++serial}`;
    await request('/api/agent/canvas/commands', { ...active, opId, tool, args });
    const done = await until(async () => {
      const result = await request(`/api/agent/canvas/commands/${opId}`);
      return result.status === 'done' ? result : null;
    });
    assert.equal(done.result.ok, true, JSON.stringify(done.result));
    return done.result;
  };
  const launcher = await invoke('launcher', 'canvas_get_state', {});
  assert.ok(launcher.projects.some((row) => row.id === source.id));
  const created = await invoke('launcher', 'canvas_create_project', { name: 'Versioned native comparison' });
  const id = created.projectId;
  assert.notEqual(id, source.id);
  await activePage(id);
  for (const [index, preset] of ['qwen_edit', 'qwen_turbo_edit', 'image_upscale_7b'].entries()) {
    await invoke(id, 'canvas_create_node', { preset, x: 150 + index * 600, y: 100 });
  }
  const media = await invoke(id, 'canvas_create_node', { preset: 'image_asset', x: 150, y: 700 });
  await invoke(id, 'canvas_import_asset', { nodeId: media.node.id, assetPath: asset.asset.path, sourceProjectId: source.id, name: 'reference.png' });
  const saved = await request(`/api/projects/${id}`);
  assert.equal(saved.canvas.nodes.length, 4);
  const imported = saved.canvas.nodes.find((node) => node.id === media.node.id);
  assert.equal(imported.data.assetPath, asset.asset.path);
  const copy = await fetch(`${base}/api/projects/${id}/${imported.data.assetPath}`, { headers: { 'X-H3-Token': token } });
  assert.deepEqual(Buffer.from(await copy.arrayBuffer()), bytes);
  const generators = saved.canvas.nodes.filter((node) => node.type === 'generator');
  assert.deepEqual(generators.map((node) => node.data.mode), ['qwenEdit', 'qwenEdit', 'imageUpscale']);
  assert.equal(generators[1].data.qwenModel, 'turbo');
  assert.equal(generators[2].data.upscaleModel, 'seedvr2_7b');
  assert.equal((await request(`/api/projects/${source.id}`)).revision, asset.revision, 'source remains untouched');
  await invoke(id, 'canvas_open_project', { projectId: source.id });
  await activePage(source.id);
  assert.equal((await request(`/api/projects/${id}`)).canvas.nodes.length, 4, 'native project switch preserves saved comparison');
  assert.equal(context.pages().length, 1, 'create, import and reopen all use the same fixture page');
  assert.deepEqual((await request('/api/queue')).jobs, [], 'no real GPU work');
  assert.deepEqual(errors, []);
  console.log('VERSIONED_CANVAS_UI_OK launcher=true create=true versionedNodes=true crossProjectImport=true samePage=true');
} finally {
  if (browser) await browser.close();
  if (base) spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
  if (backend.exitCode === null) backend.kill();
  for (let i = 0; i < 50 && backend.exitCode === null; i += 1) await sleep(100);
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('h3-versioned-page-ui-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
