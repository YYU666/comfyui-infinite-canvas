import assert from 'node:assert/strict';
import { IMAGE_MODEL_BY_ID, modelNodeClasses } from './src/image-model-catalog.js';
import { chromium } from './test-browser.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const origin = 'http://127.0.0.1:8799';
const definitions = {};
function ensure(name) {
  definitions[name] = definitions[name] || { input: { required: {} } };
  return definitions[name];
}
function add(node, input, value) {
  const bucket = ensure(node).input.required[input] || [[]];
  ensure(node).input.required[input] = bucket;
  if (!bucket[0].includes(value)) bucket[0].push(value);
}
for (const model of Object.values(IMAGE_MODEL_BY_ID)) {
  for (const name of modelNodeClasses(model, { editing: true, hasMask: true, hasMaskCrop: true, hasSourceCrop: true, imageLora: 'realism' })) ensure(name);
  for (const entry of model.files) add(entry.loader === 'unet' ? 'UNETLoader' : entry.loader === 'clip' ? 'CLIPLoader' : 'VAELoader', entry.loader === 'unet' ? 'unet_name' : entry.loader === 'clip' ? 'clip_name' : 'vae_name', entry.name);
  add('CLIPLoader', 'type', model.clipType);
}
let hideH3 = false;
const browser = await chromium.launch({ headless: true });
const failures = [];
const saves = [];
let project = { id: 'prj_picker', name: '选模', revision: 1, readOnly: false, shots: [], settings: { ratio: '16:9', resolution: '480P', duration: 5 }, canvas: {
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'image', type: 'generator', selected: true, position: { x: 80, y: 80 }, data: { mode: 'image', title: '文生图', prompt: '一张椅子', imageModel: 'krea2', ratio: '1:1', seed: 7, randomSeed: false, status: 'done', resultUrl: `${origin}/fixture.svg`, promptId: 'prompt-1' } },
    { id: 'edit', type: 'generator', position: { x: 700, y: 80 }, data: { mode: 'qwenEdit', title: '图生图', prompt: '保留图1', qwenModel: 'standard', seed: 7, randomSeed: false, status: 'idle' } },
  ],
  edges: [],
} };
const initialProject = structuredClone(project);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => {
  window.fixtureTools = new Map();
  Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
  window.EventSource = class { addEventListener() {} close() {} };
  window.WebSocket = class { addEventListener() {} close() {} };
});
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(url.origin, origin);
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (url.pathname === '/fixture.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#678"/></svg>' });
  if (url.pathname === '/api/projects') return json({ projects: [project] });
  if (url.pathname === '/api/projects/trash') return json({ projects: [] });
  if (url.pathname === '/api/projects/open') return json(project);
  if (url.pathname === `/api/projects/${project.id}`) {
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      saves.push(body);
      project = { ...project, ...body, revision: project.revision + 1 };
    }
    return json(project);
  }
  if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'native fixture only' }, 503);
  if (url.pathname === '/api/health') return json({ ok: true, comfy: { state: 'ready' } });
  if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
  if (url.pathname === '/api/queue') return json({ jobs: [] });
  if (url.pathname.startsWith('/api/comfy/object_info/')) {
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    if (hideH3 && name === 'MiniMaxH3ImageConditioning') return json({});
    return json({ [name]: definitions[name] || { input: { required: {} } } });
  }
  if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
  if (url.pathname.startsWith('/api/')) return json({});
  const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
});
const page = await context.newPage();
page.on('pageerror', (error) => failures.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
try {
  await page.goto(origin);
  await page.locator('.project-open').click();
  await page.getByLabel('生图模型').waitFor();
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  const picked = await call('canvas_pick_image_model', { nodeId: 'image', prompt: '雨夜街道的环境概念图' });
  assert.equal(picked.ok, true, picked.error);
  assert.equal(picked.model, 'h3_image');
  assert.equal(picked.field, 'imageModel');
  assert.match(picked.announcement, /^自动选了 H3-Image（场景概念 · 已安装/);
  await page.getByText('自动选了 H3-Image（场景概念 · 已安装）').waitFor();
  await page.getByLabel('生图模型').selectOption('krea2');
  await page.getByText('已手动锁定 Krea2').waitFor();
  const locked = await call('canvas_pick_image_model', { nodeId: 'image', prompt: '雨夜街道的环境概念图' });
  assert.equal(locked.ok, true, locked.error);
  assert.equal(locked.changed, false);
  assert.equal(locked.model, 'krea2');
  await page.getByRole('button', { name: '收下' }).click();
  await page.locator('.image-review button.active', { hasText: '收下' }).waitFor();
  const reviewed = (await call('canvas_get_state', { nodeId: 'image' })).nodes[0];
  assert.equal(reviewed.imageReview.accepted, true);
  assert.equal(reviewed.imageReview.model, 'krea2');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !saves.some((body) => body.settings?.imageModelHistory?.some((record) => record.accepted === true && record.model === 'krea2' && record.nodeId === 'image' && record.resultKey === 'prompt-1'))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(saves.some((body) => body.settings?.imageModelHistory?.some((record) => record.accepted === true && record.model === 'krea2' && record.nodeId === 'image' && record.resultKey === 'prompt-1')));
  assert.equal(failures.filter((item) => !item.includes('503')).length, 0, failures.join('\n'));

  hideH3 = true;
  project = structuredClone(initialProject);
  const hiddenPage = await context.newPage();
  hiddenPage.on('pageerror', (error) => failures.push(error.message));
  await hiddenPage.goto(origin);
  await hiddenPage.locator('.project-open').click();
  await hiddenPage.getByLabel('生图模型').waitFor();
  const hiddenCall = (name, args = {}) => hiddenPage.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  const missing = await hiddenCall('canvas_pick_image_model', { nodeId: 'edit', model: 'h3_image' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /H3-Image 还缺少：ComfyUI 节点 MiniMaxH3ImageConditioning/);
  assert.match(missing.error, /没有换成别的模型/);
  const edit = (await hiddenCall('canvas_get_state', { nodeId: 'edit' })).nodes[0];
  assert.equal(edit.qwenModel, 'standard');
  assert.equal(edit.modelLockedByUser, false);
  assert.equal(failures.filter((item) => !item.includes('503')).length, 0, failures.join('\n'));
  await hiddenPage.close();
  console.log('IMAGE_MODEL_PICKER_UI_OK');
} finally {
  await context.close();
  await browser.close();
}
