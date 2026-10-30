import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// Static build plus in-memory HTTP fixtures only: no Python, ComfyUI, real projects or generation.
const build = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const server = createServer(async (request, response) => {
  const target = path.resolve(build, `.${new URL(request.url, 'http://fixture').pathname === '/' ? '/index.html' : new URL(request.url, 'http://fixture').pathname}`);
  if (!target.startsWith(`${build}${path.sep}`)) { response.writeHead(404).end(); return; }
  try { response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(target)); }
  catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let project = {
  schemaVersion: 3, id: 'prj_save_fixture', name: '保存测试', revision: 1,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', settings: {},
  characters: [], outfits: [], locations: [], shots: [], assets: [],
  canvas: { nodes: [
    { id: 'note', type: 'note', position: { x: 70, y: 100 }, data: { title: '测试备注', text: '初始文字' } },
    { id: 'gen', type: 'generator', position: { x: 550, y: 100 }, data: { title: '模拟任务', mode: 'swap', status: 'running', progress: 0, promptId: 'prompt-fixture', queueJobId: 'job-fixture', runs: [] } },
    { id: 'asset', type: 'media', position: { x: 1000, y: 100 }, data: { title: '恢复素材', kind: 'image', localFile: true, assetPath: 'assets/original.txt', url: '' } },
  ], edges: [], viewport: { x: 0, y: 0, zoom: 0.8 } },
};
const writes = []; const requests = []; const errors = [];
let rejectWrites = false;
let delayNextWrite = false;
let assetWrites = 0; let activeAssets = 0; let maximumAssets = 0;
let page;
// Poll the resolved WebMCP result, rather than the truthiness of an async predicate.
const waitForCanvas = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async () => JSON.parse(await window.fixtureCanvasTools.canvas_get_state.execute({ nodeId: 'gen' })));
    if (predicate(state)) return state;
    await page.waitForTimeout(50);
  }
  throw new Error('Timed out waiting for the expected canvas state');
};
try {
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'test must never contact the live application or external services');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const method = route.request().method(); requests.push([method, url.pathname]);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') return json(project);
    if (url.pathname === `/api/projects/${project.id}/shots/shot-fixture/takes`) {
      const payload = route.request().postDataJSON();
      assert.equal(payload.revision, project.revision);
      const item = { id: 'take-fixture', ...payload };
      project.shots[0].takes.push(item); project.revision += 1;
      return json({ project, item });
    }
    if (url.pathname === `/api/projects/${project.id}`) {
      if (method === 'PUT') {
        writes.push(route.request().postDataJSON());
        if (delayNextWrite) { delayNextWrite = false; await new Promise((resolve) => setTimeout(resolve, 1600)); }
        if (rejectWrites) return json({ code: 'REVISION_CONFLICT', message: '版本冲突', details: { revision: project.revision + 1, conflict: '.conflict-fixture.json' } }, 409);
        assert.equal(Number(route.request().headers()['if-match']), project.revision, 'asset writes must not race the page content CAS');
        project = { ...writes.at(-1), revision: project.revision + 1 };
      }
      return json(project);
    }
    if (url.pathname.includes('/assets/')) {
      if (method === 'PUT') {
        assetWrites += 1; activeAssets += 1; maximumAssets = Math.max(maximumAssets, activeAssets);
        await new Promise((resolve) => setTimeout(resolve, 180));
        activeAssets -= 1; project.revision += 1;
        return json({ revision: project.revision, asset: { path: `assets/import-${assetWrites}.txt` } });
      }
      return route.fulfill({ contentType: 'text/plain', body: 'synthetic asset' });
    }
    if (url.pathname === '/api/settings') return json({ notifications: false, updates: { autoCheck: false } });
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname === '/api/comfy/history') return json({});
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    return json({});
  });
  await page.addInitScript(() => {
    window.fixtureCanvasTools = {};
    document.modelContext = { registerTool(tool) { window.fixtureCanvasTools[tool.name] = tool; } };
    window.fixtureEvents = [];
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.fixtureEvents.push(this); }
      close() { window.fixtureEvents = window.fixtureEvents.filter((value) => value !== this); }
    };
    window.WebSocket = class { close() {} };
    window.emitJob = (job, type = 'job.progress') => window.fixtureEvents.forEach((source) => source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ job }) })));
  });
  await page.goto(origin);
  await page.locator('.project-open').click();
  await page.locator('[data-id="note"]').waitFor();
  await page.waitForTimeout(1100);
  assert.equal(writes.length, 0, 'opening, measurements and blob hydration must not save');
  const note = page.locator('[data-id="note"]');
  const title = note.locator('.neo-node-title');
  let box = await title.boundingBox();
  await page.mouse.click(box.x + 8, box.y + 8);
  await page.mouse.move(1250, 700); await page.mouse.down(); await page.mouse.move(1300, 740, { steps: 5 }); await page.mouse.up();
  await page.mouse.wheel(0, 90);
  await page.waitForTimeout(1200);
  assert.equal(writes.length, 0, 'select/pan/zoom must not PUT a project');
  assert.ok(await page.evaluate(() => localStorage.getItem('h3-canvas-viewport-v1:prj_save_fixture')));
  box = await title.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8); await page.mouse.down();
  await page.mouse.move(box.x + 45, box.y + 20, { steps: 5 }); await page.waitForTimeout(1600);
  assert.equal(writes.length, 0, 'holding a slow drag still must not write');
  await page.mouse.move(box.x + 80, box.y + 40, { steps: 5 }); await page.waitForTimeout(1600);
  assert.equal(writes.length, 0);
  await page.mouse.up(); await page.waitForTimeout(900);
  assert.equal(writes.length, 1, 'release writes the final drag exactly once');
  const count = writes.length;
  await page.evaluate(async () => {
    for (let progress = 1; progress <= 60; progress += 1) {
      window.emitJob({ id: 'job-fixture', projectId: 'prj_save_fixture', nodeId: 'gen', status: 'running', progress, comfyPromptId: 'prompt-fixture' });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  await page.waitForTimeout(1100);
  assert.equal(writes.length, count, 'progress ticks past five seconds produce no PUT');
  delayNextWrite = true;
  const contentStarted = page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname === `/api/projects/${project.id}`);
  await note.locator('textarea').fill('导入前的内容快照');
  await contentStarted;
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    for (let index = 0; index < 3; index += 1) dataTransfer.items.add(new File([`synthetic-${index}`], `import-${index}.png`, { type: 'image/png' }));
    document.querySelector('.neo-canvas-wrap').dispatchEvent(new DragEvent('drop', { dataTransfer, clientX: 100, clientY: 750, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  assert.equal(assetWrites, 0, 'imports wait for the already-inflight content PUT');
  await page.waitForTimeout(2600);
  assert.equal(assetWrites, 3); assert.equal(maximumAssets, 1, 'asset revisions are serialized');
  assert.equal(writes.length, count + 2, 'one pre-import snapshot and one final batch snapshot');
  assert.equal(project.canvas.nodes.filter((node) => node.data.assetPath?.startsWith('assets/import-')).length, 3);
  await page.getByTitle('快速定位当前选择或全部内容').click();
  await page.waitForTimeout(500);
  const finish = () => page.evaluate(() => window.emitJob({ id: 'job-fixture', projectId: 'prj_save_fixture', nodeId: 'gen', status: 'done', progress: 100, comfyPromptId: 'prompt-fixture', history: {
    outputs: { source: { images: [{ filename: 'input.mp4', subfolder: '', type: 'input' }] }, save: { images: [{ filename: 'H3_CharacterSwap_00006_.mp4', subfolder: 'video', type: 'output' }] } },
  } }, 'job.done'));
  rejectWrites = true;
  await note.locator('textarea').fill('冲突后仍要保留');
  await page.getByText('保存已暂停', { exact: true }).waitFor();
  const conflictCount = writes.length;
  assert.equal(conflictCount, count + 3);
  assert.equal(await page.getByRole('button', { name: '保存快照并重新载入' }).isDisabled(), true, 'running task blocks reload');
  await finish();
  await waitForCanvas((state) => state.edges.some((edge) => edge.source === 'gen' && edge.targetHandle === 'preview'));
  await page.evaluate(async () => {
    const state = JSON.parse(await window.fixtureCanvasTools.canvas_get_state.execute({ nodeId: 'gen' }));
    const result = state.edges.find((edge) => edge.source === 'gen' && edge.targetHandle === 'preview');
    await window.fixtureCanvasTools.canvas_focus_node.execute({ nodeId: result.target });
  });
  await page.locator('.react-flow__node-media video').waitFor({ state: 'attached' });
  await page.waitForTimeout(1200);
  assert.equal(writes.length, conflictCount, 'completion after 409 stays local without retries');
  assert.ok((await page.locator('.react-flow__node-media video').getAttribute('src')).includes('H3_CharacterSwap_00006_'));
  await page.getByTitle('快速定位当前选择或全部内容').click();
  await note.locator('textarea').fill('冲突后最新文字');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1300);
  assert.equal(writes.length, conflictCount);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载画布 JSON 快照', exact: true }).click();
  const download = await downloading;
  const recovery = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(recovery.canvas.nodes.find((node) => node.id === 'note').data.text, '冲突后最新文字');
  assert.ok(recovery.canvas.nodes.some((node) => node.data.sourcePromptId === 'prompt-fixture' && node.data.url.includes('H3_CharacterSwap_00006_')));
  assert.equal(await page.locator('.autosave-complete').count(), 0, 'no save toast');
  assert.equal(requests.some(([method, url]) => method === 'POST' && url === '/api/queue'), false, 'never submit a GPU job');
  // A shot finishing during a held drag stays visible and registers once after release.
  rejectWrites = false;
  project.shots = [{ id: 'shot-fixture', takes: [] }];
  project.canvas.nodes.find((node) => node.id === 'gen').data = { ...project.canvas.nodes.find((node) => node.id === 'gen').data,
    shotId: 'shot-fixture', pinResultToCanvas: false, status: 'running' };
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload(); await page.locator('.project-open').click();
  await page.waitForFunction(() => Boolean(window.fixtureCanvasTools.canvas_focus_node));
  await page.evaluate(async () => window.fixtureCanvasTools.canvas_focus_node.execute({ nodeId: 'note' }));
  await page.waitForTimeout(500);
  box = await title.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 });
  const beforeCompletion = writes.length;
  await finish();
  await waitForCanvas((state) => state.nodes[0].status === 'done');
  assert.equal(project.shots[0].takes.length, 0, 'do not register a Take while a drag suspends saving');
  assert.equal(writes.length, beforeCompletion);
  await page.mouse.up();
  await waitForCanvas((state) => state.nodes[0].stage === '已加入 Take 栈');
  assert.equal(project.shots[0].takes.length, 1, `register the preserved result once after release: ${JSON.stringify({ shots: project.shots, takeRequests: requests.filter(([, url]) => url.includes('/takes')) })}`);
  assert.deepEqual(errors, []);
  console.log('CANVAS_SAVE_UI_OK pan=0 slowDrag=1 progress=0 conflict=1 localOutput=true recoverySnapshot=true deferredTake=true');
} catch (error) {
  console.error('SAVE_UI_DEBUG', JSON.stringify({ errors, requests: requests.slice(-15), text: (await page?.locator('body').innerText())?.slice(0, 1200) }));
  throw error;
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
