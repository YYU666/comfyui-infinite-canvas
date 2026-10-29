import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || process.env.PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-m3-ui-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const simulatedPromptId = 'm3-simulated-generation';
const upstream = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const send = (status, body, type = 'application/json') => { response.writeHead(status, { 'Content-Type': type }); response.end(type === 'application/json' ? JSON.stringify(body) : body); };
  if (url.pathname === '/prompt') return send(200, { prompt_id: simulatedPromptId });
  if (url.pathname === `/history/${simulatedPromptId}`) return send(200, { [simulatedPromptId]: { status: { completed: true, status_str: 'success', messages: [] }, outputs: { save: { images: [{ filename: 'H3_Image_M3_simulated.png', subfolder: '', type: 'output' }] } } } });
  if (url.pathname === '/queue') return send(200, { queue_running: [], queue_pending: [] });
  if (url.pathname === '/view') return send(200, png, 'image/png');
  return send(200, {});
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects, H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1', H3_COMFY_URL: `http://127.0.0.1:${upstream.address().port}` };
const backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
let browser; let base; let token; let page;

async function api(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { ...options, headers: { 'X-H3-Token': token, ...(options.body && !(options.body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json();
  assert(response.ok, `${pathname}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}
async function document(id) { return api(`/api/projects/${id}`); }
async function openCreative() { await page.locator('button[title="角色、镜头与审片"]').click(); await page.locator('.creative-panel').waitFor(); }
async function createLibrary(collection, name) {
  await page.locator('.creative-library-tabs').getByRole('button', { name: new RegExp(collection) }).click();
  await page.getByRole('button', { name: `新建${collection}`, exact: true }).click();
  await page.locator('.creative-editor').getByLabel('名称').fill(name);
  if (collection === '场景') await page.locator('.creative-editor').getByLabel('描述 / 提示词').fill('雨夜霓虹与湿地反光');
  await page.locator('.creative-editor button[type=submit]').click();
  await page.locator('.creative-editor').waitFor({ state: 'detached' });
}

try {
  let instance;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { instance = JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); break; }
    catch { if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}`); await sleep(100); }
  }
  base = `http://127.0.0.1:${instance.port}`; token = instance.token;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.launcher-new').click();
  await page.getByLabel('项目名称').fill('M3 隔离验收');
  await page.locator('.modal-actions button[type=submit]').click();
  await page.locator('.neo-app').waitFor();
  const summaries = await api('/api/projects'); const projectId = summaries.projects[0].id;

  await openCreative();
  await page.locator('.creative-tabs').getByRole('button', { name: '素材库', exact: true }).click();
  await createLibrary('角色', '女主');
  await createLibrary('服装', '黑色风衣');
  await createLibrary('场景', '旧街');
  await page.locator('.creative-tabs').getByRole('button', { name: '镜头', exact: true }).click();
  await page.getByRole('button', { name: '新建镜头', exact: true }).click();
  const editor = page.locator('.creative-editor');
  await editor.getByLabel('名称').fill('雨夜追逐');
  await editor.getByLabel('提示词').fill('女主在雨夜旧街奔跑，镜头跟随');
  await editor.locator('select[name=characterId]').selectOption('c1');
  await editor.locator('select[name=outfitId]').selectOption('o1');
  await editor.locator('select[name=locationId]').selectOption('l1');
  await editor.getByLabel('标签').fill('雨夜，追逐');
  await editor.locator('button[type=submit]').click();
  await editor.waitFor({ state: 'detached' });
  let doc = await document(projectId);
  assert.equal(doc.shots[0].characterId, 'c1'); assert.equal(doc.shots[0].outfitId, 'o1'); assert.equal(doc.shots[0].locationId, 'l1');

  const uploaded = await api(`/api/projects/${projectId}/assets/take.png`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
  let revision = uploaded.revision;
  for (let index = 0; index < 6; index += 1) {
    const result = await api(`/api/projects/${projectId}/shots/s1/takes`, { method: 'POST', body: JSON.stringify({ asset: uploaded.asset.path, recipe: { seed: index }, notes: index === 0 ? '雨夜备选' : '', revision }) });
    revision = result.project.revision;
  }
  await page.locator('.creative-tabs').getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByLabel('搜索项目创作内容').fill('雨夜');
  await page.locator('.creative-search button').click();
  await page.locator('.creative-search-results').getByText(/雨夜追逐/).first().waitFor();

  await page.reload(); await page.locator('.project-open').click(); await page.locator('.neo-app').waitFor(); await openCreative();
  await page.locator('.creative-tabs').getByRole('button', { name: '审片', exact: true }).click();
  await page.locator('.creative-compare article').first().waitFor();
  assert.equal(await page.locator('.creative-compare article').count(), 4, 'four takes fit the comparison grid');
  assert.equal(await page.locator('.creative-take-list > article').count(), 6);
  await page.getByRole('button', { name: 't2 5 星', exact: true }).click();
  await page.locator('.creative-take-list > article').filter({ hasText: 't2' }).getByRole('button', { name: '选用', exact: true }).click();
  await page.locator('.creative-take-list > article').filter({ hasText: 't3' }).getByRole('button', { name: '选用', exact: true }).click();
  await page.locator('.creative-notice').filter({ hasText: 't3 已选用' }).waitFor();
  doc = await document(projectId);
  assert.deepEqual(doc.shots[0].takes.filter((take) => take.selected).map((take) => take.id), ['t3']);
  assert.equal(doc.shots[0].takes.find((take) => take.id === 't2').rating, 5);
  await page.locator('.creative-panel').focus(); await page.keyboard.press('ArrowRight');
  await page.locator('.creative-take-list > article').filter({ hasText: 't1' }).getByRole('button', { name: '淘汰', exact: true }).click();

  await page.getByRole('button', { name: '关闭创作层', exact: true }).click();
  await page.locator('button[title="添加元素"]').click();
  await page.getByRole('button', { name: /本地生图/ }).click();
  await page.locator('.react-flow__node-generator').click();
  await page.locator('.react-flow__node-generator.selected').waitFor();
  await openCreative();
  await page.getByRole('button', { name: '将选中生成节点提升为镜头', exact: true }).click();
  await page.locator('.creative-shot').filter({ hasText: 'S02' }).waitFor();
  await page.getByRole('button', { name: '编辑本地生图', exact: true }).click();
  await page.locator('.creative-editor').getByLabel('提示词').fill('雨夜中的角色定妆图');
  await page.locator('.creative-editor select[name=characterId]').selectOption('c1');
  await page.locator('.creative-editor select[name=outfitId]').selectOption('o1');
  await page.locator('.creative-editor select[name=locationId]').selectOption('l1');
  await page.locator('.creative-editor button[type=submit]').click();
  await page.locator('.creative-editor').waitFor({ state: 'detached' });
  doc = await document(projectId);
  assert.equal(doc.shots.length, 2); assert(doc.shots[1].canvasNodeId);
  assert.equal(doc.shots[1].characterId, 'c1'); assert.equal(doc.shots[1].outfitId, 'o1'); assert.equal(doc.shots[1].locationId, 'l1');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    doc = await document(projectId);
    if (doc.canvas.nodes.find((node) => node.id === doc.shots[1].canvasNodeId)?.data.shotId === 's2') break;
    await sleep(100);
  }
  assert.equal(doc.canvas.nodes.find((node) => node.id === doc.shots[1].canvasNodeId).data.shotId, 's2');
  const mediaCount = doc.canvas.nodes.filter((node) => node.type === 'media').length;
  await api('/api/queue', { method: 'POST', body: JSON.stringify({ workflow: { simulated: { class_type: 'M3Test', inputs: {} } }, projectId, nodeId: doc.shots[1].canvasNodeId, clientId: 'm3-isolated-test' }) });
  for (let attempt = 0; attempt < 70; attempt += 1) {
    doc = await document(projectId);
    if (doc.shots[1].takes.length === 1) break;
    await sleep(100);
  }
  assert.equal(doc.shots[1].takes.length, 1, 'generated result enters the bound shot take stack');
  assert.equal(doc.shots[1].takes[0].recipe.output.filename, 'H3_Image_M3_simulated.png');
  assert.equal(doc.canvas.nodes.filter((node) => node.type === 'media').length, mediaCount, 'bound generation does not add a media node');
  assert.equal(doc.assets.length, 1, 'ComfyUI output is referenced without an early project asset copy');

  await page.reload(); await page.locator('.project-open').click(); await page.locator('.neo-app').waitFor(); await openCreative();
  await page.locator('.creative-tabs').getByRole('button', { name: '审片', exact: true }).click();
  doc = await document(projectId);
  assert.equal(doc.shots[0].takes.find((take) => take.id === 't3').selected, true);
  assert.equal(doc.shots[0].takes.find((take) => take.id === 't1').rejected, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, libraries: 3, linkedShot: true, takes: 6, compared: 4, selected: 't3', search: true, promotedShot: 's2', persistent: true }));
} catch (error) {
  if (page) console.error('M3_UI_DEBUG', (await page.locator('body').innerText()).slice(0, 5000));
  throw error;
} finally {
  if (browser) await browser.close();
  if (base) {
    spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
    for (let count = 0; count < 50 && backend.exitCode === null; count += 1) await sleep(100);
  }
  if (backend.exitCode === null) backend.kill();
  await new Promise((resolve) => upstream.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
