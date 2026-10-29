import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || process.env.PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-clipboard-ui-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects, H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'), H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1' };
const backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let backendOutput = '';
backend.stdout.on('data', (chunk) => { backendOutput = `${backendOutput}${chunk}`.slice(-12000); });
backend.stderr.on('data', (chunk) => { backendOutput = `${backendOutput}${chunk}`.slice(-12000); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let base;
let token;
let projectId;
async function api(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { ...options, headers: { 'X-H3-Token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json();
  assert(response.ok, `${pathname}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}
const initialCanvas = {
  nodes: [
    { id: 'fixture-image', type: 'media', position: { x: 100, y: 180 }, data: { kind: 'image', title: '角色', url: '', name: '', mediaStorageId: 'synthetic-media' } },
    { id: 'fixture-generator', type: 'generator', position: { x: 600, y: 200 }, data: { title: '换装', mode: 'qwenEdit', prompt: '@角色 换夏装', seed: 123, randomSeed: false, status: 'done', progress: 100, promptId: 'synthetic-old-task', resultUrl: '', runs: [{ promptId: 'synthetic-old-task' }] } },
  ],
  edges: [{ id: 'fixture-edge', source: 'fixture-image', target: 'fixture-generator', sourceHandle: 'ref', targetHandle: 'guide' }],
  viewport: { x: 0, y: 0, zoom: 0.8 },
};
try {
  let instance;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { instance = JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); break; }
    catch { if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}: ${backendOutput}`); await sleep(100); }
  }
  assert(instance?.pid > 0, 'clipboard test must create an isolated runtime instance');
  base = `http://127.0.0.1:${instance.port}`;
  token = instance.token;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.pid, instance.pid);
  assert.equal(path.resolve(health.projectsRoot), path.resolve(projects), 'health must prove the unique temporary project root');
  const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Clipboard UI fixture', canvas: initialCanvas }) });
  projectId = created.id;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.project-open').click();
  try {
    await page.locator('[data-id="fixture-image"]').waitFor();
  } catch (error) {
    console.error('CLIPBOARD_UI_BOOT_DEBUG', JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 4000) }));
    throw error;
  }

  const readProject = () => api(`/api/projects/${projectId}`);
  const waitForNodeCount = async (count) => {
    await page.waitForTimeout(750);
    const project = await readProject();
    assert.equal(project.canvas.nodes.length, count, `自动保存后应有 ${count} 个节点`);
    return project;
  };

  await page.locator('[data-id="fixture-image"] .media-preview').click();
  await page.locator('[data-id="fixture-generator"] .generator-preview').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.react-flow__node.selected').count(), 2, '多选两个原始节点');
  await page.keyboard.press('Control+d');
  let project = await waitForNodeCount(4);
  assert.equal(project.canvas.edges.length, 2, 'Ctrl+D 同时复制内部连线');
  assert.equal(await page.locator('.react-flow__node.selected').count(), 2, '副本组处于选中状态');
  const firstCopies = project.canvas.nodes.filter((node) => !node.id.startsWith('fixture-'));
  assert.equal(firstCopies.find((node) => node.type === 'generator').data.status, 'idle', '生成副本不带旧完成状态');
  assert.equal(firstCopies.find((node) => node.type === 'generator').data.prompt, '@角色 · 副本 换夏装');

  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  project = await waitForNodeCount(6);
  assert.equal(project.canvas.edges.length, 3, 'Ctrl+C / Ctrl+V 再复制一组节点及连线');
  assert.equal(project.canvas.nodes.filter((node) => node.type === 'generator' && node.data.status === 'idle').length, 2);

  const title = page.locator('.react-flow__node-generator.selected input[aria-label="节点名称"]');
  await title.fill('文本编辑区');
  await title.press('Control+d');
  await title.press('Control+c');
  await title.press('Control+v');
  project = await waitForNodeCount(6);
  assert.equal(project.canvas.edges.length, 3, '输入框内快捷键不操作画布');

  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'clipboard-fixture.png', { type: 'image/png' }));
    const input = document.querySelector('.react-flow__node-generator.selected input[aria-label="节点名称"]');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  project = await waitForNodeCount(6);
  assert.equal(project.canvas.nodes.some((node) => node.data.name === 'clipboard-fixture.png'), false, '文本输入框内粘贴图片不会导入画布');

  await page.evaluate(() => {
    document.activeElement?.blur();
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'clipboard-fixture.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  project = await waitForNodeCount(7);
  const pastedImage = project.canvas.nodes.find((node) => node.data.name === 'clipboard-fixture.png');
  assert.ok(pastedImage, '剪贴板图片优先导入为素材，而不是粘贴旧节点');
  assert.equal(pastedImage.data.kind, 'image');
  assert.equal(pastedImage.data.localFile, true);
  assert.ok(pastedImage.data.assetPath, '粘贴图片使用当前项目的持久化素材路径');
  const storedImage = await fetch(`${base}/api/projects/${projectId}/${pastedImage.data.assetPath}`, { headers: { 'X-H3-Token': token } });
  assert.equal(storedImage.status, 200);
  assert.match(storedImage.headers.get('content-type') || '', /^image\/png/);
  assert.ok((await storedImage.arrayBuffer()).byteLength > 0, '图片文件本体已持久化到隔离项目目录');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.project-open').click();
  await page.getByLabel('画布项目名称', { exact: true }).waitFor();
  await page.locator(`[data-id="${pastedImage.id}"] img`).waitFor({ state: 'visible' });
  project = await readProject();
  assert.equal(project.canvas.nodes.length, 7, '刷新后节点副本和粘贴图片仍存在');
  assert.equal(project.canvas.edges.length, 3, '刷新后副本连线仍存在');
  assert.deepEqual(errors, []);
  console.log('画布剪贴板 UI 测试通过：节点复制粘贴、图片粘贴优先级、文本输入保护、素材持久化及刷新恢复。');
  await context.close();
} finally {
  if (browser) await browser.close();
  if (base) {
    spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
    for (let count = 0; count < 50 && backend.exitCode === null; count += 1) await sleep(100);
  }
  if (backend.exitCode === null) backend.kill();
  for (let count = 0; count < 50 && backend.exitCode === null; count += 1) await sleep(100);
  let removed = false;
  for (let count = 0; count < 30 && !removed; count += 1) {
    try { await rm(temporary, { recursive: true, force: true }); removed = true; }
    catch (error) { if (error.code !== 'EBUSY' || count === 29) throw error; await sleep(200); }
  }
}
