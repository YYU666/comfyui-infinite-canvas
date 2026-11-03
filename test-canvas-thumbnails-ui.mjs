import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from './test-browser.mjs';
import { FLUX3_KLEIN_MODEL as model } from './src/flux3-klein.js';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

// Synthetic origin only: no live project, service, GPU, or user media is accessed.
const origin = 'http://thumbnail-fixture.test';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
function png(width, height) {
  const crc = (buffer) => { let n = 0xffffffff; for (const byte of buffer) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([label, data]))); return Buffer.concat([length, label, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const original = png(1600, 900), thumbnail = png(640, 360);
let project = { id: 'prj_thumbnail_fixture', name: 'Thumbnail fixture', revision: 1, shots: [], canvas: {
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    { id: 'source', type: 'media', position: { x: 40, y: 120 }, data: { title: 'Original source', kind: 'image', localFile: true, assetPath: 'assets/source.png', name: 'source.png' } },
    { id: 'output', type: 'media', position: { x: 430, y: 120 }, data: { title: 'Comfy output', kind: 'image', output: true, url: '/api/comfy/view?filename=generated.png&type=output', name: 'generated.png' } },
    { id: 'third', type: 'media', position: { x: 40, y: 470 }, data: { title: 'Queued cold preview', kind: 'image', localFile: true, assetPath: 'assets/third.png' } },
    { id: 'generator', type: 'generator', position: { x: 850, y: 380 }, data: { title: 'Synthetic generator', mode: 'qwenEdit', qwenVersion: 'flux3_klein', prompt: 'Keep 图1 then 图2.', ratio: '16:9', seed: 42, randomSeed: false } },
    ...Array.from({ length: 99 }, (_, index) => ({ id: `far-${index}`, type: 'media', position: { x: 8000 + index * 400, y: 120 }, data: { title: `Offscreen ${index}`, kind: 'image', localFile: true, assetPath: `assets/far-${index}.png` } })),
  ], edges: [
    { id: 'first', source: 'source', sourceHandle: 'ref', target: 'generator', targetHandle: 'references' },
    { id: 'second', source: 'output', sourceHandle: 'ref', target: 'generator', targetHandle: 'references' },
  ],
} };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const thumbnails = [], originals = [], uploads = [], queued = [], errors = [];
let thumbnailFailure = false;
let thumbnailActive = 0, thumbnailPeak = 0;
await context.addInitScript(({ key, id }) => {
  sessionStorage.setItem(key, JSON.stringify({ version: 1, id, readOnly: false }));
  window.fixtureTools = new Map();
  Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
  window.EventSource = class { addEventListener() {} close() {} };
  window.WebSocket = class { addEventListener() {} close() {} };
}, { key: PROJECT_SESSION_KEY, id: project.id });
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, origin, 'all requests stay on isolated fixture');
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/thumbnails') {
    thumbnails.push(url.search);
    thumbnailPeak = Math.max(thumbnailPeak, ++thumbnailActive);
    await new Promise((resolve) => setTimeout(resolve, 500)); // Cold derivative work occupies a slot.
    thumbnailActive--;
    return thumbnailFailure ? json({ message: 'fixture cache unavailable' }, 503) : route.fulfill({ contentType: 'image/png', body: thumbnail });
  }
  if ((url.pathname.startsWith('/api/projects/') && url.pathname.includes('/assets/')) || url.pathname === '/api/comfy/view') {
    originals.push(url.pathname + url.search);
    return route.fulfill({ contentType: 'image/png', body: original });
  }
  if (url.pathname === '/api/projects') return json({ projects: [project] });
  if (url.pathname === '/api/projects/trash') return json({ projects: [] });
  if (url.pathname === '/api/projects/open') return json(project);
  if (url.pathname === `/api/projects/${project.id}`) {
    if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
    return json(project);
  }
  if (url.pathname === '/api/comfy/upload/image') {
    uploads.push(request.postDataBuffer());
    return json({ name: `reference-${uploads.length}.png`, subfolder: 'workbench' });
  }
  if (url.pathname === '/api/queue') {
    if (request.method() === 'POST') { queued.push(request.postDataJSON()); return json({ id: 'synthetic-job', status: 'queued' }); }
    return json({ jobs: [] });
  }
  if (url.pathname.includes('/object_info/')) {
    const name = url.pathname.split('/').at(-1);
    return json({ [name]: { input: { required: name === 'UNETLoader' ? { unet_name: [[model.unet]] }
      : name === 'CLIPLoader' ? { clip_name: [[model.clip, model.upsampler]], type: [['flux3']] } : { vae_name: [[model.vae]] } } } });
  }
  if (url.pathname === '/api/health') return json({ ok: true });
  if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
  if (url.pathname === '/api/settings') return json({ notifications: false, updates: { autoCheck: false } });
  if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'fixture native tools only' }, 503);
  if (url.pathname.startsWith('/api/')) return json({});
  const file = path.resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  assert.ok(file.startsWith(`${dist}${path.sep}`));
  return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
const focus = (id) => page.evaluate(async (nodeId) => window.fixtureTools.get('canvas_focus_node').execute({ nodeId }), id);
try {
  await page.goto(origin);
  await page.waitForFunction(() => [...document.querySelectorAll('.media-preview img')].filter((image) => image.naturalWidth === 640).length === 3);
  await page.waitForTimeout(600);
  assert.equal(originals.length, 0, 'opening 102 images must fetch zero originals');
  assert.equal(thumbnails.length, 3, 'offscreen nodes must not request thumbnails');
  assert.equal(thumbnailPeak, 2, 'cold visible images queue instead of overloading the two backend slots');
  assert.equal(await page.getByRole('button', { name: '缩略图未加载 · 重试', exact: true }).count(), 0);
  assert.equal(await page.locator('[data-id="output"] .media-download').getAttribute('href'), '/api/comfy/view?filename=generated.png&type=output', 'download link keeps original');
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('.media-preview img')].filter((image) => image.naturalWidth === 640).length === 3);
  assert.equal(originals.length, 0, 'reload also fetches zero originals');
  await page.locator('[data-id="source"] .media-preview').dblclick();
  await page.waitForFunction(() => document.querySelector('.image-lightbox img')?.naturalWidth === 1600);
  assert.equal(originals.length, 1, 'double-click lazily retrieves full resolution');
  await page.keyboard.press('Escape');
  thumbnailFailure = true;
  await focus('far-0');
  await page.getByRole('button', { name: '缩略图未加载 · 重试', exact: true }).first().waitFor();
  assert.equal(originals.length, 1, 'cache failure must not silently fetch original');
  thumbnailFailure = false;
  await page.getByRole('button', { name: '缩略图未加载 · 重试', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-id="far-0"] img')?.naturalWidth === 640);
  await focus('generator');
  await page.locator('[data-id="generator"]').click();
  await page.getByLabel('Qwen 模型版本').selectOption('flux3_klein');
  const result = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_generate_node').execute({ nodeId: 'generator', wait: false })));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(queued.length, 1);
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every((body) => body.includes(original)), 'both generation references upload exact original bytes');
  assert.equal(queued[0].workflow.reference_1.inputs.image, 'workbench/reference-1.png');
  assert.equal(queued[0].workflow.reference_2.inputs.image, 'workbench/reference-2.png', 'reference order retained');
  assert.deepEqual(errors, []);
  console.log('CANVAS_THUMBNAILS_UI_OK images=102 coldVisibleConcurrency=2 openOriginals=0 offscreenDeferred=true reloadOriginals=0 fullResolutionPreview=true originalUploads=2 referenceOrder=true errorRetry=true');
} catch (error) {
  console.error('Fixture failure:', (await page.locator('body').innerText()).slice(0, 1600), errors);
  throw error;
} finally { await context.close(); await browser.close(); }
