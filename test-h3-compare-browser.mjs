import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Pass the local QA manifest produced by inspect_h3_result.');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const files = new Map(await Promise.all(Object.entries(fixture.files).map(async ([name, path]) => [name, await readFile(path)])));
const entry = 'virtual:h3-compare-test';
const server = await createServer({
  configFile: false,
  cacheDir: '.cache/h3-compare-vite',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{
    name: 'h3-compare-test',
    resolveId(id) { return id === entry ? '\0' + entry : null; },
    load(id) {
      return id === '\0' + entry ? [
        "import React, { useState } from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import H3CompareDialog from '/src/H3CompareDialog.jsx';",
        "function Test() {",
        "  const [open, setOpen] = useState(true);",
        "  const query = new URLSearchParams(location.search);",
        "  return open ? React.createElement(H3CompareDialog, { projectId: 'test', nodeId: query.get('scenario'),",
        "    fallbackMedia: JSON.parse(query.get('fallback')),",
        "    onClose: () => setOpen(false) }) : null;",
        "}",
        "createRoot(document.getElementById('root')).render(React.createElement(Test));",
      ].join('\n') : null;
    },
    configureServer(vite) {
      vite.middlewares.use('/h3-review-test', (_, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script type="module" src="/@id/virtual:h3-compare-test"></script>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(process.env.H3_COMPARE_CHROMIUM ? { executablePath: process.env.H3_COMPARE_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  page.on('pageerror', (error) => console.error(error.message));
  let inspectRequests = 0;
  await page.route('**/api/h3-compare?*', (route) => {
    inspectRequests += 1;
    const id = new URL(route.request().url()).searchParams.get('nodeId');
    return id === 'old-backend' ? route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
      : route.fulfill({ json: fixture[id] });
  });
  await page.route(/\/api\/(?:comfy\/view\?|projects\/[^/]+\/assets\/)/, (route) => {
    const url = new URL(route.request().url());
    const name = url.searchParams.get('filename') || decodeURIComponent(basename(url.pathname));
    const raw = files.get(name);
    if (!raw) return route.fulfill({ status: 404 });
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()['range'] || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), raw.length - 1) : raw.length - 1;
    if (start > end) return route.fulfill({ status: 416 });
    return route.fulfill({
      status: range ? 206 : 200,
      headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes',
        ...(range ? { 'content-range': 'bytes ' + start + '-' + end + '/' + raw.length } : {}) },
      body: raw.subarray(start, end + 1),
    });
  });
  const navigate = (scenario) => page.goto(origin + 'h3-review-test?' + new URLSearchParams({
    scenario, fallback: JSON.stringify(fixture.matched.refined),
  }));
  const ready = page.locator('[role=status][data-ready=true]');
  await navigate('matched');
  await ready.waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: '下一帧' }).click();
  await page.locator('.h3-review-index').filter({ hasText: '2 / ' }).waitFor();
  await ready.waitFor();
  const displayed = await page.locator('video').evaluateAll((videos) => videos.map((video) => video.currentTime));
  assert.equal(displayed.length, 2);
  assert.ok(displayed.every((time) => time > 1 / 24 && time < 2 / 24));
  await page.getByRole('slider', { name: '对照帧' }).focus();
  await page.keyboard.press('End');
  await page.locator('.h3-review-index').filter({ hasText: fixture.matched.clock.count + ' / ' }).waitFor();
  await ready.waitFor();
  assert.equal(inspectRequests, 1);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await navigate('mismatch');
  await page.getByText('原片和二采片的解码帧数不同。').waitFor();
  assert.equal(await page.getByRole('slider').count(), 0);
  assert.equal(await page.locator('video[controls]').count(), 2);

  if (fixture['no-receipt']) {
    await navigate('no-receipt');
    await page.getByText('二采文件没有可识别的执行记录，无法确定原片。').waitFor();
    assert.equal(await page.getByRole('slider').count(), 0);
    assert.equal(await page.locator('video[controls]').count(), 1);
    const src = await page.locator('video').getAttribute('src');
    assert.match(src, /^\/api\/projects\//);
  }

  await page.setViewportSize({ width: 465, height: 700 });
  await navigate('old-backend');
  await page.getByText('当前工作台后端尚未提供同帧核验，二采片可单独播放。').waitFor();
  assert.equal(await page.locator('video[controls]').count(), 1);
  if (fixture.matched.refined.type === 'project') {
    assert.match(await page.locator('video').getAttribute('src'), /^\/api\/projects\//);
  }
  assert.equal(await page.locator('.h3-review-media').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
  console.log('Real-media test passed: first / next / last confirmed by the browser; mismatched and old-backend paths stay independent.');
} catch (error) {
  const detail = browser ? await (await browser.contexts()[0]?.pages()[0]?.locator('body').innerText().catch(() => '')) : '';
  console.error(detail);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
