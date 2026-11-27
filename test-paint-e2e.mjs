import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './test-browser.mjs';
import { createPaintData } from './src/paint-document.js';
import { imageProcessSnapshot } from './src/image-process-graph.js';
import { forwardPaintViewport } from './src/paint-viewport.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || 'python3';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-paint-e2e-'));
const shots = process.env.H3_E2E_ARTIFACTS_DIR || path.join(temporary, 'artifacts');
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const forbidden = new Set([8188, 8189, 8790, 8870]);
for (let port = 8790; port <= 8799; port += 1) forbidden.add(port);
const env = {
  ...process.env,
  H3_WORKBENCH_PORT: '0',
  H3_WORKBENCH_RUNTIME_DIR: runtime,
  H3_PROJECTS_ROOT: projects,
  H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'),
  H3_COMFY_AUTOSTART: '0',
  H3_COMFY_URL: 'http://127.0.0.1:1',
  H3_WORKBENCH_NO_BROWSER: '1',
  H3_WORKBENCH_TEST_MODE: '1',
  PYTHONUTF8: '1',
};
const backend = spawn(python, ['-X', 'utf8', 'video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
backend.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-5000); });
backend.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-5000); });
let browser;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; last = value; }
    catch (error) { last = error; if (backend.exitCode !== null) break; }
    await pause(100);
  }
  throw new Error(`paint e2e timed out: ${last?.message || last || ''}\n${logs}`);
}

function abrSample() {
  const pixels = new Uint8Array(8 * 8).fill(255);
  const u16 = (value) => [(value >> 8) & 255, value & 255];
  const u32 = (value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  const image = [...u32(0), ...u16(12), ...u32(0), ...u16(0), ...u16(0), ...u16(8), ...u16(8), ...u16(8), 0, ...pixels];
  return Buffer.from([...u16(1), ...u16(1), ...u16(2), ...u32(image.length), ...image]);
}

async function pointerStroke(locator, points, options = {}) {
  const testId = await locator.getAttribute('data-testid');
  await locator.page().evaluate(({ testId, points, options }) => {
    const canvas = document.querySelector(`[data-testid="${testId}"]`);
    const rect = canvas.getBoundingClientRect();
    const fire = (type, point, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: rect.left + point[0], clientY: rect.top + point[1],
      pointerId: options.pointerId || 1, pointerType: options.pointerType || 'pen', pressure: options.pressure ?? 0.55,
      buttons, isPrimary: true, width: options.width || 1, height: options.width || 1,
    }));
    fire('pointerdown', points[0], 1);
    for (const point of points.slice(1)) fire('pointermove', point, 1);
    fire('pointerup', points[points.length - 1], 0);
  }, { testId, points, options });
}

const companionHtml = path.join(root, 'dist', 'companion.html');
assert.ok(existsSync(companionHtml), 'companion.html is missing from the production build');
const companionPage = readFileSync(companionHtml, 'utf8');
assert.doesNotMatch(companionPage, /CanvasWorkbench|@xyflow\/react/);
for (const match of companionPage.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const relative = match[1].replace(/^\//, '');
  const file = path.join(root, 'dist', relative);
  if (!existsSync(file) || !file.endsWith('.js')) continue;
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /CanvasWorkbench|@xyflow\/react|node_modules\/three/);
}

try {
  const instance = await until(async () => JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')));
  assert.ok(!forbidden.has(instance.port), `launcher bound a forbidden port ${instance.port}`);
  const base = `http://127.0.0.1:${instance.port}`;
  const token = instance.token;
  const api = async (route, payload, method = payload ? 'POST' : 'GET') => {
    const response = await fetch(base + route, { method, headers: { 'X-H3-Token': token, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${route} ${JSON.stringify(result)}`);
    return result;
  };
  const paint = createPaintData({ title: '绘画节点', paper: { width: 480, height: 320, background: 'white', guideGrid: 'thirds' } });
  const fixture = await api('/api/projects', { name: 'Paint node synthetic QA', canvas: { nodes: [
    { id: 'paint1', type: 'paint', position: { x: 40, y: 80 }, data: paint },
    { id: 'adjust', type: 'imageProcess', position: { x: 460, y: 40 }, data: { mode: 'colorAdjust', title: '颜色调整', status: 'idle', brightness: 8 } },
    { id: 'blend', type: 'imageProcess', position: { x: 460, y: 360 }, data: { mode: 'imageBlend', title: '图像混合', status: 'idle', blendMode: 'multiply', opacity: 80, fit: 'cover' } },
  ], edges: [
    { id: 'paint-adjust', source: 'paint1', target: 'adjust', sourceHandle: 'ref', targetHandle: 'guide' },
    { id: 'paint-blend', source: 'paint1', target: 'blend', sourceHandle: 'ref', targetHandle: 'base' },
  ], viewport: { x: 20, y: 20, zoom: 0.85 } } });
  await mkdir(shots, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.project-open').click();
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await node('paint1').waitFor();
  await node('paint1').click({ position: { x: 24, y: 18 } });
  await page.screenshot({ path: path.join(shots, 'paint-canvas-connections.png') });
  const beforeNodes = await page.locator('.react-flow__node').count();
  await node('paint1').getByTestId('paint-open').click();
  const editor = page.getByTestId('paint-editor');
  await editor.waitFor();
  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    };
    return { view: box('[data-testid="paint-viewport"]'), left: box('.paint-drawer.left'), right: box('.paint-drawer.right'), editor: box('.paint-editor') };
  });
  assert.ok(layout.view.x >= layout.left.x + layout.left.width - 1, `viewport is not to the right of the left drawer: ${JSON.stringify(layout)}`);
  assert.ok(layout.view.x + layout.view.width <= layout.right.x + 1, `viewport overlaps the right drawer: ${JSON.stringify(layout)}`);
  assert.ok(layout.view.width >= layout.editor.width * 0.5, `viewport is narrower than half the editor: ${JSON.stringify(layout)}`);
  await page.getByTestId('paint-tab-layers').click();
  const blendLabels = await page.getByTestId('paint-blend').locator('option').allTextContents();
  const blendValues = await page.getByTestId('paint-blend').locator('option').evaluateAll((options) => options.map((option) => option.value));
  assert.deepEqual(blendLabels, ['正常', '正片叠底', '滤色', '添加', '叠加', '柔光']);
  assert.deepEqual(blendValues, ['normal', 'multiply', 'screen', 'add', 'overlay', 'soft-light']);
  assert.equal(blendLabels.includes('multiply'), false);
  const openList = async (testId, place) => page.evaluate(({ id, place }) => {
    const select = document.querySelector(`[data-testid="${id}"]`);
    select.size = select.options.length;
    select.style.position = 'fixed';
    select.style.zIndex = '200';
    select.style.width = '220px';
    select.style.height = `${select.options.length * 32}px`;
    select.style.maxHeight = 'none';
    select.style.left = `${place.left}px`;
    select.style.top = `${place.top}px`;
  }, { id: testId, place });
  const closeList = async (testId) => page.evaluate((id) => {
    const select = document.querySelector(`[data-testid="${id}"]`);
    select.removeAttribute('size');
    select.style.position = '';
    select.style.zIndex = '';
    select.style.width = '';
    select.style.height = '';
    select.style.maxHeight = '';
    select.style.left = '';
    select.style.top = '';
  }, testId);
  await openList('paint-blend', { left: 980, top: 80 });
  await page.screenshot({ path: path.join(shots, 'paint-blend-labels.png'), clip: { x: 960, y: 60, width: 260, height: 280 } });
  await closeList('paint-blend');
  await page.getByTestId('paint-tab-paper').click();
  await openList('paint-paper-background', { left: 360, top: 80 });
  await openList('paint-paper-texture', { left: 600, top: 80 });
  await openList('paint-guides', { left: 840, top: 80 });
  await page.screenshot({ path: path.join(shots, 'paint-paper-labels.png'), clip: { x: 340, y: 60, width: 760, height: 280 } });
  for (const testId of ['paint-paper-background', 'paint-paper-texture', 'paint-guides']) await closeList(testId);
  await page.getByTestId('paint-guides').selectOption('thirds');
  await page.getByTestId('paint-tab-layers').click();
  await page.getByTestId('paint-size').fill('36');
  const stage = page.getByTestId('paint-stage');
  await pointerStroke(stage, [[30, 40], [180, 70], [220, 160]], { pointerType: 'pen', pressure: 0.35 });
  await pointerStroke(stage, [[240, 40], [300, 200]], { pointerType: 'pen', pressure: 0.9 });
  const ink = async () => Number(await page.getByTestId('paint-ink').innerText());
  const pixelLater = async (x, y) => page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('[data-testid="paint-stage"]');
    return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
  }, { x, y });
  assert.ok(await ink() > 0, 'pen pressure strokes left no ink');
  const drawn = await ink();
  await page.getByTestId('paint-palm').check();
  await pointerStroke(stage, [[20, 20], [80, 80]], { pointerType: 'touch', pressure: 1, width: 48 });
  assert.equal(await ink(), drawn, 'palm rejection let a touch stroke paint');
  const strokePixel = await pixelLater(270, 120);
  await page.locator('.paint-editor-bar h2').click();
  await page.keyboard.press('Control+z');
  await until(async () => (await pixelLater(270, 120)).every((channel, index) => channel === strokePixel[index]) === false || (await pixelLater(270, 120))[0] > strokePixel[0]);
  const undonePixel = await pixelLater(270, 120);
  await page.keyboard.press('Control+Shift+z');
  await until(async () => {
    const current = await pixelLater(270, 120);
    return current.some((channel, index) => channel !== undonePixel[index]);
  });
  assert.equal(await page.locator('.react-flow__node').count(), beforeNodes, 'editor undo changed the React Flow graph');
  await page.getByTestId('paint-hex').fill('#e10600');
  await page.getByTestId('paint-tool-select-rect').click();
  await pointerStroke(stage, [[40, 40], [160, 150]], { pointerType: 'mouse' });
  await page.locator('.paint-editor-bar h2').click();
  await page.keyboard.press('Alt+Delete');
  const filled = await pixelLater(90, 90);
  assert.ok(filled[0] > 180 && filled[1] < 40, `Alt+Delete did not fill the selection: ${filled}`);
  assert.deepEqual((await pixelLater(8, 8)).slice(0, 3), [255, 255, 255], 'Alt+Delete painted outside the selection');
  await page.getByTestId('paint-hex').fill('#2255aa');
  await page.getByTestId('paint-tool-brush').click();
  await pointerStroke(stage, [[70, 70], [120, 110]], { pointerType: 'pen', pressure: 0.8 });
  const pixel = pixelLater;
  const outside = await pixel(8, 8);
  assert.deepEqual(outside.slice(0, 3), [255, 255, 255], 'a clipped stroke painted outside the selection');
  const inside = await pixel(90, 90);
  assert.ok(inside[2] > inside[0], 'the blue stroke did not land inside the selection');
  await page.getByTestId('paint-tool-select-wand').click();
  await pointerStroke(stage, [[90, 90]], { pointerType: 'mouse' });
  await page.getByTestId('paint-tool-move').click();
  await pointerStroke(stage, [[90, 90], [110, 100]], { pointerType: 'mouse' });
  await page.locator('.paint-editor-bar h2').click();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await until(async () => await page.locator('.paint-layer').count() >= 2);
  await page.keyboard.press('Control+Shift+i');
  await page.keyboard.press('Alt+Delete');
  await page.getByTestId('paint-add-layer').click();
  await page.getByTestId('paint-layer-opacity').fill('60');
  await page.getByTestId('paint-blend').selectOption('multiply');
  await page.getByTestId('paint-tool-brush').click();
  await pointerStroke(stage, [[200, 80], [260, 140]], { pointerType: 'pen', pressure: 0.7 });
  await page.getByTestId('paint-output').selectOption('mask');
  await page.getByTestId('paint-save').click();
  let saved = await until(async () => {
    const doc = await api(`/api/projects/${fixture.id}`);
    const nodeData = doc.canvas.nodes.find((item) => item.id === 'paint1').data;
    return nodeData.assetPath ? doc : null;
  });
  let paintData = saved.canvas.nodes.find((item) => item.id === 'paint1').data;
  assert.equal(paintData.outputMode, 'mask');
  assert.match(paintData.assetPath, /^assets\//);
  assert.equal(JSON.stringify(paintData).includes('data:image'), false);
  assert.equal(JSON.stringify(paintData).includes('base64'), false);
  const maskSignature = paintData.paintSignature;
  await page.getByTestId('paint-output').selectOption('transparent');
  await pointerStroke(stage, [[150, 40], [190, 180]], { pointerType: 'pen', pressure: 0.6 });
  await page.getByTestId('paint-save').click();
  saved = await until(async () => {
    const doc = await api(`/api/projects/${fixture.id}`);
    const nodeData = doc.canvas.nodes.find((item) => item.id === 'paint1').data;
    return nodeData.paintSignature && nodeData.paintSignature !== maskSignature ? doc : null;
  });
  paintData = saved.canvas.nodes.find((item) => item.id === 'paint1').data;
  const downstream = imageProcessSnapshot('adjust', saved.canvas.nodes, saved.canvas.edges);
  assert.match(downstream.signature, new RegExp(paintData.paintSignature));
  await node('adjust').locator('.image-process-preview img').waitFor({ timeout: 15000 });
  await page.getByTestId('paint-extract').click();
  await page.getByTestId('paint-extract-mask').click();
  saved = await until(async () => {
    const doc = await api(`/api/projects/${fixture.id}`);
    const media = doc.canvas.nodes.filter((item) => item.type === 'media');
    return media.length >= 2 && media.some((item) => item.data.mediaRole === 'mask') ? doc : null;
  });
  await page.getByTestId('paint-abr-file').setInputFiles({ name: 'tip.abr', mimeType: 'application/octet-stream', buffer: abrSample() });
  await until(async () => /成功导入/.test(await page.getByTestId('paint-message').innerText()));
  await page.locator('[data-testid^="paint-brush-br_"]').last().click();
  await page.getByTestId('paint-tool-brush').click();
  await pointerStroke(stage, [[60, 200], [200, 240]], { pointerType: 'pen', pressure: 0.75 });
  await page.screenshot({ path: path.join(shots, 'paint-editor.png') });
  await page.locator('.paint-drawer.left').screenshot({ path: path.join(shots, 'paint-left-drawer.png') });
  await page.getByTestId('paint-layer-ops').screenshot({ path: path.join(shots, 'paint-layer-ops.png') });
  await page.getByTestId('paint-size').fill('120');
  await pointerStroke(stage, [[80, 220], [220, 250]], { pointerType: 'pen', pressure: 0.8 });
  const broad = await pixelLater(150, 235);
  assert.ok(broad[2] > 20 || broad[3] > 0, 'the enlarged abr tip left no mark');
  await page.screenshot({ path: path.join(shots, 'paint-abr-try.png') });
  await page.getByTestId('paint-tab-layers').click();
  const layerCount = await page.locator('.paint-layer').count();
  await page.getByTestId('paint-merge-down').click();
  await until(async () => await page.locator('.paint-layer').count() < layerCount);
  await page.locator('.paint-editor-bar h2').click();
  await page.keyboard.press('Control+z');
  await until(async () => await page.locator('.paint-layer').count() === layerCount);
  await page.getByTestId('paint-size').fill('4');
  await page.getByTestId('paint-rotation').fill('45');
  const hit = await page.evaluate(() => {
    const frame = document.querySelector('.paint-stage-frame');
    const parent = frame.offsetParent;
    const parentRect = parent.getBoundingClientRect();
    return { layoutLeft: parentRect.left + frame.offsetLeft - parent.scrollLeft, layoutTop: parentRect.top + frame.offsetTop - parent.scrollTop };
  });
  const target = forwardPaintViewport(300, 40, { ...hit, panX: 40, panY: 40, zoom: 1, rotation: 45, flip: false });
  const beforeHit = await pixelLater(300, 40);
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('[data-testid="paint-stage"]');
    const fire = (type, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'pen', pressure: 0.9, buttons, isPrimary: true,
    }));
    fire('pointerdown', 1);
    fire('pointerup', 0);
  }, target);
  const hitPixel = await pixelLater(300, 40);
  assert.ok(hitPixel.some((channel, index) => channel !== beforeHit[index]), `rotated stroke missed 300,40 (${hitPixel})`);
  const inkBeforeLan = await ink();
  await page.getByTestId('paint-lan-open').click();
  await page.getByTestId('paint-lan-code').waitFor();
  await page.getByTestId('paint-lan-card').scrollIntoViewIfNeeded();
  await page.getByTestId('paint-lan-card').screenshot({ path: path.join(shots, 'paint-lan-qr.png') });
  const link = await page.getByTestId('paint-lan-link').innerText();
  assert.match(link, /^http:\/\/[^/]+:\d+\/companion\?code=\d{6}$/);
  const lanPort = Number(new URL(link).port);
  assert.ok(!forbidden.has(lanPort));
  const tablet = await browser.newContext({ viewport: { width: 900, height: 700 }, hasTouch: true });
  const companion = await tablet.newPage();
  await companion.goto(link);
  await companion.getByTestId('companion-app').waitFor();
  await until(async () => (await companion.getByTestId('companion-status').getAttribute('data-state')) === 'live');
  await companion.getByTestId('companion-layers').click();
  await companion.getByTestId('companion-layer-drawer').waitFor();
  const companionInk = async () => Number(await companion.getByTestId('companion-ink').innerText());
  const inkAtOpen = await companionInk();
  await pointerStroke(companion.getByTestId('companion-stage'), [[30, 30], [80, 70]], { pointerType: 'touch', pressure: 1, width: 12 });
  assert.equal(await companionInk(), inkAtOpen, 'palm rejection allowed a finger stroke');
  await companion.getByTestId('companion-size').fill('30');
  await pointerStroke(companion.getByTestId('companion-stage'), [[40, 40], [140, 90], [180, 150]], { pointerType: 'pen', pressure: 0.8 });
  const drawnInk = await companionInk();
  assert.ok(drawnInk > inkAtOpen, 'tablet stroke did not paint locally');
  await companion.getByTestId('companion-undo').click();
  await until(async () => await companionInk() < drawnInk);
  await pointerStroke(companion.getByTestId('companion-stage'), [[50, 60], [160, 110]], { pointerType: 'pen', pressure: 0.85 });
  await companion.screenshot({ path: path.join(shots, 'paint-lan-companion.png') });
  await until(async () => await ink() > inkBeforeLan, 10000);
  await page.getByTestId('paint-lan-save').click();
  await until(async () => {
    const doc = await api(`/api/projects/${fixture.id}`);
    const nodeData = doc.canvas.nodes.find((item) => item.id === 'paint1').data;
    return nodeData.paintSignature !== paintData.paintSignature ? doc : null;
  });
  await page.screenshot({ path: path.join(shots, 'paint-lan-synced.png') });
  await page.getByTestId('paint-lan-stop').click();
  await until(async () => {
    try {
      const response = await fetch(link.replace(/\/companion.*/, '/api/lan/session'));
      return response.status === 401 || response.status === 404 || !response.ok;
    } catch { return true; }
  });
  const closed = await fetch(link.replace(/\/companion.*/, '/api/lan/session')).catch(() => null);
  if (closed) assert.notEqual(closed.status, 200);
  assert.deepEqual(errors, []);
  console.log(`PAINT_E2E_OK port=${instance.port} lan=${lanPort}`);
} finally {
  await browser?.close().catch(() => {});
  if (backend.exitCode === null) backend.kill('SIGTERM');
  await rm(temporary, { recursive: true, force: true });
}
