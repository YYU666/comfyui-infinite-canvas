import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// Synthetic browser fixture: every request is intercepted; no live inference/service.
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const origin = 'http://127.0.0.1:8799';
const browser = await chromium.launch({ headless: true });
const failures = [], queued = [];
const makeProject = (readOnly = false) => ({ id: 'prj_qwen_fixture', name: 'Qwen references fixture', revision: 1, readOnly, shots: [], canvas: {
  viewport: { x: 20, y: 30, zoom: 0.9 },
  nodes: [
    ...['地编截图', '场景氛围', '手绘笔触'].map((title, i) => ({ id: `image${i + 1}`, type: 'media', position: { x: 20, y: 10 + i * 240 }, data: { kind: 'image', title, refTag: `<Picture ${i + 1}>`, ...(i === 2 ? { output: true, metadata: { width: 320, height: 180 }, sourcePromptId: 'fixture-existing-result' } : {}), remoteName: `${i + 1}.png`, url: `${origin}/fixture-${i + 1}.svg` } })),
    { id: 'qwen', type: 'generator', selected: true, position: { x: 420, y: 40 }, data: { mode: 'qwenEdit', title: '保留的概念设计标题', prompt: '保留图1的路线，使用图2的场景氛围。', qwenSteps: 40, seed: 42, randomSeed: false, status: 'idle' } },
    { id: 'prompt', type: 'prompt', position: { x: -900, y: 0 }, data: { title: 'Prompt fixture', idea: '保留地形' } },
  ], edges: [
    { id: 'old-style', source: 'image2', target: 'qwen', sourceHandle: 'ref', targetHandle: 'identity' },
    { id: 'old-guide', source: 'image1', target: 'qwen', sourceHandle: 'ref', targetHandle: 'guide' },
  ],
} });
async function fixture(readOnly = false) {
  let project = makeProject(readOnly);
  let maskBytes;
  const context = await browser.newContext({ viewport: { width: 1360, height: 1040 } });
  await context.addInitScript(() => {
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'no external request may escape fixture');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname.startsWith('/fixture-')) return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${url.pathname.includes('1') ? '#526477' : url.pathname.includes('2') ? '#6e6960' : '#807169'}"/><path d="M0 150L110 60L220 120L320 25V180H0" fill="#aaa79b"/></svg>` });
    if (url.pathname.startsWith(`/api/projects/${project.id}/assets/`)) {
      if (request.method() === 'PUT') {
        maskBytes = request.postDataBuffer(); project.revision++;
        return json({ revision: project.revision, asset: { path: 'assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png' } });
      }
      return route.fulfill({ contentType: 'image/png', body: maskBytes });
    }
    if (url.pathname === '/api/comfy/upload/image') return json({ name: 'mask.png', subfolder: 'workbench' });
    if (url.pathname === '/api/comfy/view') return route.fulfill({ contentType: 'image/png', body: maskBytes });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') return readOnly && !request.postDataJSON()?.readOnly ? json({ error: 'locked' }, 423) : json(project);
    if (url.pathname === `/api/projects/${project.id}`) {
      if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
      return json(project);
    }
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'native fixture only' }, 503);
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') {
      if (request.method() === 'POST') { queued.push(request.postDataJSON()); return json({ id: 'job-fixture', status: 'queued' }); }
      return json({ jobs: [] });
    }
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin); await page.locator('.project-open').click();
  await page.getByLabel('Qwen 模型版本').waitFor();
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  return { page, context, call, saved: () => project };
}
try {
  const { page, context, call, saved } = await fixture();
  assert.equal(await page.locator('[data-testid="rf__node-image3"] [data-handleid="mask"]').count(), 0, 'result images have no mask input');
  const generator = page.locator('[data-id="qwen"]');
  await generator.getByRole('button', { name: '+ 添加遮罩' }).click();
  let state = await call('canvas_get_state');
  const mask = state.nodes.find((node) => node.mediaRole === 'mask');
  assert.ok(mask);
  assert.ok(state.edges.some((edge) => edge.source === 'image1' && edge.target === mask.id && edge.targetHandle === 'guide'));
  assert.ok(state.edges.some((edge) => edge.source === mask.id && edge.target === 'qwen' && edge.targetHandle === 'mask'));
  assert.equal(state.nodes.find((node) => node.id === 'qwen').referenceCount, 2);
  const tile = page.locator(`[data-id="${mask.id}"]`);
  await tile.getByRole('button', { name: '绘制遮罩', exact: true }).click();
  const paint = page.locator('.mask-paint-canvas');
  await page.getByRole('button', { name: '保存到遮罩节点' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.mask-save').disabled);
  const box = await paint.boundingBox();
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .45);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .65, box.y + box.height * .45, { steps: 5 }); await page.mouse.up();
  const maskGraphBefore = await call('canvas_get_state');
  const graphIdentity = (value) => ({ nodes: value.nodes.map((node) => node.id), edges: value.edges });
  const paintedPixels = () => paint.evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; for (let index = 3; index < data.length; index += 4) if (data[index]) count++;
    return count;
  });
  assert.ok(await paintedPixels() > 0);
  await page.keyboard.press('Control+z');
  assert.equal(await paintedPixels(), 0, 'mask undo removes the stroke');
  assert.deepEqual(graphIdentity(await call('canvas_get_state')), graphIdentity(maskGraphBefore), 'mask undo must not undo the canvas graph');
  for (const key of ['Control+Shift+z', 'Control+y', 'Control+d', 'Delete', 'Backspace']) {
    await page.keyboard.press(key);
    assert.deepEqual(graphIdentity(await call('canvas_get_state')), graphIdentity(maskGraphBefore), `${key} must not reach canvas shortcuts`);
  }
  await page.getByRole('button', { name: '保存到遮罩节点' }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.mask-editor-backdrop'))), true, 'Tab stays in the mask editor');
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .45);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .65, box.y + box.height * .45, { steps: 5 }); await page.mouse.up();
  await page.getByRole('button', { name: '保存到遮罩节点' }).click();
  await page.getByRole('dialog', { name: '母图遮罩绘制' }).waitFor({ state: 'hidden' });
  // Bridge import uses the same base association and preserves the dedicated role.
  const imported = await call('canvas_import_asset', { nodeId: mask.id, assetPath: 'assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', name: 'imported-mask.png' }); assert.equal(imported.ok, true, JSON.stringify(imported));
  state = await call('canvas_get_state');
  assert.equal(state.nodes.find((node) => node.id === mask.id).maskSourceId, 'image1');
  await mkdir('.cache/qwen-mask-ui', { recursive: true });
  await page.getByTestId(`rf__node-${mask.id}`).screenshot({ path: '.cache/qwen-mask-ui/mask-node.png' });
  assert.match(JSON.stringify(await call('canvas_connect_nodes', { sourceId: mask.id, targetId: 'qwen', targetHandle: 'references' })), /遮罩端口/);
  assert.match(JSON.stringify(await call('canvas_connect_nodes', { sourceId: 'image3', targetId: 'qwen', targetHandle: 'mask' })), /局部遮罩修改/);
  // Reload persists role, mask input, and source binding; it never becomes image3.
  await page.reload(); await page.waitForFunction(() => window.fixtureTools.has('canvas_get_state'));
  await call('canvas_focus_node', { nodeId: 'qwen' });
  state = await call('canvas_get_state', { nodeId: 'qwen' });
  assert.equal(state.nodes[0].referenceCount, 2); assert.equal(state.nodes[0].maskNodeId, mask.id);
  await call('canvas_connect_nodes', { sourceId: 'image2', targetId: mask.id });
  assert.match(JSON.stringify(await call('canvas_generate_node', { nodeId: 'qwen' })), /底图/);
  assert.equal(queued.length, 0);
  await call('canvas_connect_nodes', { sourceId: 'image1', targetId: mask.id });
  await page.getByLabel('局部放大重绘', { exact: true }).check();
  await call('canvas_generate_node', { nodeId: 'qwen' });
  assert.equal(queued.length, 1);
  const busyBefore = await call('canvas_get_state');
  assert.match(JSON.stringify(await call('canvas_connect_nodes', { sourceId: mask.id, targetId: 'qwen', targetHandle: 'mask' })), /生成期间|正在生成/);
  const busyAfter = await call('canvas_get_state');
  assert.equal(busyAfter.nodeCount, busyBefore.nodeCount);
  assert.deepEqual(busyAfter.edges, busyBefore.edges);
  assert.deepEqual(queued[0].workflow.sample.inputs.latent_image, ['mask_latent', 0]);
  assert.equal(queued[0].workflow.mask_crop.class_type, 'InpaintCropImproved');
  assert.deepEqual(queued[0].workflow.encode.inputs['images.image_1'], ['mask_crop', 1]);
  assert.equal(queued[0].workflow.mask_stitch.class_type, 'InpaintStitchImproved');
  assert.equal(queued[0].workflow[queued[0].workflow.save.inputs.images[0]].class_type, 'ImageCompositeMasked');
  assert.equal(queued[0].workflow.encode.inputs['images.image_3'], undefined);
  const blocked = await call('canvas_delete_node', { nodeId: mask.id });
  assert.equal(blocked.ok, false);
  assert.equal((await call('canvas_get_state', { nodeId: mask.id })).nodes[0].id, mask.id);
  assert.deepEqual(failures, []);
  await context.close();
  console.log('QWEN_MASK_UI_OK create/draw/save/import/reload, mask separate from refs, stale source blocked, real masked queue graph, running delete blocked');
} finally { await browser.close(); }
