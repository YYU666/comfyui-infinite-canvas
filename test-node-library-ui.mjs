import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// No live backend, remote website, project or ComfyUI request may escape this fixture.
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const origin = 'http://127.0.0.1:8799';
const browser = await chromium.launch({ headless: true });
const failures = [];
const mutations = [];
let loads = 0;
let acknowledge = false;
const project = { id: 'prj_nodes_fixture', name: 'Node library fixture', revision: 1, shots: [], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, edges: [], nodes: [{ id: 'note', type: 'note', selected: true, position: { x: 40, y: 80 }, data: { title: 'Existing note', text: 'Synthetic only' } }] } };
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin === 'https://refmuse.cn') {
      assert.equal(request.headers()['x-h3-token'], undefined);
      assert.equal(request.headers().referer, undefined);
      assert.equal(url.searchParams.get('parentOrigin'), origin);
      if (url.pathname === '/open') {
        loads++;
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><label>搜索节点<input id="query"></label><button id="last">末尾控件</button><script>
          window.inits=[];window.acknowledge=${acknowledge};
          window.addEventListener('message',event=>{
            if(event.origin!=='${origin}'||event.source!==parent)return;
            if(event.data.type==='refmuse.nodes.init'&&event.data.version===1){window.inits.push(event.data);if(window.acknowledge)parent.postMessage({type:'refmuse.nodes.ready',version:1},event.origin);}
          });
          window.addEventListener('keydown',event=>{if(event.key==='Escape')parent.postMessage({type:'refmuse.nodes.close',version:1},'${origin}');});
          </script>` });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><input aria-label="参考搜索">' });
    }
    assert.equal(url.origin, origin, 'all external traffic must be intercepted');
    if (!['GET', 'HEAD'].includes(request.method()) && !['/api/projects/open', '/api/agent/canvas/heartbeat', '/api/agent/canvas/release'].includes(url.pathname)) mutations.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open' || url.pathname === '/api/projects/prj_nodes_fixture') return json(project);
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'native fixture only' }, 503);
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname === '/api/hardware-metrics') return json({ vramUsed: 12, vramTotal: 24, ramUsed: 24, ramTotal: 64, cpuPercent: 35 });
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin); await page.locator('.project-open').click();
  const toolbar = page.getByRole('button', { name: '节点库', exact: true });
  await toolbar.waitFor();
  assert.equal(await page.locator('.neo-header .hardware-monitor').count(), 0);
  const hardware = page.locator('.neo-canvas-wrap .hardware-monitor');
  await hardware.waitFor();
  assert.match(await hardware.innerText(), /清理显存[\s\S]*GPU 显存[\s\S]*CPU[\s\S]*RAM/);
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 900 });
    const monitor = await hardware.boundingBox();
    const dock = await page.locator('.canvas-dock').boundingBox();
    const left = await page.locator('.canvas-bottom-left').boundingBox();
    assert.ok(monitor.x >= 0 && monitor.x + monitor.width <= width, `hardware fits ${width}`);
    assert.ok(monitor.y > 650, `hardware remains bottom right at ${width}`);
    assert.ok(Math.abs(monitor.y + monitor.height / 2 - dock.y - dock.height / 2) < 1, `separate bars align at ${width}`);
    assert.equal(overlaps(monitor, dock), false, `hardware/dock overlap at ${width}`);
    assert.equal(overlaps(left, dock), false, `left/dock overlap at ${width}`);
    assert.equal(overlaps(await page.locator('.canvas-project-control').boundingBox(), await page.locator('.neo-header-actions').boundingBox()), false, `header overlap at ${width}`);
    await page.getByTitle('小地图', { exact: true }).click();
    assert.equal(overlaps(monitor, await page.locator('.react-flow__minimap').boundingBox()), false);
    await page.getByTitle('Pin 节点 0', { exact: true }).click();
    assert.equal(overlaps(monitor, await page.locator('.floating-pins').boundingBox()), false);
    assert.equal(await page.locator('.react-flow__minimap').isVisible(), false);
    await page.getByTitle('Pin 节点 0', { exact: true }).click();
    await page.getByTitle('小地图', { exact: true }).click();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const evidence = path.resolve('.cache/node-library-review');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, 'canvas-hardware-1280.jpg'), type: 'jpeg', quality: 75 });
  await toolbar.click();
  const modal = page.getByRole('dialog', { name: '节点库', exact: true });
  await modal.waitFor();
  const frame = page.frameLocator('iframe[title="Refmuse 节点库"]');
  await frame.locator('#query').waitFor();
  assert.equal(await modal.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-downloads allow-forms');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '关闭节点库');
  assert.equal(await page.locator('.neo-canvas-wrap').evaluate((element) => element.inert), true);
  assert.equal(await page.locator('.neo-header').evaluate((element) => element.inert), true);
  assert.match(await modal.getByRole('status').innerText(), /正在连接/);
  await page.evaluate(() => {
    const source = document.querySelector('iframe[title="Refmuse 节点库"]').contentWindow;
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', source, data: { type: 'refmuse.nodes.ready', version: 1 } }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://refmuse.cn', source: window, data: { type: 'refmuse.nodes.ready', version: 1 } }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://refmuse.cn', source, data: { type: 'refmuse.nodes.ready', version: 2 } }));
  });
  assert.doesNotMatch(await modal.getByRole('status').innerText(), /已连接/);
  await modal.getByRole('status').filter({ hasText: '尚未收到' }).waitFor({ timeout: 15000 });
  acknowledge = true;
  await modal.getByRole('button', { name: '重新加载', exact: true }).click();
  await modal.getByRole('status').filter({ hasText: '节点库已连接' }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'node-library-1280.jpg'), type: 'jpeg', quality: 75 });
  for (const name of ['canvas-hardware-1280.jpg', 'node-library-1280.jpg']) assert.ok((await stat(path.join(evidence, name))).size <= 500 * 1024);
  assert.equal(loads, 2);
  const remote = page.frames().find((candidate) => candidate.url().startsWith('https://refmuse.cn/open'));
  assert.deepEqual(await remote.evaluate(() => window.inits[0]), { type: 'refmuse.nodes.init', version: 1 });
  await frame.locator('#query').fill('持久搜索');
  await modal.getByRole('button', { name: '关闭节点库' }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'IFRAME');
  await frame.locator('#last').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '关闭节点库');
  const before = await page.locator('.react-flow__node').count();
  const writesBefore = mutations.length;
  for (const key of ['Control+c', 'Control+d', 'Control+v', 'Delete', 'Backspace', 'Control+z', 'Control+Shift+z', 'Control+y']) await page.keyboard.press(key);
  await page.evaluate(() => { const data = new DataTransfer(); data.items.add(new File(['fixture'], 'paste.png', { type: 'image/png' })); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data })); });
  await remote.evaluate(() => parent.postMessage({ type: 'refmuse.canvas.import', version: 1, requestId: 'unhandled-import', blob: new Blob(['x']) }, 'http://127.0.0.1:8799'));
  assert.equal(await page.locator('.react-flow__node').count(), before);
  assert.equal(mutations.length, writesBefore);
  await frame.locator('#query').focus(); await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.textContent === '节点库');
  assert.equal(await page.locator('.neo-canvas-wrap').evaluate((element) => element.inert), false);
  await toolbar.click(); await modal.waitFor();
  assert.equal(await frame.locator('#query').inputValue(), '持久搜索'); assert.equal(loads, 2);
  // Native bridge can switch to the existing reference library without two visible modals.
  const result = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_open_reference_library').execute({ library: 'refmuse' })));
  assert.equal(result.ok, true);
  await modal.waitFor({ state: 'hidden' });
  const reference = page.getByRole('dialog', { name: 'Refmuse参考库' }); await reference.waitFor();
  assert.equal(await reference.evaluate((element) => Boolean(element.closest('[inert]'))), false);
  await reference.getByRole('button', { name: '关闭参考库' }).click();
  await toolbar.click(); await modal.waitFor(); assert.equal(loads, 2);
  await modal.locator('iframe').evaluate((element) => element.dispatchEvent(new Event('error', { bubbles: true })));
  await modal.getByRole('alert').filter({ hasText: '加载失败' }).waitFor();
  await modal.getByRole('button', { name: '重新加载', exact: true }).click();
  await modal.getByRole('status').filter({ hasText: '节点库已连接' }).waitFor(); assert.equal(loads, 3);
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.react-flow__node').count(), before);
  assert.deepEqual(failures, []);
  assert.deepEqual(mutations, [], 'sharing UI must not write projects, import assets, run workflows or free memory');
  console.log('Node library synthetic UI passed: strict handshake, timeout/retry, persistence, focus/inert, guards, mutual exclusion, hardware bounds at 1280/760; no live traffic or canvas mutation.');
  await context.close();
} finally { await browser.close(); }
