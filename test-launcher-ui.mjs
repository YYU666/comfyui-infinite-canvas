import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, samePath } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || process.env.PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-launcher-ui-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects, H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1' };
const backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
let base;
let token;
let page;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(route, options = {}) {
  const headers = { ...options.headers, 'X-H3-Token': token };
  const response = await fetch(`${base}/api/projects${route}`, { ...options, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
function json(method, value) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }; }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

try {
  let instance;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { instance = JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); break; }
    catch { if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}`); await sleep(100); }
  }
  assert(instance?.port, 'dynamic instance port');
  assert(instance.pid > 0, 'isolated runtime instance PID');
  base = `http://127.0.0.1:${instance.port}`;
  token = instance.token;
  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { health = await response.json(); break; }
    } catch { /* wait */ }
    await sleep(100);
  }
  assert(health?.ok, 'isolated backend health');
  assert.equal(health.pid, instance.pid, `health must belong to the isolated runtime: ${JSON.stringify({ health, instancePid: instance.pid, base })}`);
  assert.equal(typeof health.projectsRoot, 'string', `test health must expose isolated root: ${JSON.stringify(health)}`);
  assert(samePath(health.projectsRoot, projects), 'backend must use isolated projects root before any UI write');
  const emptyQueueResponse = await fetch(`${base}/api/queue`, { headers: { 'X-H3-Token': token } });
  assert.equal(emptyQueueResponse.status, 200, 'queue API is available in the isolated backend');
  assert.deepEqual((await emptyQueueResponse.json()).jobs, [], 'isolated queue starts empty');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('heading', { name: '最近项目' }).waitFor();
  assert.equal(await page.locator('.launcher-shell').count(), 1);

  await page.locator('.launcher-new').click();
  await page.getByLabel('项目名称').fill('验收项目');
  await page.getByLabel('项目模板').selectOption('outfit');
  await page.locator('.modal-actions button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.neo-app') || document.querySelector('.launcher-notice.error'));
  const createError = await page.locator('.launcher-notice.error').allTextContents();
  if (createError.length) {
    console.error('CREATE_DEBUG_ROWS', JSON.stringify({ projectsRoot: projects, rows: await api('') }));
    console.error('CREATE_DEBUG_DISK', await readdir(projects).catch((error) => error.code));
  }
  assert.equal(createError.length, 0, createError.join('\n'));
  await page.locator('.neo-app').waitFor();
  assert.equal(await page.getByLabel('画布项目名称').inputValue(), '验收项目');
  await page.locator('button[title="添加元素"]').click();
  await page.getByRole('button', { name: /图片素材/ }).click();
  await page.locator('.media-shell input[type=file]').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: png });
  await sleep(1800);
  let rows = await api('');
  let document = await api(`/${rows.projects.find((item) => item.name === '验收项目').id}`);
  const projectId = document.id;
  const mediaNode = document.canvas.nodes.find((node) => node.type === 'media');
  assert(mediaNode?.data.assetPath, 'assetPath persisted after upload');
  assert.equal(document.assets.length, 1);
  assert(document.revision >= 3, 'asset and canvas revisions advance without 409');
  const committedRevision = (await api(`/${projectId}`)).revision;
  const asset = await fetch(`${base}/api/projects/${projectId}/${mediaNode.data.assetPath}`, { headers: { Range: 'bytes=1-4', 'X-H3-Token': token } });
  assert.equal(asset.status, 206);

  await page.locator('.launcher-return').click();
  await page.getByRole('heading', { name: '最近项目' }).waitFor();
  await page.close();
  assert((await fetch(`${base}/api/health`)).ok, 'service remains after browser tab closes');
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.project-entry').filter({ hasText: '验收项目' }).getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('.neo-app').waitFor();
  await sleep(700);
  assert.equal(await page.locator('.media-shell img').count(), 1, 'uploaded image restored from disk');
  assert((await page.locator('.media-shell img').getAttribute('src')).startsWith('blob:'));
  const reopenedDocument = await api(`/${projectId}`);
  assert.deepEqual(reopenedDocument.canvas, document.canvas, 'reopening must not alter canvas content');
  assert.equal(reopenedDocument.revision, committedRevision, 'reopening an unchanged project must not increment revision');

  await page.locator('button[title="添加元素"]').click();
  await page.getByRole('button', { name: /文本备注/ }).click();
  assert.equal(await page.locator('.note-shell textarea').count(), 1, 'note added');
  await page.locator('.react-flow__pane').click({ position: { x: 1100, y: 700 } });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => document.querySelectorAll('.note-shell textarea').length === 0);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => document.querySelectorAll('.note-shell textarea').length === 1);
  const noteInput = page.locator('.note-shell textarea');
  await noteInput.fill('输入框不拦截');
  await noteInput.press('Control+z');
  assert.equal(await page.locator('.note-shell textarea').count(), 1, 'input Ctrl+Z must not undo canvas addition');

  await page.locator('.launcher-return').click();
  await page.locator('.project-entry').filter({ hasText: '验收项目' }).click();
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByLabel('项目名称').fill('验收项目-改名');
  await page.locator('.modal-actions button[type=submit]').click();
  await page.getByText('项目已重命名。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '创建副本', exact: true }).click();
  await page.getByText('项目副本已创建。', { exact: true }).waitFor();
  rows = await api('');
  assert(rows.projects.some((item) => item.name === '验收项目-改名 副本'));

  await page.locator('.project-entry').filter({ hasText: '验收项目-改名' }).first().click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).last().click();
  await page.locator('.modal-actions button[type=submit]').click();
  await page.getByText('项目已移入回收站，可随时恢复。', { exact: true }).waitFor();
  await page.locator('.launcher-sidebar nav').getByRole('button', { name: /回收站/ }).click();
  await page.locator('.project-entry').filter({ hasText: '验收项目-改名' }).getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByText('项目已恢复。', { exact: true }).waitFor();
  rows = await api('');
  assert(rows.projects.some((item) => item.name === '验收项目-改名'));

  await page.evaluate(async (bytes) => {
    const open = (name, stores) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => stores.forEach((store) => request.result.createObjectStore(store, store === 'projects' ? { keyPath: 'id' } : undefined));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    const db = await open('h3-canvas-projects', ['projects', 'settings']);
    const tx = db.transaction('projects', 'readwrite');
    for (let index = 1; index <= 3; index += 1) tx.objectStore('projects').put({
      id: `legacy-${index}`, name: `旧浏览器项目-${index}`, revision: 0, createdAt: 1, updatedAt: 2,
      canvas: { nodes: [
        { id: `media-${index}`, type: 'media', position: { x: 0, y: 0 }, data: { kind: 'image', localFile: true, mediaStorageId: `media-${index}`, url: 'blob:old' } },
        { id: `note-${index}`, type: 'note', position: { x: 200, y: 0 }, data: { text: `保留提示词-${index}` } },
      ], edges: [{ id: `edge-${index}`, source: `media-${index}`, target: `note-${index}` }], viewport: { x: 0, y: 0, zoom: 1 } },
    });
    await done(tx); db.close();
    const media = await open('h3-workbench-media', ['files']);
    const files = media.transaction('files', 'readwrite');
    for (let index = 1; index <= 3; index += 1) files.objectStore('files').put(new File([new Uint8Array(bytes)], `legacy-${index}.png`, { type: 'image/png' }), `legacy-${index}/media-${index}`);
    await done(files); media.close();
  }, [...png]);
  await page.reload();
  await page.getByText('发现 3 个旧浏览器项目', { exact: true }).waitFor();
  await page.getByRole('button', { name: '迁移到项目文件夹' }).click();
  await page.getByText('已迁移 3 个浏览器项目，原记录与 ZIP 备份均已保留。', { exact: true }).waitFor({ timeout: 30000 });
  rows = await api('');
  for (let index = 1; index <= 3; index += 1) {
    const summary = rows.projects.find((item) => item.name === `旧浏览器项目-${index}`);
    assert(summary, `legacy ${index} listed`);
    const migrated = await api(`/${summary.id}`);
    assert.equal(migrated.canvas.nodes.length, 2);
    assert.equal(migrated.canvas.edges.length, 1);
    assert.equal(migrated.canvas.nodes[1].data.text, `保留提示词-${index}`);
    assert.equal(migrated.assets.length, 1);
    assert(migrated.canvas.nodes[0].data.assetPath);
  }
  assert.equal((await readdir(path.join(projects, '.migration-backups'))).length, 3);
  const legacyRecords = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('h3-canvas-projects', 1);
    request.onsuccess = () => { const db = request.result; const get = db.transaction('projects').objectStore('projects').getAll(); get.onsuccess = () => resolve(get.result.length); get.onerror = () => reject(get.error); };
    request.onerror = () => reject(request.error);
  }));
  assert.equal(legacyRecords, 3, 'IndexedDB source retained');

  for (let index = 0; index < 100; index += 1) await api('', json('POST', { name: `批量-${String(index).padStart(3, '0')}`, template: 'blank' }));
  await page.reload();
  await page.locator('.launcher-sidebar nav').getByRole('button', { name: /全部项目/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.project-entry').length >= 100);
  assert((await page.locator('.project-entry').count()) >= 100);
  await page.getByLabel('搜索项目').fill('批量-099');
  await page.waitForFunction(() => document.querySelectorAll('.project-entry').length === 1);
  assert.equal(await page.locator('.project-entry').count(), 1);
  await page.getByLabel('网格视图').click();
  assert.equal(await page.locator('.project-collection.grid').count(), 1);
  await page.getByLabel('列表视图').click();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ ok: true, launcher: true, reopen: true, assetRange: true, trash: true, migration3: true, projects100: true, browserCloseKeepsService: true }));
} catch (error) {
  console.error('UI_TEST_ERROR', error);
  if (page) console.error('UI_FAILURE_DEBUG', JSON.stringify({ url: page.url(), errors, text: (await page.locator('body').innerText()).slice(0, 5000) }));
  throw error;
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
