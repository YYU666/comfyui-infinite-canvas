import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// Isolated browser storage, synthetic notes and text files only. This server
// never touches the running canvas, browser profiles, models or generation API.
const source = await readFile(new URL('./src/canvas-projects.js', import.meta.url));
const buildArg = process.argv.indexOf('--ui-build');
const uiBuild = buildArg >= 0 ? path.resolve(process.argv[buildArg + 1]) : null;
const server = createServer(async (request, response) => {
  if (request.url === '/canvas-projects.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(source); return; }
  if (request.url === '/storage-tests.html') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Project storage tests</title>'); return; }
  if (uiBuild) {
    const filename = new URL(request.url, 'http://localhost').pathname;
    const target = path.resolve(uiBuild, filename === '/' ? 'index.html' : `.${filename}`);
    if (target !== uiBuild && !target.startsWith(`${uiBuild}${path.sep}`)) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(target);
      response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(body); return;
    } catch { response.writeHead(404).end(); return; }
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Project storage tests</title>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/storage-tests.html`);
  const checks = await page.evaluate(async () => {
    const api = await import('/canvas-projects.js');
    const checks = [];
    const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
    const canvas = { nodes: [{ id: 'note-a', type: 'note', position: { x: 50, y: 60 }, data: { text: 'Synthetic project' } }], edges: [], viewport: { x: 17, y: 23, zoom: 0.8 } };
    const empty = () => ({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
    const original = JSON.stringify(canvas);
    localStorage.setItem(api.LEGACY_CANVAS_KEY, original);
    localStorage.setItem('h3-canvas-name-v1', 'Imported project');
    const first = await api.initializeProjects(empty);
    check(first.name === 'Imported project' && first.canvas.nodes.length === 1 && first.legacyMedia, 'legacy canvas and name migrate');
    check(JSON.stringify(first.canvas.viewport) === JSON.stringify(canvas.viewport), 'legacy viewport preserved');
    check(localStorage.getItem(api.LEGACY_CANVAS_KEY) === original, 'migration preserves legacy snapshot');
    const initializedAgain = await api.initializeProjects(empty);
    check(initializedAgain.id === first.id && (await api.listProjects()).length === 1, 'bootstrap is idempotent');

    const mediaDb = await new Promise((resolve, reject) => {
      const r = indexedDB.open('h3-workbench-media', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = mediaDb.transaction('files', 'readwrite');
      tx.objectStore('files').put(new File(['original media'], 'original.txt', { type: 'text/plain' }), 'reference-image');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    mediaDb.close();
    const second = await api.createProject('Second project', empty());
    check((await api.readProjectFile(second, 'reference-image')) === undefined, 'new projects cannot read legacy default node media');
    check(await (await api.readProjectFile(first, 'reference-image')).text() === 'original media', 'imported project can read legacy media');
    await api.saveProjectFile(second.id, 'reference-image', new File(['second media'], 'second.txt'));
    await api.saveProjectFile(first.id, 'reference-image', new File(['first replacement'], 'first.txt'));
    check(await (await api.readProjectFile(second, 'reference-image')).text() === 'second media', 'same node IDs have independent files');
    check(await (await api.readProjectFile(first, 'reference-image')).text() === 'first replacement', 'scoped media takes precedence over legacy');
    await api.deleteProjectFile(second.id, 'reference-image');
    check((await api.readProjectFile(second, 'reference-image')) === undefined && await (await api.readProjectFile(first, 'reference-image')).text() === 'first replacement', 'deleting one project file preserves other projects');
    await api.deleteProjectFile(first.id, 'reference-image');
    check(await (await api.readProjectFile(first, 'reference-image')).text() === 'original media', 'original unscoped media is never deleted');

    await api.openProject(second.id);
    let saved = await api.saveProject(second.id, second.revision, 'Renamed project', empty());
    const reopened = await api.openProject(second.id);
    check(reopened.name === 'Renamed project' && reopened.canvas.nodes.length === 0 && reopened.canvas.edges.length === 0, 'rename and empty canvas persist');
    check((await api.initializeProjects(() => canvas)).id === second.id, 'active project persists independently of legacy cache');
    let staleRejected = false;
    try { await api.saveProject(second.id, second.revision, 'Stale overwrite', canvas); }
    catch (error) { staleRejected = error.message.includes('另一个窗口'); }
    check(staleRejected && (await api.openProject(second.id)).name === 'Renamed project', 'revision conflict rejects stale-tab overwrite');

    const oldPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects') throw new DOMException('Simulated storage failure', 'QuotaExceededError');
      return oldPut.apply(this, args);
    };
    let failed = false;
    try { await api.saveProject(second.id, saved.revision, 'Lost write', canvas); }
    catch (error) { failed = error.name === 'QuotaExceededError'; }
    finally { IDBObjectStore.prototype.put = oldPut; }
    check(failed && (await api.openProject(second.id)).name === 'Renamed project', 'failed storage write leaves committed project intact');

    const oldSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException('Full compatibility cache', 'QuotaExceededError'); };
    try { saved = await api.saveProject(second.id, saved.revision, 'Durable project', canvas); }
    finally { Storage.prototype.setItem = oldSet; }
    check((await api.openProject(second.id)).name === 'Durable project', 'full compatibility cache cannot invalidate IndexedDB save');

    const recoveryCanvas = { ...canvas, nodes: [...canvas.nodes, { id: 'recovered-note', type: 'note', position: { x: 300, y: 80 }, data: { text: 'Recovered synthetic note' } }] };
    localStorage.setItem(api.LEGACY_CANVAS_KEY, JSON.stringify(recoveryCanvas));
    localStorage.setItem('h3-canvas-name-v1', 'Recovered project');
    localStorage.setItem('h3-canvas-recovery-receipt-v1', JSON.stringify({ source: 'Kimi Work', sourceSequence: 2, nodes: 2, edges: 0 }));
    const recovered = await api.initializeProjects(empty);
    check(recovered.id !== first.id && recovered.id !== second.id && recovered.canvas.nodes.length === 2, 'new recovery imports a separate project after library initialization');
    check((await api.listProjects()).length === 3 && (await api.openProject(second.id)).name === 'Durable project', 'recovery preserves every existing project');
    await api.initializeProjects(empty);
    check((await api.listProjects()).length === 3, 'recovery receipt imports only once');
    localStorage.setItem(api.LEGACY_CANVAS_KEY, 'invalid legacy cache');
    check((await api.initializeProjects(empty)).id === second.id, 'existing library does not depend on legacy cache validity');
    localStorage.setItem(api.LEGACY_CANVAS_KEY, JSON.stringify(canvas));
    localStorage.setItem('h3-canvas-recovery-receipt-v1', JSON.stringify({ source: 'Kimi Work', sourceSequence: 3, nodes: 99, edges: 0 }));
    let mismatched = false;
    try { await api.initializeProjects(empty); } catch { mismatched = true; }
    check(mismatched && (await api.listProjects()).length === 3, 'mismatched recovery cannot replace an existing project');
    return checks;
  });
  assert.equal(checks.length, 20);
  console.log(`${checks.length} project persistence checks passed:\n${checks.map((name) => `- ${name}`).join('\n')}`);

  const fresh = await browser.newContext();
  const tabA = await fresh.newPage(); const tabB = await fresh.newPage();
  await Promise.all([tabA.goto(`${origin}/storage-tests.html`), tabB.goto(`${origin}/storage-tests.html`)]);
  const [a, b] = await Promise.all([tabA, tabB].map((tab) => tab.evaluate(async () => {
    const api = await import('/canvas-projects.js');
    return (await api.initializeProjects(() => ({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }))).id;
  })));
  assert.equal(a, b, 'concurrent first-open tabs must share a single imported project');
  console.log('Concurrent bootstrap check passed.');
  if (uiBuild) {
    const ui = await browser.newContext();
    await ui.addInitScript(() => {
      if (!localStorage.getItem('project-ui-fixture')) {
        localStorage.setItem('project-ui-fixture', 'true');
        localStorage.setItem('h3-canvas-name-v1', 'Original canvas');
        localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({ nodes: [{ id: 'original-note', type: 'note', position: { x: 100, y: 180 }, data: { title: 'Original note', text: 'Synthetic fixture' } }], edges: [], viewport: { x: 0, y: 0, zoom: 0.9 } }));
      }
      window.__canvasTools = {};
      document.modelContext = { registerTool(tool) { window.__canvasTools[tool.name] = tool; } };
    });
    const uiPage = await ui.newPage();
    const uiErrors = [];
    uiPage.on('pageerror', (error) => uiErrors.push(error.message));
    await uiPage.route('http://127.0.0.1:8188/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: route.request().url().includes('system_stats') ? JSON.stringify({ devices: [] }) : '{}' }));
    await uiPage.routeWebSocket('ws://127.0.0.1:8188/**', () => {});
    await uiPage.goto(origin);
    const name = uiPage.getByLabel('画布项目名称', { exact: true });
    await name.waitFor();
    assert.equal(await name.inputValue(), 'Original canvas');
    const getCurrent = () => uiPage.evaluate(async () => { const api = await import('/canvas-projects.js'); return api.initializeProjects(() => ({ nodes: [], edges: [] })); });
    await uiPage.getByRole('button', { name: '项目列表', exact: true }).click();
    await uiPage.locator('.project-create').getByRole('button', { name: '新建画布', exact: true }).click();
    await uiPage.waitForFunction(() => document.querySelector('[aria-label="画布项目名称"]')?.value === '未命名画布');
    assert.equal((await getCurrent()).canvas.nodes.length, 0, 'new project starts empty');
    await uiPage.waitForFunction(() => Boolean(window.__canvasTools.canvas_create_node));
    await uiPage.evaluate(() => window.__canvasTools.canvas_create_node.execute({ preset: 'note', title: 'New project note', text: 'Independent note', x: 110, y: 210 }));
    await name.fill('Immediate rename');
    await uiPage.getByRole('button', { name: '项目列表', exact: true }).click();
    await uiPage.getByRole('button', { name: '打开项目：Original canvas', exact: true }).click();
    await uiPage.waitForFunction(() => document.querySelector('[aria-label="画布项目名称"]')?.value === 'Original canvas');
    assert.equal((await getCurrent()).canvas.nodes.length, 1);
    await uiPage.getByRole('button', { name: '项目列表', exact: true }).click();
    await uiPage.getByRole('button', { name: '打开项目：Immediate rename', exact: true }).click();
    await uiPage.waitForFunction(() => document.querySelector('[aria-label="画布项目名称"]')?.value === 'Immediate rename');
    assert.equal((await getCurrent()).canvas.nodes[0].data.title, 'New project note', 'switch flush preserves immediate edits');
    const note = (await getCurrent()).canvas.nodes[0].id;
    await uiPage.evaluate((id) => window.__canvasTools.canvas_delete_node.execute({ nodeId: id }), note);
    await uiPage.waitForFunction(() => Boolean(document.querySelector('[aria-label="已保存"]')));
    await uiPage.reload(); await name.waitFor();
    assert.equal((await getCurrent()).canvas.nodes.length, 0, 'empty project survives reload');
    await uiPage.getByRole('button', { name: '项目列表', exact: true }).click();
    await uiPage.getByRole('tab', { name: '协作', exact: true }).click();
    assert.match(await uiPage.locator('.project-empty').textContent(), /暂无协作画布/);
    await uiPage.getByRole('tab', { name: '全部', exact: true }).click();
    await uiPage.getByLabel('搜索画布', { exact: true }).fill('does-not-exist');
    assert.match(await uiPage.locator('.project-empty').textContent(), /没有找到/);
    await uiPage.getByLabel('搜索画布', { exact: true }).fill('');
    await uiPage.getByRole('button', { name: '项目列表', exact: true }).click();
    await uiPage.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.__originalPut = put;
      IDBObjectStore.prototype.put = function (...args) { if (this.name === 'projects') throw new DOMException('Simulated save failure', 'QuotaExceededError'); return put.apply(this, args); };
    });
    await name.fill('Unsaved edit');
    await uiPage.getByRole('alert').waitFor();
    await uiPage.getByRole('button', { name: '项目列表', exact: true }).click();
    await uiPage.getByRole('button', { name: '打开项目：Original canvas', exact: true }).click();
    await uiPage.locator('.project-switching').waitFor({ state: 'hidden' });
    await uiPage.waitForFunction(() => !document.querySelector('[aria-label="画布项目名称"]')?.disabled && document.querySelector('[aria-label="保存失败"]'));
    assert.equal(await name.inputValue(), 'Unsaved edit', 'save failure prevents project switch');
    await uiPage.evaluate(() => { IDBObjectStore.prototype.put = window.__originalPut; });
    await name.fill('Recovered edit');
    await uiPage.waitForFunction(() => Boolean(document.querySelector('[aria-label="已保存"]')));
    if (!(await uiPage.getByRole('region', { name: '项目列表面板', exact: true }).isVisible())) await uiPage.getByRole('button', { name: '项目列表', exact: true }).click();
    await uiPage.getByRole('button', { name: '打开项目：Original canvas', exact: true }).click();
    await uiPage.waitForFunction(() => document.querySelector('[aria-label="画布项目名称"]')?.value === 'Original canvas');
    await uiPage.evaluate(async () => {
      const api = await import('/canvas-projects.js'); const current = await api.initializeProjects(() => ({ nodes: [], edges: [] }));
      await api.saveProject(current.id, current.revision, current.name, { ...current.canvas, nodes: [...current.canvas.nodes, { id: 'running-generator', type: 'generator', position: { x: 500, y: 100 }, data: { title: 'Queued fixture', mode: 'image', status: 'queued', promptId: 'synthetic-unsubmitted' } }] });
    });
    await uiPage.reload(); await name.waitFor();
    await uiPage.getByRole('button', { name: '项目列表', exact: true }).click();
    assert.equal(await uiPage.locator('.project-create').getByRole('button', { name: '新建画布', exact: true }).isDisabled(), true, 'active task blocks new project');
    assert.equal(await uiPage.getByRole('button', { name: '打开项目：Recovered edit', exact: true }).isDisabled(), true, 'active task blocks switching');
    await uiPage.evaluate(async () => {
      const api = await import('/canvas-projects.js');
      const media = (id, x) => ({ id, type: 'media', position: { x, y: 180 }, data: { title: id, kind: 'audio', localFile: true, name: 'synthetic.txt', mediaStorageId: 'immutable-fixture' } });
      const project = await api.createProject('Media deletion regression', { nodes: [media('failed-delete', 100), media('stale-delete', 500)], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
      await api.saveProjectFile(project.id, 'immutable-fixture', new File(['committed media content'], 'synthetic.txt', { type: 'text/plain' }));
      await api.openProject(project.id);
    });
    await uiPage.reload(); await name.waitFor();
    await uiPage.waitForFunction(() => Boolean(document.querySelector('[aria-label="已保存"]')));
    await uiPage.evaluate(() => {
      window.__originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { if (this.name === 'projects') throw new DOMException('Deletion save failed', 'QuotaExceededError'); return window.__originalPut.apply(this, args); };
    });
    await uiPage.evaluate(() => window.__canvasTools.canvas_delete_node.execute({ nodeId: 'failed-delete' }));
    await uiPage.getByRole('alert').waitFor();
    const failedDelete = await uiPage.evaluate(async () => {
      const api = await import('/canvas-projects.js'); const project = await api.initializeProjects(() => ({ nodes: [], edges: [] }));
      return { nodePresent: project.canvas.nodes.some((node) => node.id === 'failed-delete'), fileContent: await (await api.readProjectFile(project, 'immutable-fixture'))?.text() };
    });
    assert.deepEqual(failedDelete, { nodePresent: true, fileContent: 'committed media content' }, 'failed node deletion preserves committed node and media');
    await uiPage.evaluate(() => { IDBObjectStore.prototype.put = window.__originalPut; });
    await uiPage.reload(); await name.waitFor();
    await uiPage.waitForFunction(() => Boolean(document.querySelector('[aria-label="已保存"]')));
    await uiPage.evaluate(async () => {
      const api = await import('/canvas-projects.js'); const project = await api.initializeProjects(() => ({ nodes: [], edges: [] }));
      await api.saveProject(project.id, project.revision, project.name, { ...project.canvas, nodes: [...project.canvas.nodes, { id: 'newer-tab-note', type: 'note', position: { x: 900, y: 180 }, data: { title: 'Newer edit', text: 'Synthetic newer-tab write' } }] });
    });
    await uiPage.evaluate(() => window.__canvasTools.canvas_delete_node.execute({ nodeId: 'stale-delete' }));
    await uiPage.getByRole('alert').waitFor();
    const staleDelete = await uiPage.evaluate(async () => {
      const api = await import('/canvas-projects.js'); const project = await api.initializeProjects(() => ({ nodes: [], edges: [] }));
      return { nodePresent: project.canvas.nodes.some((node) => node.id === 'stale-delete'), newerEditPresent: project.canvas.nodes.some((node) => node.id === 'newer-tab-note'), fileContent: await (await api.readProjectFile(project, 'immutable-fixture'))?.text() };
    });
    assert.deepEqual(staleDelete, { nodePresent: true, newerEditPresent: true, fileContent: 'committed media content' }, 'stale-tab node deletion preserves newer committed canvas and media');
    assert.deepEqual(uiErrors, []);
    console.log('Project list UI checks passed: create, immediate switch flush, rename, reload, empty canvas, filters/search, failed-save protection, active-task guard, failed/stale node deletion preserves committed media.');
    await ui.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
