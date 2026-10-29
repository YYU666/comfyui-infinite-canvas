import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || process.env.PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-m2-ui-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects, H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1' };
const backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
let browser;
let base;
let token;
let page;

async function projectDocument(id) {
  const response = await fetch(`${base}/api/projects/${id}`, { headers: { 'X-H3-Token': token } });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  let instance;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { instance = JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); break; }
    catch { if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}`); await sleep(100); }
  }
  assert.equal(instance?.pid, backend.pid, 'isolated backend identity');
  base = `http://127.0.0.1:${instance.port}`;
  token = instance.token;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.pid, backend.pid);
  assert.equal(path.resolve(health.projectsRoot), path.resolve(projects));

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__queueEventSources = [];
    window.__nativeNotifications = [];
    class FakeEventSource {
      constructor() {
        this.listeners = {};
        this.closed = false;
        window.__queueEventSources.push(this);
        setTimeout(() => {
          const jobs = JSON.parse(localStorage.getItem('h3-test-queue-snapshot') || '[]');
          this.emit('queue.snapshot', { jobs, paused: false, concurrency: 1 });
        }, 0);
      }
      addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
      emit(type, payload) { if (!this.closed) for (const listener of this.listeners[type] || []) listener({ data: JSON.stringify(payload) }); }
      close() { this.closed = true; }
    }
    window.__emitQueue = (type, payload) => window.__queueEventSources.forEach((source) => source.emit(type, payload));
    window.EventSource = FakeEventSource;
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title, options) { window.__nativeNotifications.push({ title, ...options }); }
    }
    window.Notification = FakeNotification;
  });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.launcher-new').click();
  await page.getByLabel('项目名称').fill('M2 隔离验收');
  await page.locator('.modal-actions button[type=submit]').click();
  await page.locator('.neo-app').waitFor();
  await page.locator('button[title="添加元素"]').click();
  await page.getByRole('button', { name: /图片素材/ }).click();
  await page.locator('.media-shell input[type=file]').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => document.querySelector('.media-shell img') && document.querySelector('[aria-label="已保存"]'));
  const summaries = await (await fetch(`${base}/api/projects`, { headers: { 'X-H3-Token': token } })).json();
  const projectId = summaries.projects[0].id;
  const before = await projectDocument(projectId);
  const media = before.canvas.nodes.find((node) => node.type === 'media');
  assert(media?.data.assetPath);
  assert.equal(before.assets.length, 1);

  await page.route('**/api/projects/*/assets/*', (route) => route.fulfill({
    status: 507, contentType: 'application/json', body: JSON.stringify({ code: 'INSUFFICIENT_STORAGE', message: '模拟磁盘写满，旧素材保持不变。' }),
  }));
  await page.locator('.media-shell input[type=file]').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: png });
  await page.locator('.project-save-error').waitFor();
  assert.match(await page.locator('.project-save-error').textContent(), /模拟磁盘写满/);
  const after = await projectDocument(projectId);
  const retained = after.canvas.nodes.find((node) => node.id === media.id);
  assert.equal(retained.data.assetPath, media.data.assetPath, 'failed replacement retains the committed asset reference');
  assert.equal(retained.data.name, 'reference.png', 'failed replacement retains the old display name');
  assert.equal(after.assets.length, 1, 'failed replacement adds no asset record');

  const job = { id: 'job_ui_done', projectId: 'notification-only', nodeId: null, kind: 'workflow', status: 'queued', finishedAt: null };
  await page.evaluate((value) => window.__emitQueue('job.queued', { job: value }), job);
  await page.evaluate((value) => window.__emitQueue('job.done', { job: value }), { ...job, status: 'done', finishedAt: '2026-10-29T02:00:00Z' });
  const started = Date.now();
  await page.locator('.queue-toast').filter({ hasText: '生成任务已完成。' }).waitFor({ timeout: 1000 });
  assert(Date.now() - started < 1000, 'completion toast appears within one second');
  await page.locator('.queue-toast').filter({ hasText: '队列已清空' }).waitFor();
  assert(await page.evaluate(() => window.__nativeNotifications.some((item) => item.body === '生成任务已完成。')), 'browser Notification mirrors the completion toast');

  await page.evaluate(() => localStorage.setItem('h3-test-queue-snapshot', JSON.stringify([{ id: 'job_offline', kind: 'outfit', status: 'done', finishedAt: '2026-10-29T02:05:00Z' }])));
  await page.reload();
  await page.locator('.queue-toast').filter({ hasText: '离线期间，换装任务已完成。' }).waitFor({ timeout: 1000 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, assetFailureRetainsReference: true, completionUnder1s: true, browserNotification: true, queueEmpty: true, offlineSummary: true }));
} catch (error) {
  if (page) console.error('M2_UI_DEBUG', (await page.locator('body').innerText()).slice(0, 4000));
  throw error;
} finally {
  if (browser) await browser.close();
  if (base) {
    spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
    for (let count = 0; count < 50 && backend.exitCode === null; count += 1) await sleep(100);
  }
  if (backend.exitCode === null) backend.kill();
  await rm(temporary, { recursive: true, force: true });
}
