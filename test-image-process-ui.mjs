import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, samePath } from './test-browser.mjs';
import { PHOTO_ADJUSTMENTS } from './src/photo-adjustments.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-image-process-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects, H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'), H3_COMFY_URL: 'http://127.0.0.1:1', H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1', PYTHONUTF8: '1' };
const backend = spawn(python, ['-X', 'utf8', 'video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; backend.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-3500); });
let browser; let base; let token;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await pause(100); } throw new Error('Image processing UI timed out'); }
async function api(route, payload, method = payload ? 'POST' : 'GET') {
  const response = await fetch(base + route, { method, headers: { 'X-H3-Token': token, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
try {
  const instance = await until(async () => { try { return JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); } catch { if (backend.exitCode !== null) throw new Error(logs); return null; } });
  base = `http://127.0.0.1:${instance.port}`; token = instance.token;
  const health = await api('/api/health'); assert.equal(health.pid, backend.pid); assert.ok(samePath(health.projectsRoot, projects));
  const position = (x, y) => ({ x, y });
  const fixture = await api('/api/projects', { name: 'Image processing synthetic QA', canvas: { nodes: [
    { id: 'base', type: 'media', position: position(20, 100), data: { kind: 'image', title: '底图', url: '' } },
    { id: 'overlay', type: 'media', position: position(20, 420), data: { kind: 'image', title: '叠加图', url: '' } },
    { id: 'mask', type: 'media', position: position(20, 740), data: { kind: 'image', title: '灰度遮罩', url: '' } },
    { id: 'adjust', type: 'imageProcess', position: position(420, 100), data: { mode: 'colorAdjust', title: '颜色调整', status: 'idle', brightness: 10 } },
    { id: 'blend', type: 'imageProcess', position: position(900, 100), data: { mode: 'imageBlend', title: '图像混合', status: 'idle', blendMode: 'multiply', opacity: 100, fit: 'cover' } },
  ], edges: [
    { id: 'base-adjust', source: 'base', target: 'adjust', sourceHandle: 'ref', targetHandle: 'guide' },
    { id: 'adjust-blend', source: 'adjust', target: 'blend', sourceHandle: 'ref', targetHandle: 'base' },
    { id: 'overlay-blend', source: 'overlay', target: 'blend', sourceHandle: 'ref', targetHandle: 'overlay' },
    { id: 'mask-blend', source: 'mask', target: 'blend', sourceHandle: 'ref', targetHandle: 'mask' },
  ], viewport: { x: 30, y: 30, zoom: 0.8 } } });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1250 } });
  await page.context().addCookies([{ name: 'h3_session', value: 'synthetic-production-session', url: base, httpOnly: true, sameSite: 'Strict' }]);
  const assetRequests = []; page.on('request', (request) => { if (/\/api\/projects\/prj_.*\/assets\//.test(request.url())) assetRequests.push(request.url()); });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base); await page.locator('.project-open').click();
  const cookies = await page.context().cookies();
  assert.equal(cookies.find((cookie) => cookie.name === 'h3_session').value, 'synthetic-production-session', 'development does not overwrite the production cookie');
  assert.equal(cookies.find((cookie) => cookie.name === `h3_session_${instance.port}`).value, token);
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const adjustmentSelect = node('adjust').getByLabel('调整类型');
  await adjustmentSelect.waitFor();
  assert.equal(await node('adjust').locator('.photo-adjustment-palette').count(), 0);
  assert.deepEqual(await adjustmentSelect.locator('option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent }))), PHOTO_ADJUSTMENTS.map(({ value, label }) => ({ value, label })));
  assert.equal(await node('adjust').getByLabel('调整类型').inputValue(), 'basic', 'missing adjustmentType retains the existing basic default');
  const png = async (color) => Buffer.from(await page.evaluate((color) => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 48);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color), 'base64');
  for (const [id, color] of [['base', 'rgb(100,150,200)'], ['overlay', 'rgb(128,128,128)'], ['mask', 'white']]) {
    await node(id).locator('input[type=file]').setInputFiles({ name: `${id}.png`, mimeType: 'image/png', buffer: await png(color) });
  }
  await node('adjust').locator('.image-process-preview img').waitFor();
  await node('adjust').getByRole('button', { name: '输出 PNG' }).click();
  const read = () => api(`/api/projects/${fixture.id}`);
  let saved = await until(async () => { const doc = await read(); return doc.canvas.nodes.find((n) => n.id === 'adjust')?.data.processedAssetPath ? doc : null; });
  assert.equal(saved.canvas.nodes.find((n) => n.id === 'adjust').data.brightness, 10);
  await node('blend').locator('.image-process-preview img').waitFor();
  await node('blend').getByRole('button', { name: '输出 PNG' }).click();
  saved = await until(async () => { const doc = await read(); return doc.canvas.nodes.find((n) => n.id === 'blend')?.data.status === 'done' ? doc : null; });
  const output = saved.canvas.nodes.find((n) => n.id === saved.canvas.nodes.find((n) => n.id === 'blend').data.processedResultId);
  assert.equal(output.data.width, 64); assert.equal(output.data.height, 48); assert.equal(output.data.output, true);
  assert.ok(saved.assets.some((asset) => asset.path === output.data.assetPath));
  const pixel = await page.evaluate(async (url) => { const bitmap = await createImageBitmap(await (await fetch(url)).blob()); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); return Array.from(ctx.getImageData(0, 0, 1, 1).data); }, output.data.url);
  // Brightness adds .1 to sRGB; multiply then applies a 128/255 layer.
  assert.deepEqual(pixel, [63, 88, 113, 255]);
  // Exercise the real upload path with an output still in this page's File cache.
  // Responses are intercepted before the backend; no generation is submitted.
  let uploads = 0;
  await page.route('**/api/comfy/upload/image', async (route) => { uploads += 1; await route.fulfill({ json: { name: 'synthetic-output.png', subfolder: 'workbench' } }); });
  await page.route('**/api/queue', async (route) => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'Synthetic queue stop' } }) : route.continue());
  const call = async (opId, tool, args, projectId = fixture.id) => {
    const current = await until(async () => {
      try { return await api(`/api/agent/canvas/current?projectId=${projectId}`); }
      catch (error) { if (/AMBIGUOUS_CANVAS|NO_VISIBLE_CANVAS/.test(error.message)) return null; throw error; }
    });
    await api('/api/agent/canvas/commands', { ...current, opId, tool, args });
    return until(async () => { const status = await api(`/api/agent/canvas/commands/${opId}`); return status.status === 'done' ? status.result : null; });
  };
  const generator = await call('qa-create-upscale', 'canvas_create_node', { preset: 'image_upscale', focus: false });
  assert.equal(generator.ok, true);
  assert.equal((await call('qa-connect-output', 'canvas_connect_nodes', { sourceId: output.id, targetId: generator.node.id })).ok, true);
  const submitted = await call('qa-output-as-input', 'canvas_generate_node', { nodeId: generator.node.id, wait: false });
  assert.equal(submitted.ok, false); assert.match(submitted.error, /Synthetic queue stop/); assert.equal(uploads, 1, 'new output passes media cache identity before upload');
  await call('qa-remove-upscale', 'canvas_delete_node', { nodeId: generator.node.id });
  await node('adjust').getByLabel('亮度数值').fill('20');
  await until(async () => !(await node('blend').getByRole('button', { name: '输出 PNG' }).isEnabled()));
  await until(async () => { const doc = await read(); return doc.canvas.nodes.find((n) => n.id === 'adjust').data.brightness === 20; });
  await page.reload();
  await node('adjust').getByLabel('亮度数值').waitFor();
  assert.equal(await node('adjust').getByLabel('亮度数值').inputValue(), '20');
  assert.equal(await node('blend').getByLabel('混合模式').inputValue(), 'multiply');
  assert.equal(await node('blend').getByRole('button', { name: '输出 PNG' }).isEnabled(), false, 'stale upstream is rejected after reopen');
  assert.equal((await read()).canvas.edges.find((e) => e.id === 'overlay-blend').targetHandle, 'overlay');
  assert.deepEqual((await api('/api/queue')).jobs, [], 'local processing must not submit any model job');
  // Each photo adjustment family preserves its own settings and yields a real PNG.
  const pixelAt = (url, x = 0) => page.evaluate(async ({ url, x }) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return Array.from(ctx.getImageData(x, 0, 1, 1).data);
  }, { url, x });
  const exportNode = async (id) => {
    const prior = (await read()).canvas.nodes.find((n) => n.id === id).data.processedResultId;
    await node(id).getByRole('button', { name: /^输出 PNG/ }).click();
    return until(async () => { const doc = await read(); const data = doc.canvas.nodes.find((n) => n.id === id).data; return data.status === 'done' && data.processedResultId !== prior ? doc.canvas.nodes.find((n) => n.id === data.processedResultId) : null; });
  };
  await node('base').locator('input[type=file]').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: await png('red') });
  await node('adjust').getByLabel('调整类型').selectOption('hsl');
  await node('adjust').getByLabel('HSL 色相数值').fill('120');
  const hslOutput = await exportNode('adjust');
  assert.deepEqual(await pixelAt(hslOutput.data.url), [0, 255, 0, 255]);
  await node('adjust').getByLabel('HSL 颜色范围').selectOption('red');
  await node('adjust').getByLabel('HSL 饱和度数值').fill('-30');
  await node('adjust').getByLabel('HSL 颜色范围').selectOption('blue');
  assert.equal(await node('adjust').getByLabel('HSL 饱和度数值').inputValue(), '0');
  await node('adjust').getByLabel('HSL 颜色范围').selectOption('red');
  assert.equal(await node('adjust').getByLabel('HSL 饱和度数值').inputValue(), '-30');
  await adjustmentSelect.selectOption('levels');
  assert.equal(await node('adjust').getByLabel('调整类型').inputValue(), 'levels');
  await node('adjust').locator('.photo-histogram .tone-histogram-fill').waitFor();
  await node('base').locator('input[type=file]').setInputFiles({ name: 'gray.png', mimeType: 'image/png', buffer: await png('rgb(150,150,150)') });
  await node('adjust').getByLabel('输入黑场数值').fill('100');
  await node('adjust').getByLabel('输入白场数值').fill('200');
  const levelsOutput = await exportNode('adjust');
  assert.deepEqual(await pixelAt(levelsOutput.data.url), [128, 128, 128, 255]);
  await node('adjust').getByLabel('色阶通道').selectOption('red');
  await node('adjust').getByLabel('输出白场数值').fill('200');
  const channelOutput = await exportNode('adjust');
  assert.deepEqual(await pixelAt(channelOutput.data.url), [100, 128, 128, 255]);
  // Replacing a connected mask creates an immutable media source and replaces only the mask edge.
  const maskBuffer = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 64, 48); ctx.fillStyle = 'red'; ctx.fillRect(32, 0, 32, 48);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await node('blend').getByLabel('上传混合遮罩').setInputFiles({ name: 'split-mask.png', mimeType: 'image/png', buffer: maskBuffer });
  saved = await until(async () => { const doc = await read(); const edge = doc.canvas.edges.find((e) => e.target === 'blend' && e.targetHandle === 'mask'); return edge && edge.source !== 'mask' ? doc : null; });
  const maskEdge = saved.canvas.edges.find((e) => e.target === 'blend' && e.targetHandle === 'mask');
  assert.ok(saved.canvas.nodes.find((n) => n.id === maskEdge.source).data.assetPath);
  assert.ok(saved.canvas.nodes.some((n) => n.id === 'mask'), 'replaced source remains available');
  assert.equal(saved.canvas.edges.filter((e) => e.target === 'blend' && e.targetHandle === 'mask').length, 1);
  await node('blend').getByLabel('混合模式').selectOption('normal');
  await node('blend').getByLabel('遮罩通道').selectOption('red');
  const maskOutput = await exportNode('blend');
  assert.deepEqual(await pixelAt(maskOutput.data.url, 0), [100, 128, 128, 255]);
  assert.deepEqual(await pixelAt(maskOutput.data.url, 63), [128, 128, 128, 255]);
  await node('blend').getByLabel('反相遮罩').check();
  const inverseOutput = await exportNode('blend');
  assert.deepEqual(await pixelAt(inverseOutput.data.url, 0), [128, 128, 128, 255]);
  assert.deepEqual(await pixelAt(inverseOutput.data.url, 63), [100, 128, 128, 255]);
  await page.reload();
  await node('adjust').getByLabel('调整类型').waitFor();
  assert.equal(await node('adjust').getByLabel('调整类型').inputValue(), 'levels');
  assert.equal(await node('adjust').getByLabel('色阶通道').inputValue(), 'red');
  assert.equal(await node('adjust').getByLabel('输出白场数值').inputValue(), '200');
  assert.equal(await node('blend').getByLabel('遮罩通道').inputValue(), 'red');
  assert.equal(await node('blend').getByLabel('反相遮罩').isChecked(), true);
  await node('adjust').getByLabel('调整类型').selectOption('hsl');
  await node('adjust').getByLabel('HSL 颜色范围').selectOption('master');
  assert.equal(await node('adjust').getByLabel('HSL 色相数值').inputValue(), '120');
  await node('adjust').getByLabel('调整类型').selectOption('basic');
  assert.equal(await node('adjust').getByLabel('亮度数值').inputValue(), '20');
  await node('adjust').getByLabel('调整类型').selectOption('levels');
  // Disconnect leaves the uploaded material intact, then reconnect using the current page bridge.
  await node('blend').getByRole('button', { name: '断开遮罩' }).click();
  await until(async () => !(await read()).canvas.edges.some((e) => e.target === 'blend' && e.targetHandle === 'mask'));
  assert.equal((await call('qa-mask-reconnect', 'canvas_connect_nodes', { sourceId: maskEdge.source, targetId: 'blend', targetHandle: 'mask' })).ok, true);
  // Full photo toolbox: actual mode dispatch, graphic controls at canvas zoom, and saved curves.
  const options = await node('adjust').getByLabel('调整类型').locator('option').evaluateAll((items) => items.map((item) => item.value));
  assert.equal(options.length, 17);
  for (const mode of options) {
    await node('adjust').getByLabel('调整类型').selectOption(mode);
    await node('adjust').locator('.image-process-preview img').waitFor();
    assert.equal(await node('adjust').locator('.image-process-error').count(), 0, mode);
  }
  await node('adjust').getByLabel('调整类型').selectOption('exposure');
  await node('adjust').getByLabel('曝光（EV）数值').fill('1');
  assert.deepEqual(await pixelAt((await exportNode('adjust')).data.url), [255, 255, 255, 255]);
  await node('adjust').getByLabel('调整类型').selectOption('whiteBalance');
  await node('adjust').getByLabel('色温数值').fill('25');
  assert.deepEqual(await pixelAt((await exportNode('adjust')).data.url), [163, 150, 137, 255]);
  await node('adjust').getByLabel('调整类型').selectOption('invert');
  assert.deepEqual(await pixelAt((await exportNode('adjust')).data.url), [105, 105, 105, 255]);
  await node('adjust').getByLabel('调整类型').selectOption('threshold');
  await node('adjust').getByLabel('阈值数值').fill('151');
  assert.deepEqual(await pixelAt((await exportNode('adjust')).data.url), [0, 0, 0, 255]);
  await node('adjust').getByLabel('调整类型').selectOption('posterize');
  await node('adjust').getByLabel('色阶数数值').fill('2');
  assert.deepEqual(await pixelAt((await exportNode('adjust')).data.url), [255, 255, 255, 255]);
  await node('adjust').getByLabel('调整类型').selectOption('colorBalance');
  await node('adjust').getByLabel('青色 ↔ 红色数值').fill('20');
  await node('adjust').getByLabel('保持明度').uncheck();
  const balanced = await pixelAt((await exportNode('adjust')).data.url);
  assert.ok(balanced[0] > 150); assert.deepEqual(balanced.slice(1), [150, 150, 255]);
  await node('adjust').getByLabel('色调范围').selectOption('shadows');
  assert.equal(await node('adjust').getByLabel('青色 ↔ 红色数值').inputValue(), '0');
  await node('adjust').getByLabel('色调范围').selectOption('midtones');
  assert.equal(await node('adjust').getByLabel('青色 ↔ 红色数值').inputValue(), '20');
  await node('adjust').getByLabel('调整类型').selectOption('levels');
  await node('adjust').getByLabel('色阶通道').selectOption('rgb');
  assert.equal(await node('adjust').locator('input[type=range]').count(), 0, 'Levels uses histogram handles, not range inputs');
  const blackHandle = node('adjust').getByRole('slider', { name: '输入黑场控制点', exact: true });
  const handleBox = await blackHandle.boundingBox(); const levelGraph = await node('adjust').getByRole('group', { name: '色阶波峰图' }).boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2); await page.mouse.down();
  await page.mouse.move(levelGraph.x + (8 + 80) / 271 * levelGraph.width, handleBox.y + handleBox.height / 2, { steps: 6 }); await page.mouse.up();
  assert.ok(Math.abs(Number(await node('adjust').getByLabel('输入黑场数值').inputValue()) - 80) <= 1);
  assert.equal((await read()).canvas.nodes.find((n) => n.id === 'adjust').position.x, 420, 'dragging tone handles does not move the canvas node');
  await blackHandle.focus(); await page.keyboard.press('ArrowRight');
  assert.ok(Number(await node('adjust').getByLabel('输入黑场数值').inputValue()) > 80);
  await mkdir(path.join(root, '.cache', 'feature-dev', 'qa'), { recursive: true });
  await node('adjust').locator('.image-process-preview img').waitFor();
  await node('adjust').screenshot({ path: path.join(root, '.cache', 'feature-dev', 'qa', 'levels-v3-ui.png') });
  const retainedBlack = await node('adjust').getByLabel('输入黑场数值').inputValue();
  await adjustmentSelect.selectOption('curves');
  assert.equal(await node('adjust').getByLabel('调整类型').inputValue(), 'curves');
  const graph = node('adjust').getByRole('group', { name: '曲线编辑图' });
  await graph.waitFor(); const curveBox = await graph.boundingBox();
  const graphPoint = (x, y) => ({ x: curveBox.x + (x + 8) / 271 * curveBox.width, y: curveBox.y + (263 - y) / 271 * curveBox.height });
  const startPoint = graphPoint(150, 180);
  await page.mouse.click(startPoint.x, startPoint.y);
  assert.equal(await graph.getByRole('slider').count(), 3);
  const midpointHandle = graph.getByRole('slider', { name: '曲线控制点 2', exact: true });
  const pointBox = await midpointHandle.boundingBox(); const movedPoint = graphPoint(150, 200);
  await page.mouse.move(pointBox.x + pointBox.width / 2, pointBox.y + pointBox.height / 2); await page.mouse.down(); await page.mouse.move(movedPoint.x, movedPoint.y, { steps: 6 }); await page.mouse.up();
  assert.ok(Math.abs(Number(await node('adjust').getByLabel('曲线输出数值').inputValue()) - 200) <= 1);
  await node('adjust').getByLabel('曲线输入数值').fill('150'); await node('adjust').getByLabel('曲线输出数值').fill('200');
  assert.deepEqual(await pixelAt((await exportNode('adjust')).data.url), [200, 200, 200, 255]);
  await node('adjust').getByLabel('曲线通道').selectOption('red');
  assert.equal(await graph.getByRole('slider').count(), 2);
  await node('adjust').getByRole('button', { name: '提亮', exact: true }).click();
  await node('adjust').getByLabel('曲线通道').selectOption('rgb');
  assert.equal(await graph.getByRole('slider').count(), 3);
  await adjustmentSelect.selectOption('levels');
  assert.equal(await node('adjust').getByLabel('输入黑场数值').inputValue(), retainedBlack, 'selector switching retains level settings');
  await adjustmentSelect.selectOption('curves');
  assert.equal(await graph.getByRole('slider').count(), 3, 'selector switching retains curve points');
  await page.reload(); await node('adjust').getByLabel('曲线通道').waitFor();
  assert.equal(await node('adjust').getByLabel('调整类型').inputValue(), 'curves');
  assert.equal(await node('adjust').getByRole('group', { name: '曲线编辑图' }).getByRole('slider').count(), 3);
  await node('adjust').locator('.image-process-preview img').waitFor();
  await node('adjust').screenshot({ path: path.join(root, '.cache', 'feature-dev', 'qa', 'curves-v3-ui.png') });
  // A parameter patch on a different family is retained but leaves the active signature unchanged.
  const stateBefore = await call('qa-v3-before-inactive', 'canvas_get_state', { nodeId: 'adjust' });
  assert.equal((await call('qa-v3-edit-inactive', 'canvas_update_node', { nodeId: 'adjust', settings: { exposure: { exposure: 2 } } })).ok, true);
  const stateAfter = await call('qa-v3-after-inactive', 'canvas_get_state', { nodeId: 'adjust' });
  assert.deepEqual(stateAfter.nodes[0].processingSettings, stateBefore.nodes[0].processingSettings);
  await node('adjust').getByLabel('调整类型').selectOption('exposure');
  assert.equal(await node('adjust').getByLabel('曝光（EV）数值').inputValue(), '2');
  await node('adjust').getByLabel('调整类型').selectOption('levels');
  await until(async () => (await read()).canvas.nodes.find((item) => item.id === 'adjust').data.adjustmentType === 'levels');
  // Four real grayscale assets pack into independent raw channels and persist a downloadable TGA.
  const packCreated = await call('qa-create-rgba', 'canvas_create_node', { preset: 'rgba_pack', title: 'RGBA 合并测试', focus: true });
  assert.equal(packCreated.ok, true); const packId = packCreated.node.id;
  for (const [label, value] of [['R', 64], ['G', 128], ['B', 192], ['A', 32]]) {
    await node(packId).getByLabel(`${label} 通道贴图`, { exact: true }).setInputFiles({ name: `${label}.png`, mimeType: 'image/png', buffer: await png(`rgb(${value},${value},${value})`) });
    await until(async () => (await read()).canvas.edges.some((edge) => edge.target === packId && edge.targetHandle === ({ R: 'red', G: 'green', B: 'blue', A: 'alpha' })[label]));
  }
  const packedOutput = await exportNode(packId);
  saved = await read(); let packData = saved.canvas.nodes.find((n) => n.id === packId).data;
  assert.ok(packData.processedTgaAssetPath?.endsWith('.tga'));
  assert.equal(packedOutput.data.tgaAssetPath, packData.processedTgaAssetPath);
  assert.ok(saved.assets.some((asset) => asset.path === packData.processedTgaAssetPath && asset.mime === 'image/x-tga'));
  const tgaBytes = async (asset, projectId = fixture.id) => {
    const response = await fetch(`${base}/api/projects/${projectId}/${asset}`, { headers: { 'X-H3-Token': token } }); assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
  };
  let packedBytes = await tgaBytes(packData.processedTgaAssetPath);
  assert.equal(packedBytes.length, 18 + 64 * 48 * 4); assert.equal(packedBytes[2], 2); assert.equal(packedBytes[16], 32); assert.equal(packedBytes[17], 0x28);
  assert.equal(packedBytes.readUInt16LE(12), 64); assert.equal(packedBytes.readUInt16LE(14), 48);
  assert.deepEqual([...packedBytes.subarray(18, 22)], [192, 128, 64, 32]);
  const downloadEvent = page.waitForEvent('download'); await node(packId).getByRole('link', { name: '下载 TGA' }).click();
  const packedDownload = await downloadEvent; assert.equal(packedDownload.suggestedFilename(), 'RGBA 合并测试.tga');
  const packedDownloadPath = await packedDownload.path(); assert.deepEqual(await readFile(packedDownloadPath), packedBytes);
  // Zero output alpha must retain all raw RGB bytes, including when the packed node feeds another packing node.
  await node(packId).getByLabel('A 通道贴图', { exact: true }).setInputFiles({ name: 'A-zero.png', mimeType: 'image/png', buffer: await png('black') });
  await until(async () => !(await node(packId).getByRole('button', { name: '输出 PNG + TGA', exact: true }).isDisabled()));
  const zeroOutput = await exportNode(packId); saved = await read(); packData = saved.canvas.nodes.find((n) => n.id === packId).data;
  packedBytes = await tgaBytes(packData.processedTgaAssetPath); assert.deepEqual([...packedBytes.subarray(18, 22)], [192, 128, 64, 0]);
  const chained = await call('qa-create-rgba-chain', 'canvas_create_node', { preset: 'rgba_pack', focus: false }); assert.equal(chained.ok, true);
  assert.equal((await call('qa-connect-rgba-chain', 'canvas_connect_nodes', { sourceId: packId, targetId: chained.node.id, targetHandle: 'red' })).ok, true);
  assert.equal((await call('qa-set-rgba-chain', 'canvas_update_node', { nodeId: chained.node.id, settings: { packChannels: { red: { source: 'red' } } } })).ok, true);
  assert.equal((await call('qa-output-rgba-chain', 'canvas_generate_node', { nodeId: chained.node.id, wait: false })).ok, true);
  const chainData = (await read()).canvas.nodes.find((n) => n.id === chained.node.id).data;
  assert.deepEqual([...(await tgaBytes(chainData.processedTgaAssetPath)).subarray(18, 22)], [0, 0, 64, 255]);
  // Replacing an output media node must clear its raw attachment before downstream reads.
  assert.equal((await call('qa-connect-replaced-output', 'canvas_connect_nodes', { sourceId: zeroOutput.id, targetId: chained.node.id, targetHandle: 'red' })).ok, true);
  await node(zeroOutput.id).locator('input[type=file]').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: await png('rgb(99,99,99)') });
  await until(async () => { const data = (await read()).canvas.nodes.find((n) => n.id === zeroOutput.id).data; return data.name === 'replacement.png' && !data.tgaAssetPath; });
  assert.equal((await call('qa-output-replaced-input', 'canvas_generate_node', { nodeId: chained.node.id, wait: false })).ok, true);
  const replacedData = (await read()).canvas.nodes.find((n) => n.id === chained.node.id).data;
  assert.deepEqual([...(await tgaBytes(replacedData.processedTgaAssetPath)).subarray(18, 22)], [0, 0, 99, 255]);
  const selectPackView = async (view) => {
    const previous = await node(packId).locator('.image-process-preview img').getAttribute('src');
    await node(packId).getByLabel('通道预览').selectOption(view);
    await until(async () => {
      const images = node(packId).locator('.image-process-preview img');
      return await images.count() && (await images.getAttribute('src')) !== previous;
    });
  };
  const previewPixel = async () => {
    const image = node(packId).locator('.image-process-preview img');
    await until(() => image.evaluate((element) => element.complete && element.naturalWidth > 0));
    return image.evaluate((element) => {
      const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(element, 0, 0);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
  };
  await selectPackView('alpha');
  assert.deepEqual(await previewPixel(), [0, 0, 0, 255]);
  await selectPackView('rgb');
  assert.deepEqual(await previewPixel(), [64, 128, 192, 255]);
  await node(packId).screenshot({ path: path.join(root, '.cache', 'feature-dev', 'qa', 'rgba-v4-ui.png') });
  // Reopen verifies saved TGA path and download, with no extra backend/generation write.
  await until(async () => (await read()).canvas.nodes.find((n) => n.id === packId).data.packPreview === 'rgb');
  await page.reload(); await node(packId).getByRole('link', { name: '下载 TGA' }).waitFor();
  assert.ok((await node(packId).getByRole('link', { name: '下载 TGA' }).getAttribute('href')).includes(packData.processedTgaAssetPath));
  // Opening a duplicate must never keep URLs pointing at the original project.
  const duplicate = await api(`/api/projects/${fixture.id}/duplicate`, {});
  const opened = await call('qa-open-duplicate', 'canvas_open_project', { projectId: duplicate.id });
  assert.equal(opened.ok, true);
  await node('adjust').getByLabel('输入黑场数值').waitFor();
  const duplicateOutput = node(output.id).locator('img').first();
  await duplicateOutput.waitFor();
  // Persistent thumbnails deliberately avoid original downloads on open. Request
  // the actual original through the visible preview before checking its project.
  await node(output.id).locator('.media-preview').dblclick();
  await until(async () => assetRequests.some((url) => url.includes(`/api/projects/${duplicate.id}/${output.data.assetPath}`)));
  await page.locator('.image-lightbox img').waitFor();
  await page.keyboard.press('Escape');
  assert.equal((await call('qa-save-duplicate', 'canvas_update_node', { nodeId: 'blend', title: '混合副本' }, duplicate.id)).ok, true);
  const duplicateSaved = await until(async () => { const doc = await api(`/api/projects/${duplicate.id}`); return doc.canvas.nodes.find((n) => n.id === output.id).data.url?.includes(`/api/projects/${duplicate.id}/`) ? doc : null; });
  assert.ok(duplicateSaved.canvas.nodes.find((n) => n.id === output.id).data.url.includes(`/api/projects/${duplicate.id}/`));
  // The copied project opens at its saved viewport; include the packed node in
  // view before querying its UI because ReactFlow virtualizes offscreen nodes.
  await page.getByTitle('适应画布', { exact: true }).click();
  assert.ok((await node(packId).getByRole('link', { name: '下载 TGA' }).getAttribute('href')).startsWith(`/api/projects/${duplicate.id}/`));
  assert.deepEqual(await tgaBytes(packData.processedTgaAssetPath, duplicate.id), packedBytes);
  await until(async () => duplicateOutput.evaluate((image) => image.complete && image.naturalWidth === 64));
  await node('adjust').locator('.image-process-preview img').waitFor();
  await mkdir(path.join(root, '.cache', 'feature-dev', 'qa'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.cache', 'feature-dev', 'qa', 'image-processing-ui.png') });
  assert.deepEqual(errors, []);
  console.log('IMAGE_PROCESS_UI_OK pixel=63,88,113,255 originalSize=true persisted=true staleChainRejected=true outputAsAIInput=true duplicatedAssetURL=true hsl=true levels=true maskUpload=true maskInvert=true toolbox17=true levelsDrag=true curvesDrag=true persistedCurves=true rgba=true tga32=true zeroAlphaRGB=true rawChain=true replacementRawCleared=true download=true modelJobs=0');
} catch (error) {
  console.error('IMAGE_PROCESS_UI_DIAGNOSTIC', JSON.stringify({ backendExitCode: backend.exitCode, backendLogs: logs }));
  throw error;
} finally {
  if (browser) await browser.close();
  if (base) spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
  if (backend.exitCode === null) backend.kill();
  for (let i = 0; i < 50 && backend.exitCode === null; i += 1) await pause(100);
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('h3-image-process-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
