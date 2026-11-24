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
  assert.ok(instance.pid > 0);
  assert.equal(health.pid, instance.pid);
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
  const submit = (opId, tool, args) => ({ ...active, opId, tool, args });
  const call = async (command) => {
    await request('/api/agent/canvas/commands', command);
    return (await until(async () => {
      const result = await request('/api/agent/canvas/commands/' + command.opId);
      return result.status === 'done' ? result : null;
    })).result;
  };
  const nodeId = 'note';
  const read = await call(submit('read_current_page', 'canvas_get_state', { nodeId, compact: true }));
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.projectId, project.id);
  assert.deepEqual(read.node, { id: nodeId, type: 'note', title: 'Reference note', status: null });
  assert.deepEqual(read.save, { state: 'saved', revision: project.revision });
  assert.equal(read.view.scope, 'local');
  assert.equal('nodes' in read || 'edges' in read, false);
  const text = 'Saved through the visible page';
  const command = submit('edit_current_page', 'canvas_update_node', { nodeId, text, expectedRevision: read.save.revision });
  const done = await call(command);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.changedFields, ['text']);
  assert.equal(done.execution, 'not_requested');
  assert.equal(done.save.state, 'saved');
  assert.equal('node' in done || 'text' in done, false, 'compact edit does not echo content');
  const note = page.locator('.react-flow__node[data-id="note"] textarea');
  assert.equal(await note.inputValue(), text);
  const projectRoute = '/api/projects/' + project.id;
  const saved = await request(projectRoute);
  assert.equal(saved.canvas.nodes.find((node) => node.id === nodeId).data.text, text);
  const revision = saved.revision;
  assert.equal(done.save.revision, revision);
  assert.ok(revision > read.save.revision);
  assert.deepEqual(await call(command), done, 'same opId returns the original receipt');
  const noop = await call(submit('edit_noop', 'canvas_update_node', { nodeId, text, expectedRevision: revision }));
  assert.equal(noop.ok, true, JSON.stringify(noop));
  assert.deepEqual(noop.changedFields, []);
  assert.deepEqual(noop.save, { state: 'unchanged', revision });
  const stale = await call(submit('edit_stale', 'canvas_update_node', { nodeId, text: 'stale edit', expectedRevision: read.save.revision }));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  assert.equal(stale.save.revision, revision);
  assert.equal(await note.inputValue(), text);
  const focused = await call(submit('focus_note', 'canvas_focus_node', { nodeId }));
  assert.equal(focused.ok, true, JSON.stringify(focused));
  assert.equal(focused.focusedNodeId, nodeId);
  assert.equal(focused.view.scope, 'local');
  assert.equal(focused.view.viewport.zoom, 1);
  assert.equal(focused.execution, 'not_requested');
  const afterFocus = await request(projectRoute);
  assert.equal(afterFocus.revision, revision, 'view-only operation does not advance the saved project revision');
  assert.deepEqual(afterFocus.canvas.viewport, saved.canvas.viewport);

  const legacy = await call(submit('legacy_edit', 'canvas_update_node', { nodeId, text: 'Legacy edit' }));
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(legacy.node.id, nodeId);
  const legacyRevision = (await request(projectRoute)).revision;

  await page.route('**' + projectRoute, (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { code: 'FIXTURE_SAVE_FAILED', message: 'Injected save failure' } })
    : route.continue());
  const failed = await call(submit('failed_save', 'canvas_update_node', { nodeId, text: 'Kept in the page', expectedRevision: legacyRevision }));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'FIXTURE_SAVE_FAILED');
  assert.equal(failed.save.state, 'error');
  assert.equal(failed.save.revision, legacyRevision);
  assert.equal(failed.localChangesRetained, true);
  assert.equal(await note.inputValue(), 'Kept in the page');
  const failedFollowup = await call(submit('edit_unsaved_page', 'canvas_update_node', { nodeId, text: 'Forbidden replacement', expectedRevision: legacyRevision }));
  assert.equal(failedFollowup.ok, false);
  assert.equal(failedFollowup.code, 'SAVE_PENDING');
  assert.equal(await note.inputValue(), 'Kept in the page');
  const stillSaved = await request(projectRoute);
  assert.equal(stillSaved.revision, legacyRevision);
  assert.equal(stillSaved.canvas.nodes.find((node) => node.id === nodeId).data.text, 'Legacy edit');
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  assert.ok(bytes(read) < 512 && bytes(done) < 512, 'both compact fixture receipts fit in 512 UTF-8 bytes');
  console.log(JSON.stringify({ compactReadBytes: bytes(read), compactEditBytes: bytes(done) }));
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
