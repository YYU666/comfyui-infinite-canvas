import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

const origin = 'http://obsidian-fixture.test';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const project = { id: 'prj_obsidian_fixture', name: 'Obsidian fixture', revision: 1, shots: [], canvas: {
  viewport: { x: 20, y: 75, zoom: 1 },
  nodes: [
    { id: 'prompt', type: 'prompt', position: { x: 18, y: 80 }, data: { title: 'Prompt fixture', idea: 'Test prompt' } },
    { id: 'video', type: 'generator', position: { x: 510, y: 60 }, data: { mode: 'text', title: 'Video fixture', duration: 5, ratio: '16:9' } },
    ...Array.from({ length: 36 }, (_, index) => ({
      id: `far-${index}`, type: 'media', position: { x: 10000 + 500 * index, y: 10000 },
      data: { title: `Offscreen ${index}`, kind: 'image' },
    })),

  ],
  edges: [{ id: 'prompt-video', source: 'prompt', sourceHandle: 'prompt', target: 'video', targetHandle: 'prompt' }],
} };

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript(({ key, id }) => {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, id, readOnly: false }));
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  }, { key: PROJECT_SESSION_KEY, id: project.id });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const json = (value) => route.fulfill({ json: value });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/open' || url.pathname === `/api/projects/${project.id}`) return json(project);
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({
      contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
      body: await readFile(file),
    });
  });

  await page.goto(origin);
  const promptNode = page.locator('.react-flow__node[data-id="prompt"] .obsidian-node');
  const videoNode = page.locator('.react-flow__node[data-id="video"] .obsidian-node');
  const edge = page.locator('.react-flow__edge[data-id="prompt-video"]');
  await edge.locator('.react-flow__edge-path').waitFor();
  assert.equal(await promptNode.getAttribute('data-modality'), 'gold');
  assert.equal(await videoNode.getAttribute('data-modality'), 'coral');
  assert.equal(await page.locator('.react-flow__background').count(), 2);
  assert.equal(await edge.locator('linearGradient stop').count(), 2);
  assert.match(await edge.locator('.react-flow__edge-path').evaluate((path) => getComputedStyle(path).stroke), /^url\(/);
  assert.equal(await edge.locator('.obsidian-edge-active-endpoint').count(), 0);
  await promptNode.locator('.neo-node-title').click({ position: { x: 12, y: 12 } });
  await edge.locator('.obsidian-edge[data-linked]').waitFor({ state: 'attached' });

  await page.getByTitle('显示或隐藏网格').click();
  assert.equal(await page.locator('.react-flow__background').count(), 0);
  await page.getByTitle('显示或隐藏网格').click();
  assert.equal(await page.locator('.react-flow__background').count(), 2);

  await page.getByTitle('缩放', { exact: true }).click();
  const zoomOut = page.getByTitle('缩小', { exact: true });
  const displayedZoom = () => page.locator('.zoom-button span').textContent().then((text) => parseInt(text, 10));
  const zoomBelow = async (maximum) => {
    for (let step = 0; step < 12; step++) {
      const current = await displayedZoom();
      if (current < maximum) return;
      await zoomOut.click();
      await page.waitForFunction((previous) => parseInt(document.querySelector('.zoom-button span').textContent, 10) <= Math.ceil(previous / 1.15), current);
    }
    assert.fail(`Zoom stayed above ${maximum}%`);
  };
  await zoomBelow(58);
  await page.locator('.canvas-view-compact').waitFor();
  assert.equal(await videoNode.locator('.obsidian-model-label').isVisible(), false);
  await zoomBelow(24);
  await page.locator('.canvas-view-placeholder').waitFor();
  assert.equal(await videoNode.evaluate((node) => getComputedStyle(node).borderLeftWidth), '5px');

  await page.setViewportSize({ width: 490, height: 700 });
  const library = page.getByRole('button', { name: '节点库', exact: true });
  await library.focus();
  assert.equal(await library.evaluate((node) => node === document.activeElement), true);
  assert.equal(await library.locator('span').isVisible(), false);
  const withinViewport = (locator) => locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  });
  assert.equal(await withinViewport(library), true);
  assert.equal(await withinViewport(page.getByTitle('自动吸附')), true);
  assert.doesNotMatch(errors.join('\n'), /.+/);
  console.log('Obsidian cards, gradients, grid toggle, selection and narrow keyboard access passed.');
} catch (error) {
  if (errors.length) console.error(errors.join('\n'));
  throw error;
} finally {
  await browser.close();
}
