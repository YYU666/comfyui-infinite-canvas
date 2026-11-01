import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

// Every resource is intercepted at a synthetic origin; no running H3 instance is used.
const origin = 'http://canvas-resume.test';
const build = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const project = (id) => ({
  schemaVersion: 3, id, name: `画布 ${id}`, revision: 1,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', settings: {},
  characters: [], outfits: [], locations: [], shots: [], assets: [],
  canvas: { nodes: [{ id: `note-${id}`, type: 'note', position: { x: 100, y: 100 }, data: { title: `备注 ${id}`, text: '合成测试' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
});
const projects = [project('A'), project('B')];
const browser = await chromium.launch({ headless: true });
const errors = []; const requests = []; const opens = [];
let failure = 0; let delay = 0; let closeFailure = false;
async function fixture({ raw, storageBlocked = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ raw, storageBlocked, key }) => {
    window.EventSource = class extends EventTarget { close() {} };
    window.WebSocket = class { close() {} };
    if (raw !== undefined && !sessionStorage.getItem('fixture-seeded')) {
      sessionStorage.setItem(key, raw); sessionStorage.setItem('fixture-seeded', 'true');
    }
    if (storageBlocked) Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Disabled', 'SecurityError'); } });
  }, { raw, storageBlocked, key: PROJECT_SESSION_KEY });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    assert.equal(url.origin, origin, 'all resources must remain on the intercepted synthetic origin');
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!url.pathname.startsWith('/api/')) {
      const file = path.resolve(build, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
      assert.ok(file.startsWith(`${build}${path.sep}`));
      try { return await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    }
    const method = request.method(); requests.push([method, url.pathname]);
    if (url.pathname === '/api/projects/open') {
      const payload = request.postDataJSON(); opens.push(payload);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (failure && (failure !== 423 || !payload.readOnly)) return json({ message: 'fixture open failure' }, failure);
      return json(projects.find((item) => item.id === payload.id) || {}, projects.some((item) => item.id === payload.id) ? 200 : 404);
    }
    if (url.pathname === '/api/projects') return json({ projects });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname.endsWith('/close')) return json({}, closeFailure ? 500 : 200);
    if (url.pathname === '/api/settings') return json({ notifications: false, updates: { autoCheck: false } });
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    return json({});
  });
  await page.goto(origin);
  return { page, context };
}
const canvas = async (page, id) => {
  await page.waitForFunction((name) => document.querySelector('[aria-label="画布项目名称"]')?.value === name, `画布 ${id}`);
  await page.locator(`[data-id="note-${id}"]`).waitFor();
};
const stored = (page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), PROJECT_SESSION_KEY);
const seed = (id, readOnly = false) => JSON.stringify({ version: 1, id, readOnly });
try {
  let { page, context } = await fixture();
  await page.locator('.launcher-shell').waitFor();
  assert.equal(opens.length, 0, 'fresh tab stays launcher');
  await page.locator('.project-entry').filter({ hasText: '画布 A' }).locator('.project-open').click();
  await canvas(page, 'A');
  assert.equal((await stored(page)).id, 'A');
  // Exercise actual viewport persistence before reloading, rather than only seeding it.
  await page.mouse.move(1100, 650); await page.mouse.down();
  await page.mouse.move(1150, 680, { steps: 5 }); await page.mouse.up();
  await page.mouse.wheel(0, 90);
  await page.waitForFunction(() => localStorage.getItem('h3-canvas-viewport-v1:A'));
  const viewport = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-canvas-viewport-v1:A')));
  const beforeReload = opens.length;
  delay = 500;
  await page.reload();
  await page.getByText('正在恢复当前项目', { exact: true }).waitFor();
  assert.equal(await page.locator('.launcher-shell').count(), 0, 'no launcher flash during restoration');
  await canvas(page, 'A'); delay = 0;
  await page.waitForTimeout(1000); // Include the autosave debounce window in the zero-write check.
  assert.equal(opens.length, beforeReload + 1, 'one restore open per reload');
  const transform = await page.locator('.react-flow__viewport').evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
  for (const key of ['x', 'y', 'zoom']) assert.ok(Math.abs(transform[key] - viewport[key]) < 0.01, `saved viewport ${key} restored`);
  await page.getByRole('button', { name: '项目列表', exact: true }).click();
  closeFailure = true;
  await page.getByRole('button', { name: '打开项目：画布 B', exact: true }).click();
  await page.locator('.project-save-error').waitFor();
  await canvas(page, 'A');
  assert.equal((await stored(page)).id, 'A', 'failed switch never replaces the committed session');
  closeFailure = false;
  await page.getByRole('button', { name: '打开项目：画布 B', exact: true }).click();
  await canvas(page, 'B');
  assert.equal((await stored(page)).id, 'B');
  await page.reload(); await canvas(page, 'B');
  assert.equal(opens.at(-1).id, 'B', 'internal switch is restored');
  await page.locator('.launcher-return').click();
  await page.locator('.launcher-shell').waitFor();
  assert.equal(await stored(page), null);
  const afterReturn = opens.length;
  await page.reload(); await page.locator('.launcher-shell').waitFor();
  assert.equal(opens.length, afterReturn, 'explicit launcher remains launcher');
  await context.close();

  for (const status of [404, 500]) {
    failure = status;
    ({ page, context } = await fixture({ raw: seed('A') }));
    await page.locator('.launcher-shell').waitFor();
    await page.getByRole('alert').filter({ hasText: '未能恢复刚才的项目' }).waitFor();
    assert.equal(await stored(page), null);
    await context.close();
  }
  failure = 423;
  ({ page, context } = await fixture({ raw: seed('A') }));
  await canvas(page, 'A');
  assert.deepEqual(opens.slice(-2), [{ id: 'A', readOnly: false }, { id: 'A', readOnly: true }]);
  assert.equal((await stored(page)).readOnly, true);
  assert.equal(await page.getByLabel('画布项目名称').isDisabled(), true);
  failure = 0;
  const beforeReadonly = opens.length;
  await page.reload(); await canvas(page, 'A');
  assert.equal(opens.length, beforeReadonly + 1);
  assert.deepEqual(opens.at(-1), { id: 'A', readOnly: true }, 'readOnly remains explicit after lock disappears');
  await context.close();

  for (const options of [{ raw: 'not-json' }, { storageBlocked: true }]) {
    const before = opens.length;
    ({ page, context } = await fixture(options));
    await page.locator('.launcher-shell').waitFor();
    assert.equal(opens.length, before);
    await page.locator('.project-open').first().click(); await canvas(page, 'A');
    await page.locator('.launcher-return').click(); await page.locator('.launcher-shell').waitFor();
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(([method, url]) => method === 'POST' && url === '/api/queue').length, 0, 'never enqueue generation');
  assert.equal(requests.filter(([method]) => ['PUT', 'PATCH', 'DELETE'].includes(method)).length, 0, 'never save or mutate project content');
  const allowedPosts = new Set(['/api/projects/open', '/api/agent/canvas/heartbeat', '/api/agent/canvas/release']);
  const unexpected = requests.filter(([method, url]) => method !== 'GET' && !(method === 'POST' && (allowedPosts.has(url) || url.endsWith('/close'))));
  assert.deepEqual(unexpected, [], 'only project open/close and existing page presence requests are allowed');
  console.log('PROJECT_RESUME_UI_OK reload=true viewport=true switch=true failedSwitch=true launcher=true failures=2 readonly=true storage=2 generation=0 saves=0');
} finally { await browser.close(); }
