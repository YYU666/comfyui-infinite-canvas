import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

// Every browser request is intercepted. This fixture never opens a real project
// or sends a request to ComfyUI; job events are synthetic contract examples.
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const origin = 'http://127.0.0.1:8799';
const browser = await chromium.launch({ headless: true });
const failures = [];
const assetPath = `assets/${'a'.repeat(64)}.mp4`;
let missingRtx = false;
const objectInfo = () => ({
  LoadVideo: {}, GetVideoComponents: {}, CreateVideo: {}, SaveVideo: {},
  ...(missingRtx ? {} : { RTXVideoSuperResolution: { input: { required: {
    images: ['IMAGE', {}],
    resize_type: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'scale by multiplier', inputs: { required: { scale: ['FLOAT', { min: 1, max: 4 }] } } }] }],
    quality: ['COMBO', { options: ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'] }],
    strength: ['FLOAT', { min: 0, max: 1 }],
    image_encoding: ['COMBO', { options: ['8-bit RGB'] }],
  } }, output: ['IMAGE'] } }),
});

async function fixture(readOnly = false, active = false) {
  let project = { id: 'prj_upscale_fixture', name: 'Video upscale fixture', revision: 1, readOnly, shots: [], canvas: {
    viewport: { x: 20, y: 20, zoom: 0.9 },
    nodes: [{ id: 'upscale', type: 'generator', selected: true, position: { x: 440, y: 50 }, data: {
      mode: 'videoSuperResolution', title: '视频超分', videoUpscaleModel: 'rtx', videoUpscaleScale: 2,
      rtxQuality: 'ULTRA', rtxStrength: 1, seed: 42, randomSeed: false, status: active ? 'running' : 'idle',
      ...(active ? { queueJobId: 'job-readonly-active', promptId: 'prompt-readonly-active', stage: '本地 GPU 生成中', progress: 30 } : {}),
    } }], edges: [],
  } };
  const queued = [], uploads = [], assetWrites = [], cancelled = [];
  const context = await browser.newContext({ viewport: { width: 1360, height: 1040 } });
  await context.addInitScript(() => {
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) {
      window.fixtureTools.set(tool.name, tool);
      options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name));
    } } });
    const sources = new Set();
    window.EventSource = class {
      constructor(url) { this.url = url; this.listeners = new Map(); sources.add(this); }
      addEventListener(type, callback) { this.listeners.set(type, callback); }
      close() { sources.delete(this); }
    };
    window.fixtureEmit = (type, payload) => {
      for (const source of sources) if (source.url === '/api/queue/events') source.listeners.get(type)?.({ data: JSON.stringify(payload) });
    };
    window.WebSocket = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'no external request may escape this fixture');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') return readOnly && !request.postDataJSON()?.readOnly ? json({ error: 'locked' }, 423) : json(project);
    if (url.pathname === `/api/projects/${project.id}`) {
      if (request.method() === 'PUT') project = { ...project, ...request.postDataJSON(), revision: project.revision + 1 };
      return json(project);
    }
    if (url.pathname.startsWith(`/api/projects/${project.id}/assets/`)) {
      if (request.method() === 'PUT') {
        assetWrites.push(url.pathname);
        project = { ...project, revision: project.revision + 1 };
        return json({ revision: project.revision, asset: { path: assetPath } });
      }
      return route.fulfill({ contentType: 'video/mp4', body: Buffer.from('synthetic video fixture') });
    }
    if (url.pathname === '/api/health') return json({ ok: true, comfy: { state: 'ready' } });
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') {
      if (request.method() === 'POST') {
        queued.push(request.postDataJSON());
        return json({ id: `job-${queued.length}`, status: 'queued' });
      }
      return json({ jobs: active ? [{ id: 'job-readonly-active', projectId: project.id, nodeId: 'upscale', status: 'running', comfyPromptId: 'prompt-readonly-active', progress: 30 }] : [] });
    }
    if (/^\/api\/queue\/[^/]+\/cancel$/.test(url.pathname)) { cancelled.push(url.pathname); return json({ cancelled: true }); }
    if (url.pathname === '/api/comfy/object_info') return json(objectInfo());
    if (url.pathname.startsWith('/api/comfy/object_info/')) {
      const name = url.pathname.split('/').at(-1);
      return json(objectInfo()[name] ? { [name]: objectInfo()[name] } : {});
    }
    if (url.pathname === '/api/comfy/upload/image') { uploads.push(request.postDataBuffer()); return json({ name: 'upscale-source.mp4', subfolder: 'workbench' }); }
    if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
    if (url.pathname === '/api/comfy/view') return route.fulfill({ contentType: 'video/mp4', body: Buffer.from('synthetic output fixture') });
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'native fixture only' }, 503);
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(origin); await page.locator('.project-open').click();
  await page.getByLabel('视频超分模型').waitFor();
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  const emit = (type, payload) => page.evaluate(({ type, payload }) => window.fixtureEmit(type, payload), { type, payload });
  const state = () => call('canvas_get_state');
  const waitState = async predicate => {
    let current;
    for (let i = 0; i < 100; i++) { current = await state(); if (predicate(current)) return current; await page.waitForTimeout(30); }
    throw new Error(`Synthetic canvas state did not settle: ${JSON.stringify({ nodes: current?.nodes, edges: current?.edges, alerts: await page.getByRole('alert').allTextContents() })}`);
  };
  return { page, context, call, state, waitState, emit, queued, uploads, assetWrites, cancelled, saved: () => project };
}

try {
  const f = await fixture(); const { page, call } = f;
  const node = page.getByTestId('rf__node-upscale');
  assert.equal(await node.getByRole('button', { name: '开始超分' }).isDisabled(), true, 'source required');
  await page.mouse.click(1200, 200, { button: 'right' });
  const menu = page.getByRole('menu', { name: '添加节点' }); await menu.waitFor();
  assert.equal(await menu.getByRole('button', { name: /^视频超分/ }).count(), 1, 'one tidy menu entry');
  await page.keyboard.press('Escape');
  const upload = async name => {
    await node.locator('input[type=file]').setInputFiles({ name, mimeType: 'video/mp4', buffer: Buffer.from('synthetic upload fixture') });
    await f.waitState(s => {
      const edge = s.edges.find(e => e.target === 'upscale' && e.targetHandle === 'guide');
      const source = s.nodes.find(n => n.id === edge?.source);
      return source?.title === name.replace(/\.[^.]+$/, '') && Boolean(source.media?.assetPath);
    });
    // addNode animates the newly uploaded media into view. Let that scheduled
    // animation finish before testing the processor's controls.
    await page.waitForTimeout(450);
  };
  await upload('first-source.mp4');
  await upload('replacement-source.mp4');
  let state = await f.state();
  const guides = state.edges.filter(e => e.target === 'upscale');
  assert.equal(guides.length, 1, 'single-source replacement must not stack guide edges');
  assert.equal(guides[0].targetHandle, 'guide');
  assert.match(state.nodes.find(n => n.id === guides[0].source).title, /replacement-source/);
  assert.equal(f.assetWrites.length, 2, 'uploads persist source assets before use');
  await call('canvas_focus_node', { nodeId: 'upscale' });
  await page.waitForTimeout(500);
  await page.getByLabel('视频超分模型').selectOption('seedvr2_3b');
  assert.equal(await page.getByLabel('RTX 超分质量').count(), 0);
  await page.getByText('时间分块采样；视频帧仍占用主内存。', { exact: false }).waitFor();
  await page.getByLabel('视频超分模型').selectOption('rtx');
  await page.getByLabel('视频超分倍率').selectOption('3');
  await page.getByLabel('RTX 超分质量').selectOption('HIGH');
  await page.getByLabel('RTX 超分强度').fill('0.7');
  state = await f.state();
  assert.equal(state.nodes.find(n => n.id === 'upscale').videoUpscaleScale, 3);
  assert.equal(state.nodes.find(n => n.id === 'upscale').rtxStrength, 0.7);
  await node.getByRole('button', { name: '开始超分' }).click();
  await f.waitState(s => s.nodes.find(n => n.id === 'upscale')?.queueJobId === 'job-1');
  assert.equal(f.queued.length, 1);
  assert.equal(f.uploads.length, 1, 'active guide alone uploaded to local Comfy input');
  const workflow = f.queued[0].workflow;
  assert.equal(workflow.source.inputs.file, 'workbench/upscale-source.mp4');
  assert.equal(workflow.rtx.inputs['resize_type.scale'], 3);
  assert.equal(workflow.rtx.inputs.quality, 'HIGH');
  assert.equal(workflow.rtx.inputs.strength, 0.7);
  assert.deepEqual(workflow.video.inputs.audio, ['components', 1]);
  assert.deepEqual(workflow.video.inputs.fps, ['components', 2]);
  assert.equal(await page.getByLabel('视频超分模型').isDisabled(), true);
  assert.equal(await node.getByRole('button', { name: '上传视频' }).isDisabled(), true);
  const finishedFile = { filename: 'H3_RTX_VFX_00001_.mp4', subfolder: 'video', type: 'output' };
  const job = { id: 'job-1', projectId: 'prj_upscale_fixture', nodeId: 'upscale', comfyPromptId: 'prompt-1', status: 'done', history: {
    outputs: { source: { videos: [{ filename: 'H3_RTX_VFX_source.mp4', subfolder: 'workbench', type: 'input' }] }, save: { videos: [finishedFile] } },
  } };
  await f.emit('job.done', { job });
  state = await f.waitState(s => s.nodes.find(n => n.id === 'upscale')?.status === 'done' && s.nodes.some(n => n.media?.filename === finishedFile.filename));
  const output = state.nodes.find(n => n.media?.filename === finishedFile.filename);
  assert.equal(output.media.type, 'output');
  assert.equal(output.media.subfolder, 'video');
  assert.ok(state.edges.some(e => e.source === 'upscale' && e.target === output.id && e.targetHandle === 'preview'));
  assert.ok(!state.nodes.some(n => n.media?.filename === 'H3_RTX_VFX_source.mp4'), 'input history is never the result');
  const retainedIds = state.nodes.map(n => n.id).sort();
  missingRtx = true;
  await node.getByRole('button', { name: '开始超分' }).click();
  await node.getByRole('alert').filter({ hasText: /RTXVideoSuperResolution/ }).waitFor();
  state = await f.state();
  assert.deepEqual(state.nodes.map(n => n.id).sort(), retainedIds, 'dependency failure keeps existing nodes and outputs');
  assert.equal(f.queued.length, 1, 'missing backend node fails before queue submit');
  missingRtx = false;
  await node.getByRole('button', { name: '开始超分' }).click();
  await f.waitState(s => s.nodes.find(n => n.id === 'upscale')?.queueJobId === 'job-2');
  await f.emit('job.error', { job: { ...job, id: 'job-2', status: 'error', comfyPromptId: 'prompt-2', history: undefined, error: { message: 'Synthetic GPU failure' } } });
  await node.getByRole('alert').filter({ hasText: 'Synthetic GPU failure' }).waitFor();
  state = await f.state();
  assert.deepEqual(state.nodes.map(n => n.id).sort(), retainedIds, 'runtime failure keeps source, processor and completed output');
  await call('canvas_update_node', { nodeId: 'upscale', title: '视频超分' });
  await page.reload(); await page.waitForFunction(() => window.fixtureTools.has('canvas_get_state'));
  state = await f.state();
  assert.equal(state.nodes.find(n => n.id === 'upscale').videoUpscaleScale, 3);
  assert.ok(state.nodes.some(n => n.media?.filename === finishedFile.filename), 'saved output binding survives reload');
  assert.deepEqual(failures, []);
  await f.context.close();
  const readOnly = await fixture(true);
  assert.equal(await readOnly.page.getByRole('button', { name: '上传视频', exact: true }).isDisabled(), true);
  assert.equal(await readOnly.page.getByLabel('视频超分模型').isDisabled(), true);
  await readOnly.context.close();
  const activeReadOnly = await fixture(true, true);
  const cancel = activeReadOnly.page.getByTestId('rf__node-upscale').getByRole('button', { name: '取消', exact: true });
  await cancel.waitFor();
  assert.equal(await cancel.isDisabled(), true, 'read-only viewer cannot cancel a running job');
  await cancel.dispatchEvent('click');
  assert.equal(activeReadOnly.cancelled.length, 0, 'read-only cancel never sends a cancellation request');
  assert.equal((await activeReadOnly.state()).nodes.find(n => n.id === 'upscale').status, 'running');
  await activeReadOnly.context.close();
  console.log('VIDEO_SUPER_RESOLUTION_UI_OK upload/replacement guide, settings, local queue audio/fps, saved output binding, dependency/runtime failure retention, persistence/read-only; synthetic only');
} finally { await browser.close(); }
