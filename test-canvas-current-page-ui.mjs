import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, samePath } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-current-page-ui-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects,
  H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1' };
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
  const project = await request('/api/projects', { name: 'Current page fixture', canvas: {
    nodes: [{ id: 'note', type: 'note', position: { x: 50, y: 100 }, data: { title: 'Reference note', text: 'Before' } },
      { id: 'image', type: 'media', position: { x: 450, y: 100 }, data: { kind: 'image', title: 'Imported asset', url: '' } }], edges: [], viewport: { x: 0, y: 0, zoom: 0.8 },
  } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.project-open').click();
  const active = await until(async () => {
    try { return await request(`/api/agent/canvas/current?projectId=${project.id}`); }
    catch (error) { if (error.code === 'NO_VISIBLE_CANVAS') return null; throw error; }
  });
  assert.equal(active.projectId, project.id);
  assert.equal(await page.evaluate(() => Boolean(document.modelContext?.registerTool)), false, 'bridge works without native WebMCP');
  const command = { ...active, opId: 'edit_current_page', tool: 'canvas_update_node', args: { nodeId: 'note', text: 'Saved through the visible page' } };
  await request('/api/agent/canvas/commands', command);
  const done = await until(async () => {
    const status = await request('/api/agent/canvas/commands/edit_current_page');
    return status.status === 'done' ? status : null;
  });
  assert.equal(done.result.ok, true, JSON.stringify(done.result));
  assert.equal(await page.locator('.react-flow__node[data-id="note"] textarea').inputValue(), command.args.text);
  const saved = await request(`/api/projects/${project.id}`);
  assert.equal(saved.canvas.nodes.find((node) => node.id === 'note').data.text, command.args.text, 'completion means persisted, not only displayed');
  const revision = saved.revision;
  await request('/api/agent/canvas/commands', command);
  await sleep(1800);
  assert.equal((await request(`/api/projects/${project.id}`)).revision, revision, 'duplicate command does not save again');
  assert.equal(context.pages().length, 1, 'the same page handles all commands');
  assert.deepEqual((await request('/api/queue')).jobs, [], 'no real GPU work');
  assert.deepEqual(errors, []);
  console.log('CURRENT_CANVAS_UI_OK samePage=true persisted=true dedup=true nativeWebMcpRequired=false');
} finally {
  if (browser) await browser.close();
  if (base) spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
  if (backend.exitCode === null) backend.kill();
  for (let i = 0; i < 50 && backend.exitCode === null; i += 1) await sleep(100);
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('h3-current-page-ui-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
