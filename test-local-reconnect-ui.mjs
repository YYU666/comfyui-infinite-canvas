import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// Built UI + intercepted in-memory APIs only. No live backend, project, protocol handler or GPU.
const build = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://fixture').pathname;
  const target = path.resolve(build, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!target.startsWith(`${build}${path.sep}`)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html');
    if (pathname === '/') response.setHeader('Set-Cookie', 'h3_session=fixture-one; Path=/; HttpOnly; SameSite=Strict');
    response.end(await readFile(target));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let project = { schemaVersion: 3, id: 'prj_reconnect', name: '离线恢复测试', revision: 1,
  settings: {}, characters: [], outfits: [], locations: [], shots: [], assets: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  canvas: { nodes: [{ id: 'note', type: 'note', position: { x: 70, y: 100 }, data: { title: '测试备注', text: '原始内容' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } };
let available = true; let comfy = true; let token = 'fixture-one'; let epoch = 'epoch-one';
let externalMappingLost = false;
const externalPath = 'C:/synthetic/external-project';
let bootstraps = 0; let opens = 0; let healthReads = 0; let denied = 0; let generationWrites = 0;
const writes = []; const heartbeats = []; const errors = []; const documents = [];
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) documents.push(frame.url()); });
  await page.addInitScript(() => {
    window.fixturePageIdentity = Math.random(); window.fixtureLaunches = []; window.fixtureStreams = 0; window.fixtureSockets = 0;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.protocol === 'refmuse-canvas:') { window.fixtureLaunches.push({ url: this.href, activated: navigator.userActivation.isActive, target: this.target }); return; }
      return click.call(this);
    };
    window.EventSource = class extends EventTarget { constructor() { super(); window.fixtureStreams++; } close() {} };
    window.WebSocket = class { constructor() { window.fixtureSockets++; } close() {} };
  });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    assert.equal(url.origin, origin, 'no live project or public network');
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname === '/' && !request.isNavigationRequest()) {
      bootstraps++;
      assert.equal(request.method(), 'GET');
      return route.fulfill({ contentType: 'text/html', body: '<html></html>', headers: { 'Set-Cookie': `h3_session=${token}; Path=/; HttpOnly; SameSite=Strict` } });
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (!available) return route.abort('connectionrefused');
    if (url.pathname === '/api/health') { healthReads++; return json({ ok: true, pid: epoch, comfy: { running: comfy } }); }
    if (!request.headers().cookie?.includes(`h3_session=${token}`)) { denied++; return json({ code: 'UNAUTHORIZED' }, 401); }
    if (url.pathname === '/api/comfy/system_stats') return json(comfy ? { devices: [] } : { error: 'Comfy unavailable' }, comfy ? 200 : 502);
    if (url.pathname === '/api/settings') return json({ notifications: false, updates: { autoCheck: false } });
    if (url.pathname === '/api/projects/open') {
      opens++;
      assert.equal(request.postDataJSON().path, externalPath, 'only explicit original external folder may be restored');
      assert.equal(request.postDataJSON().readOnly, false);
      externalMappingLost = false;
      return json(project);
    }
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === `/api/projects/${project.id}`) {
      if (externalMappingLost) return json({ code: 'NOT_FOUND', message: '项目不存在或尚未打开' }, 404);
      if (request.method() === 'PUT') {
        const revision = Number(request.headers()['if-match']); writes.push(revision);
        if (revision !== project.revision) return json({ code: 'REVISION_CONFLICT', message: '版本冲突' }, 409);
        project = { ...request.postDataJSON(), revision: revision + 1 };
      }
      return json(project);
    }
    if (url.pathname === '/api/agent/canvas/heartbeat') { heartbeats.push({ epoch, ...request.postDataJSON() }); return json({ epoch }); }
    if (request.method() === 'POST' && ['/api/queue', '/api/comfy/prompt'].includes(url.pathname)) generationWrites++;
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    return json({});
  });
  await page.goto(origin);
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.getByLabel('项目文件夹路径').fill(externalPath);
  await page.getByRole('button', { name: '确定', exact: true }).click();
  const status = page.locator('.server-status');
  const note = page.locator('[data-id="note"] textarea');
  const connected = () => page.waitForFunction(() => document.querySelector('.server-status')?.textContent === '本地已连接');
  const offline = () => page.waitForFunction(() => document.querySelector('.server-status')?.textContent === '本地未连接');
  const check = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await connected(); await note.waitFor();
  const identity = await page.evaluate(() => window.fixturePageIdentity);
  const streams = await page.evaluate(() => window.fixtureStreams);
  const sockets = await page.evaluate(() => window.fixtureSockets);
  const before = healthReads;
  await status.click(); await page.waitForTimeout(150);
  assert(healthReads > before, 'online click checks health');
  assert.equal(await page.evaluate(() => window.fixtureLaunches.length), 0, 'online click never launches');

  available = false; await check(); await offline();
  await note.fill('断线时的未保存修改');
  await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
  await status.click(); await status.click();
  assert.deepEqual(await page.evaluate(() => window.fixtureLaunches), [{ url: 'refmuse-canvas://start', activated: true, target: '' }]);
  assert.equal(await status.getAttribute('aria-busy'), 'true');
  available = true; token = 'fixture-two'; epoch = 'epoch-two';
  await check(); await connected(); await page.waitForTimeout(1600);
  assert(denied > 0, 'rotated token rejected the old cookie');
  assert.equal(bootstraps, 1, 'same-page HTML fetch refreshes HttpOnly cookie once');
  assert.equal(await note.inputValue(), '断线时的未保存修改');
  await note.click();
  assert.equal(await note.evaluate((element) => element === document.activeElement), true, 'connection notice leaves canvas editable');
  assert.equal(writes.length, 0, 'reconnect does not silently replay failed saves');
  assert.equal(opens, 1, 'reconnect never reopens or replaces project');
  assert(heartbeats.some((item) => item.epoch === 'epoch-two'));
  assert.equal(new Set(heartbeats.filter((item) => item.projectId === project.id).map((item) => item.sessionId)).size, 1, 'bridge session survives epoch rotation');
  assert(await page.evaluate(() => window.fixtureStreams) > streams, 'queue streams reopen after cookie refresh');
  assert(await page.evaluate(() => window.fixtureSockets) > sockets, 'progress socket reconnects');
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.save-indicator')?.textContent === '已保存');
  assert.deepEqual(writes, [1]); assert.equal(project.canvas.nodes[0].data.text, '断线时的未保存修改');

  // A different saved revision must remain a conflict, even across another restart.
  available = false; await check(); await offline();
  await note.fill('冲突后也保留的本页修改');
  await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
  project = { ...project, revision: project.revision + 1 };
  externalMappingLost = true;
  available = true; token = 'fixture-three'; epoch = 'epoch-three';
  await check(); await connected();
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.save-indicator')?.textContent === '保存已暂停');
  assert.equal(externalMappingLost, false, 'current page restores external mapping after authenticated 404');
  assert.equal(opens, 2, 'only missing external mapping needs same-page re-registration');
  assert.deepEqual(writes, [1, 2], 'original CAS revision retained, never replaced by server revision');
  await status.click(); await page.waitForTimeout(200);
  assert.equal(await note.inputValue(), '冲突后也保留的本页修改');
  assert.equal(writes.length, 2);
  assert.equal(await page.getByRole('button', { name: '重试保存', exact: true }).count(), 0, 'conflict stays paused');

  comfy = false; await check(); await offline(); await status.click();
  await page.getByRole('status').filter({ hasText: '工作台已连接，但 ComfyUI 未就绪' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureLaunches.length), 1, 'Comfy-only failure does not restart backend');

  // A missing/declined protocol handler must stop showing an endless spinner.
  await page.clock.install();
  available = false; await check(); await offline();
  await page.clock.fastForward(31000);
  await status.click(); await status.click();
  assert.equal(await page.evaluate(() => window.fixtureLaunches.length), 2);
  await page.clock.fastForward(90001);
  await page.getByRole('status').filter({ hasText: '若未安装启动入口' }).waitFor();
  assert.equal(await status.getAttribute('aria-busy'), 'false');
  await status.click(); await status.click();
  assert.equal(await page.evaluate(() => window.fixtureLaunches.length), 3, 'timeout permits deliberate retry, rapid clicks do not relaunch');
  assert.equal(await page.evaluate(() => window.fixturePageIdentity), identity);
  assert.equal(documents.length, 1, 'no document reload/navigation');
  assert.equal(context.pages().length, 1, 'no second canvas tab');
  assert.equal(opens, 2); assert.equal(generationWrites, 0); assert.deepEqual(errors, []);
  console.log('LOCAL_RECONNECT_UI_OK protocolGesture=true dedupLaunch=true launchTimeout=true rotatedCookie=true currentPage=true bridgeSession=true externalPathRestored=true unsavedRetained=true CASConflict=true noGeneration=true');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
