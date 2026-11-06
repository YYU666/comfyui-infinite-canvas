import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from './test-browser.mjs';
import { canInspectNode, inspectionQuery, isInspectorMessage } from './src/workflow-inspector.js';

const root = process.cwd();
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || path.join(root, 'dist'));
const bridge = await readFile(path.join(root, 'comfy-nodes/h3_workbench_refine/web/workbench-inspector.js'), 'utf8');
const nonce = 'fixture-inspector-nonce-1234';
const graph = { source: { class_type: 'LoadImage', inputs: { image: 'saved-front.png' } }, save: { class_type: 'SaveImage', inputs: { images: ['source', 0] } } };
function nativeGraph(value) {
  const links = new Map();
  const nodes = Object.entries(value).map(([id, definition]) => {
    const inputs = [];
    for (const [name, input] of Object.entries(definition.inputs)) {
      if (Array.isArray(input) && value[input[0]]) {
        const link = links.size + 1;
        links.set(link, { origin_id: input[0], origin_slot: input[1] }); inputs.push({ name, link });
      }
    }
    return { id, type: definition.class_type, constructor: { comfyClass: definition.class_type, nodeData: { name: definition.class_type } }, inputs, getInputLink(slot) { return links.get(this.inputs[slot]?.link); } };
  });
  return { _nodes: nodes, links };
}
const frameWindow = {};
const reply = { source: frameWindow, origin: 'http://127.0.0.1:8188', data: { channel: 'h3-workflow-inspector', version: 1, nonce } };
assert.equal(isInspectorMessage(reply, frameWindow, nonce), true);
for (const change of [{ source: {} }, { origin: 'https://evil.test' }, { data: { ...reply.data, nonce: 'old' } }, { data: { ...reply.data, version: 2 } }]) assert.equal(isInspectorMessage({ ...reply, ...change }, frameWindow, nonce), false);
assert.deepEqual(inspectionQuery('p', { id: 'old-result', type: 'media', data: { sourcePromptId: 'old-prompt' } }, [{ source: 'generator', target: 'old-result', targetHandle: 'preview' }]), { projectId: 'p', promptId: 'old-prompt', nodeId: 'generator' });
assert.deepEqual(inspectionQuery('p', { id: 'generator', type: 'generator', data: { queueJobId: 'new-job', promptId: 'previous-attempt' } }), { projectId: 'p', nodeId: 'generator', jobId: 'new-job' });
assert.equal(canInspectNode({ type: 'generator', data: {} }), true);
assert.equal(canInspectNode({ type: 'media', data: { sourcePromptId: 'old' } }), true);
assert.equal(canInspectNode({ type: 'media', data: {} }), false);

// Run both checkout line endings against the native-app-shaped fake.
for (const newline of ["\n", "\r\n"]) {
  const checkoutBridge = bridge.replace(/\r?\n/g, newline);
  const handlers = {};
  const sent = [];
  const loads = [];
  const parent = { postMessage: (message) => sent.push(message) };
  const app = { isGraphReady: true, extensionManager: { spinner: true }, canvas: {}, graph: { _nodes: [], links: {} },
    registerExtension(extension) { extension.setup(); },
    async loadApiJson(value, name) { loads.push({ value, name }); this.graph = nativeGraph(value); } };
  vm.runInNewContext(checkoutBridge.replace(/^import .*;\r?\n/, ''), { app, URLSearchParams, location: { hash: `#h3-inspector=${nonce}` }, window: { parent, addEventListener: (type, handler) => { handlers[type] = handler; } }, Date, console });
  const envelope = { channel: 'h3-workflow-inspector', version: 1, nonce, type: 'hello' };
  const message = (data = envelope, overrides = {}) => handlers.message({ source: parent, origin: 'http://127.0.0.1:8799', data, ...overrides });
  message(); assert.equal(sent.length, 0, 'extension setup must not race frontend workflow restoration');
  app.extensionManager.spinner = false;
  for (const overrides of [{ source: {} }, { origin: 'http://127.0.0.1:8800' }, { origin: 'http://evil.test:8790' }, { data: { ...envelope, nonce: 'wrong' } }]) message(envelope, overrides);
  assert.equal(sent.length, 0);
  message(); assert.equal(sent[0].type, 'ready');
  message({ ...envelope, type: 'load', requestId: 'one', name: 'Sheet', graph });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loads.length, 1); assert.ok(loads[0].name.includes(nonce));
  assert.equal(sent.at(-1).type, 'loaded'); assert.equal(sent.at(-1).nodeCount, 2); assert.equal(sent.at(-1).linkCount, 1);
  app.loadApiJson = async () => { app.graph = nativeGraph(graph); app.graph._nodes[0].has_errors = true; };
  message({ ...envelope, type: 'load', requestId: 'two', graph });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.at(-1).type, 'loaded', 'registered LoadImage resource warnings are not missing-class placeholders');
  assert.equal(sent.at(-1).warningCount, 1);
  app.loadApiJson = async () => { app.graph = nativeGraph(graph); app.graph._nodes[0].has_errors = true; app.graph._nodes[0].constructor = {}; };
  message({ ...envelope, type: 'load', requestId: 'missing-type', graph });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.at(-1).type, 'error', 'missing node placeholders must not pass counts');
  app.loadApiJson = async () => { app.graph = nativeGraph(graph); app.graph.links.get(1).origin_slot = 9; };
  message({ ...envelope, type: 'load', requestId: 'three', graph });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.at(-1).type, 'error', 'missing native connections must fail acknowledgement');
  assert.equal(bridge.includes('queuePrompt('), false, 'opening never queues a prompt');
}

const origin = 'http://127.0.0.1:8799';
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4ioAAAAASUVORK5CYII=';
const project = { id: 'prj_fixture', name: 'Inspector isolated fixture', revision: 1, shots: [], canvas: { viewport: { x: 0, y: 0, zoom: 0.75 }, edges: [], nodes: [
  { id: 'sheet', type: 'generator', position: { x: 60, y: 80 }, data: { title: 'Sheet fixture', mode: 'characterSheet', status: 'done', prompt: 'fixture', queueJobId: 'job_new', promptId: 'new-p5', resultUrl: pixel, qwenSteps: 40 } },
  { id: 'old-result', type: 'media', position: { x: 670, y: 100 }, data: { kind: 'image', title: 'Old output fixture', url: pixel, sourcePromptId: 'old-p5', sourceQueueJobId: 'job_old', sourceGeneratorId: 'sheet', output: true } },
  { id: 'never', type: 'generator', position: { x: 1200, y: 80 }, data: { title: 'Never run fixture', mode: 'characterSheet', status: 'idle', prompt: '' } },
  { id: 'ordinary', type: 'media', position: { x: 670, y: 700 }, data: { kind: 'image', title: 'Ordinary asset fixture', url: pixel } },
] } };
const stages = ['front_portrait', 'three_quarter_portrait', 'back_body', 'front_body', 'stitch'].map((id) => ({ id, label: id, graph, executed: true, provenance: 'persisted-plan' }));
let browser;
const inspectionRequests = [];
const writes = [];
const promptPosts = [];
const appStub = `${nativeGraph.toString()}\nexport const app={isGraphReady:true,extensionManager:{spinner:true},canvas:{},graph:{_nodes:[],links:{}},registerExtension(extension){extension.setup();setTimeout(()=>this.extensionManager.spinner=false,30);},async loadApiJson(graph,name){this.graph=nativeGraph(graph);window.loadedGraph=graph;document.getElementById('loaded').textContent=name;}};`;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
  await context.addInitScript(() => {
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (request.method() === 'POST' && (url.pathname.endsWith('/prompt') || url.pathname === '/api/queue')) promptPosts.push(request.url());
    if (url.origin === 'http://127.0.0.1:8188') {
      if (url.pathname === '/scripts/app.js') return route.fulfill({ contentType: 'text/javascript', body: appStub });
      if (url.pathname === '/extension.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><p id="loaded">Comfy fixture</p><script type="module" src="/extension.js"></script>' });
    }
    assert.equal(url.origin, origin, 'all requests stay in intercepted synthetic origins');
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') {
      if (!request.postDataJSON().readOnly) return json({ code: 'LOCKED', message: 'fixture read-only' }, 423);
      return json(project);
    }
    if (url.pathname === '/api/projects/prj_fixture') {
      if (request.method() !== 'GET') writes.push(request.method());
      return json(project);
    }
    if (url.pathname === '/api/queue/inspect') {
      inspectionRequests.push(Object.fromEntries(url.searchParams));
      if (url.searchParams.get('nodeId') === 'never') return json({ code: 'NO_EXECUTION', message: '尚无执行记录' }, 404);
      return json({ projectId: project.id, nodeId: 'sheet', jobId: url.searchParams.get('jobId'), defaultStage: 'front_portrait', stages });
    }
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({ code: 'NO_TEST_TRANSPORT', message: 'fixture uses native tools' }, 503);
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ contentType, body: await readFile(file) });
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.locator('.project-open').waitFor({timeout: 5000}).catch(async (error) => { console.error('FIXTURE_DEBUG', await page.locator('body').innerText(), errors); throw error; });
  await page.locator('.project-open').click();
  const sheet = page.locator('.react-flow__node[data-id="sheet"]');
  await sheet.locator('.generator-preview').dblclick();
  await page.locator('.image-lightbox').waitFor();
  assert.equal(await page.locator('.workflow-inspector').count(), 0, 'generator image double-click keeps large preview');
  await page.keyboard.press('Escape');
  await sheet.locator('input[aria-label="节点名称"]').dblclick();
  assert.equal(await page.locator('.workflow-inspector').count(), 0, 'editing a title is not inspection');
  await sheet.locator('.neo-node-title svg').dblclick();
  assert.equal(await page.locator('.workflow-inspector').count(), 0, 'double-click no longer opens workflow inspection');
  await sheet.locator('.neo-node-title svg').click({ button: 'right' });
  assert.equal(await page.getByRole('button', { name: /^打开文件位置/ }).count(), 1, 'existing context action remains available');
  await page.getByRole('button', { name: /^进入 ComfyUI/ }).click();
  await page.waitForSelector('.workflow-inspector-confirmation');
  assert.equal(await page.locator('.workflow-inspector nav button').count(), 5);
  assert.equal(inspectionRequests.at(-1).jobId, 'job_new');
  await page.locator('.workflow-inspector nav button').filter({ hasText: 'three_quarter_portrait' }).click();
  await page.waitForFunction(() => document.querySelector('.workflow-inspector-confirmation')?.textContent.includes('three_quarter_portrait'));
  await mkdir(path.join(root, '.cache/workflow-inspector-review'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.cache/workflow-inspector-review/isolated-inspector.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.workflow-inspector', { state: 'detached' });
  const media = page.locator('.react-flow__node[data-id="old-result"]');
  await media.locator('.neo-node-title svg').click({ button: 'right' });
  await page.getByRole('button', { name: /^进入 ComfyUI/ }).click();
  await page.waitForSelector('.workflow-inspector-confirmation');
  assert.equal(inspectionRequests.at(-1).jobId, 'job_old');
  assert.equal(inspectionRequests.at(-1).promptId, 'old-p5');
  await page.getByRole('button', { name: '关闭工作流查看' }).click();
  await media.locator('.media-preview').dblclick();
  await page.locator('.image-lightbox').waitFor();
  assert.equal(await page.locator('.workflow-inspector').count(), 0, 'media preview keeps its existing action');
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__node[data-id="ordinary"] .neo-node-title svg').click({ button: 'right' });
  assert.equal(await page.getByRole('button', { name: /^进入 ComfyUI/ }).count(), 0, 'ordinary assets do not offer an invalid workflow action');
  assert.equal(await page.getByRole('button', { name: /^打开文件位置/ }).count(), 1);
  await page.getByRole('button', { name: '关闭节点菜单' }).click();
  await page.locator('.react-flow__node[data-id="never"] .neo-node-title svg').click({ button: 'right' });
  await page.getByRole('button', { name: /^进入 ComfyUI/ }).click();
  await page.getByRole('alert').filter({ hasText: '尚无执行记录' }).waitFor();
  assert.equal(await page.locator('.workflow-inspector iframe').count(), 0);
  await page.getByRole('button', { name: '关闭工作流查看' }).click();
  const toolResult = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_inspect_node').execute({ nodeId: 'sheet', stage: 'three_quarter_portrait' })));
  assert.equal(toolResult.ok, true); assert.equal(toolResult.opened, true); assert.equal(toolResult.nodeCount, 2); assert.equal(toolResult.linkCount, 1);
  await page.getByRole('button', { name: '关闭工作流查看' }).click();
  await page.mouse.dblclick(1680, 920);
  assert.equal(await page.getByRole('menu', { name: '添加节点' }).count(), 0, 'read-only blank canvas cannot open a mutation menu');
  assert.equal(await page.locator('.workflow-inspector').count(), 0);
  assert.deepEqual(promptPosts, []); assert.deepEqual(writes, [], 'read-only inspection never persists the project');
  assert.equal(context.pages().length, 1); assert.deepEqual(errors, []);
  console.log('WORKFLOW_INSPECTOR_OK context menu entry, double-click preview/add preserved, ordinary asset excluded, old result, read-only, no record, ACK, handshake filters, no generation');
} finally { await browser?.close(); }

// Explicit opt-in uses only a fresh ComfyUI browser context and synthetic nodes.
// Every prompt submission is blocked; no H3 project endpoint is opened.
if (process.env.H3_INSPECTOR_NATIVE_TEST === '1') {
  // The fulfilled synthetic parent has no real server address; Chromium's
  // local-network checks otherwise replace its loopback iframe with an error
  // page. This exception applies only to this fresh optional test browser.
  const nativeBrowser = await chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
  const promptRequests = [];
  try {
    const context = await nativeBrowser.newContext();
    await context.route('**/prompt', (route) => { promptRequests.push(route.request().url()); return route.abort(); });
    await context.route('**/workbench-inspector.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: bridge }));
    await context.route(`${origin}/native-fixture`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe src="http://127.0.0.1:8188/#h3-inspector=${nonce}"></iframe>` }));
    const page = await context.newPage();
    await page.goto(`${origin}/native-fixture`);
    await page.evaluate(({ nonce, graph }) => {
      window.nativeReplies = [];
      const frame = document.querySelector('iframe');
      const send = (payload) => frame.contentWindow.postMessage({ channel: 'h3-workflow-inspector', version: 1, nonce, ...payload }, 'http://127.0.0.1:8188');
      window.fixtureSend = send;
      const interval = setInterval(() => send({ type: 'hello' }), 250);
      window.addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow || event.origin !== 'http://127.0.0.1:8188' || event.data.nonce !== nonce) return;
        window.nativeReplies.push(event.data);
        if (event.data.type === 'ready') { clearInterval(interval); send({ type: 'load', requestId: 'native-valid', name: 'Isolated registered LoadImage warning', graph }); }
      });
    }, { nonce, graph: { angle_source: { class_type: 'LoadImage', inputs: { image: 'nonexistent-inspector-fixture.png' } }, save: { class_type: 'SaveImage', inputs: { images: ['angle_source', 0], filename_prefix: 'never-executed-fixture' } } } });
    await page.waitForFunction(() => window.nativeReplies.some((row) => row.requestId === 'native-valid'), null, { timeout: 20000 }).catch(async (error) => { console.error('NATIVE_DEBUG', await page.evaluate(() => window.nativeReplies), await Promise.all(page.frames().map(async (frame) => ({url: frame.url(), state: await frame.evaluate(() => ({hash: location.hash, app: !!window.comfyAPI?.app?.app, spinner: window.comfyAPI?.app?.app?.extensionManager?.spinner})).catch(() => null)})))); throw error; });
    const valid = await page.evaluate(() => window.nativeReplies.find((row) => row.requestId === 'native-valid'));
    assert.equal(valid.type, 'loaded', JSON.stringify(valid)); assert.equal(valid.nodeCount, 2); assert.equal(valid.linkCount, 1); assert.ok(valid.warningCount >= 1);
    await page.evaluate(() => window.fixtureSend({ type: 'load', requestId: 'native-missing', name: 'Isolated missing node', graph: { missing: { class_type: 'H3InspectorDeliberatelyMissingClass', inputs: {} } } }));
    await page.waitForFunction(() => window.nativeReplies.some((row) => row.requestId === 'native-missing'));
    const missing = await page.evaluate(() => window.nativeReplies.find((row) => row.requestId === 'native-missing'));
    assert.equal(missing.type, 'error', JSON.stringify(missing)); assert.match(missing.error, /H3InspectorDeliberatelyMissingClass/);
    assert.deepEqual(promptRequests, []);
    console.log('NATIVE_INSPECTOR_OK installed frontend: registered LoadImage warning accepted, actual missing placeholder rejected, 2 nodes/1 link, no prompt POST');
  } finally { await nativeBrowser.close(); }
}
