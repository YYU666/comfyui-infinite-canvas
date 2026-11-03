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
    ...['地编截图', '场景氛围', '手绘笔触'].map((title, i) => ({ id: `image${i + 1}`, type: 'media', position: { x: 20, y: 10 + i * 240 }, data: { kind: 'image', title, remoteName: `${i + 1}.png`, url: `${origin}/fixture-${i + 1}.svg` } })),
    { id: 'qwen', type: 'generator', selected: true, position: { x: 420, y: 40 }, data: { mode: 'qwenEdit', title: '保留的概念设计标题', prompt: '保留图1的路线，使用图2的场景氛围。', qwenSteps: 40, seed: 42, randomSeed: false, status: 'idle' } },
    { id: 'prompt', type: 'prompt', position: { x: -900, y: 0 }, data: { title: 'Prompt fixture', idea: '保留地形' } },
  ], edges: [
    { id: 'old-style', source: 'image2', target: 'qwen', sourceHandle: 'ref', targetHandle: 'identity' },
    { id: 'old-guide', source: 'image1', target: 'qwen', sourceHandle: 'ref', targetHandle: 'guide' },
  ],
} });
async function fixture(readOnly = false) {
  let project = makeProject(readOnly);
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
  return { page, context, call };
}
try {
  const { page, context, call } = await fixture();
  await page.mouse.click(1200, 200, { button: 'right' });
  const menu = page.getByRole('menu', { name: '添加节点' });
  await menu.waitFor();
  assert.equal(await menu.getByRole('button', { name: /^图生图/ }).count(), 1);
  assert.equal(await menu.getByRole('button', { name: /^Qwen.*图生图/ }).count(), 0);
  await page.getByLabel('关闭添加节点菜单').click();
  const node = page.locator('.creator-toolbar[data-id="qwen"]');
  const shell = page.getByTestId('rf__node-qwen');
  assert.equal(await node.locator('.qwen-reference-item').count(), 2);
  assert.deepEqual(await node.locator('.qwen-reference-name').allTextContents(), ['地编截图', '场景氛围']);
  assert.equal(await shell.locator('.react-flow__handle.target[data-handleid="references"]').count(), 1);
  assert.equal(await shell.locator('.react-flow__handle.target[data-handleid="guide"],.react-flow__handle.target[data-handleid="identity"]').count(), 0);
  assert.match(JSON.stringify(await call('canvas_get_state', { nodeId: 'qwen' })), /保留的概念设计标题/);
  const promptConnected = await call('canvas_connect_nodes', { sourceId: 'prompt', targetId: 'qwen' });
  assert.equal(promptConnected.ok, false, 'H3 prompt optimizer cannot connect to an image editor');
  assert.match(promptConnected.error, /提示词只连接视频/);
  await call('canvas_focus_node', { nodeId: 'qwen' });
  await shell.click();
  await page.locator('.creator-toolbar[data-id="qwen"] .qwen-reference-item').first().waitFor();
  await call('canvas_connect_nodes', { sourceId: 'image3', targetId: 'qwen' });
  assert.equal(await node.locator('.qwen-reference-item').count(), 3);
  const edit = node.getByLabel('图片提示词');
  await edit.fill('保留图1的地形和路线，参考图2的城镇氛围与光线。使用图3的手绘笔触、松弛边缘和概括色块，保持镜头、透视、建筑体块及可通行区域。');
  await node.getByRole('button', { name: '前移图3', exact: true }).click();
  assert.match(await edit.inputValue(), /参考图3.*使用图2/);
  const beforeReload = await edit.inputValue();
  assert.equal((await call('canvas_update_node', { nodeId: 'qwen', title: '保留的概念设计标题' })).ok, true);
  await page.reload();
  await page.getByTestId('rf__node-qwen').waitFor();
  await page.getByTestId('rf__node-qwen').click();
  await edit.waitFor();
  assert.equal(await edit.inputValue(), beforeReload, 'saved prompts preserve identity after reload');
  assert.deepEqual(await node.locator('.qwen-reference-name').allTextContents(), ['地编截图', '手绘笔触', '场景氛围']);
  await node.getByRole('button', { name: '后移图2', exact: true }).click();
  assert.match(await edit.inputValue(), /参考图2.*使用图3/);
  await edit.evaluate((element) => { element.focus(); element.setSelectionRange(element.value.length, element.value.length); });
  await node.getByRole('button', { name: '插入图3引用', exact: true }).click();
  assert.match(await edit.inputValue(), /图3 $/);
  const evidence = path.resolve('.cache/qwen-multireference');
  await mkdir(evidence, { recursive: true });
  await node.screenshot({ path: path.join(evidence, 'qwen-three-references.jpg'), type: 'jpeg', quality: 75 });
  await node.getByRole('button', { name: '断开图3', exact: true }).click();
  assert.match(await edit.inputValue(), /已断开的图片引用/);
  const rejected = await call('canvas_generate_node', { nodeId: 'qwen' });
  assert.match(JSON.stringify(rejected), /已断开/);
  assert.equal(queued.length, 0);
  await call('canvas_connect_nodes', { sourceId: 'image3', targetId: 'qwen', targetHandle: 'identity' });
  assert.doesNotMatch(await edit.inputValue(), /已断开/);
  const state = await call('canvas_get_state', { nodeId: 'qwen', includePrompt: true });
  assert.match(JSON.stringify(state), /referenceNodeIds/);
  assert.doesNotMatch(JSON.stringify(state), /qref:/);
  // MCP prompt updates must settle on the normalized bound value rather than time out.
  const updated = await call('canvas_update_node', { nodeId: 'qwen', prompt: '保留图1的结构，参考图2氛围，使用图3的笔触。' });
  assert.equal(updated.ok, true);
  await node.getByLabel('Qwen 模型版本').selectOption('turbo');
  assert.match(await node.innerText(), /8 步 · Turbo/);
  await call('canvas_generate_node', { nodeId: 'qwen' });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].workflow.encode.inputs.prompt, '保留<image1>的结构，参考<image2>氛围，使用<image3>的笔触。');
  assert.equal(queued[0].workflow.sigmas.inputs.sigmas.split(',').length, 9);
  assert.equal(await node.getByLabel('Qwen 模型版本').isDisabled(), true);
  assert.equal(await edit.isDisabled(), true);
  assert.equal(await node.getByRole('button', { name: '前移图3', exact: true }).isDisabled(), true);
  const duplicate = await call('canvas_connect_nodes', { sourceId: 'image3', targetId: 'qwen' });
  assert.match(JSON.stringify(duplicate), /生成期间|正在生成/);
  const prewritten = await call('canvas_create_node', { preset: 'qwen_edit', prompt: '图1笔触', x: 5000, y: 0 });
  const first = await call('canvas_create_node', { preset: 'image_asset', x: 5300, y: 0 });
  const second = await call('canvas_create_node', { preset: 'image_asset', x: 5600, y: 0 });
  assert.equal((await call('canvas_connect_nodes', { sourceId: first.node.id, targetId: prewritten.node.id })).ok, true);
  assert.equal((await call('canvas_delete_node', { nodeId: first.node.id })).ok, true);
  assert.equal((await call('canvas_connect_nodes', { sourceId: second.node.id, targetId: prewritten.node.id })).ok, true);
  const replacement = await call('canvas_get_state', { nodeId: prewritten.node.id, includePrompt: true });
  assert.match(replacement.nodes[0].prompt, /已断开的图片引用/, 'prewritten ordinal binds on first connection and never silently retargets after deletion');
  await context.close();
  const readonly = await fixture(true);
  assert.equal(await readonly.page.getByLabel('Qwen 模型版本').isDisabled(), true);
  assert.equal(await readonly.page.getByLabel('图片提示词').isDisabled(), true);
  assert.equal(await readonly.page.getByLabel('Qwen 采样步数').isDisabled(), true);
  const beforeReadOnly = await readonly.call('canvas_get_state');
  await readonly.page.evaluate(() => document.activeElement?.blur());
  await readonly.page.keyboard.press('Control+d');
  await readonly.page.keyboard.press('Control+c');
  await readonly.page.keyboard.press('Control+v');
  await readonly.page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['fixture'], 'readonly.png', {type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste', {clipboardData:transfer,bubbles:true,cancelable:true}));
  });
  assert.equal((await readonly.call('canvas_get_state')).nodes.length, beforeReadOnly.nodes.length, 'readonly duplicate/node paste/image paste cannot create transient nodes');
  assert.equal(await readonly.page.locator('.dock-add').isDisabled(), true);
  await readonly.context.close();
  assert.deepEqual(failures, []);
  console.log('QWEN_UI_OK single menu, legacy migration, insert/reorder/save/reload/remove/reconnect, prewritten prompt identity, missing-ref blocks queue, MCP prompt, H3 optimizer rejection, three-input Turbo, readonly/running');
} finally { await browser.close(); }
