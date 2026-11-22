// Full request mocks only: no server, ComfyUI, FFmpeg, GPU or user project.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { defaultVideoEditDocument } from './src/video-edit-document.js';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

const origin = 'http://video-editor-fixture.test';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const sourceAsset = `assets/${'a'.repeat(64)}.mp4`, resultAsset = `assets/${'b'.repeat(64)}.mp4`;
const browser = await chromium.launch({ headless: true });
const errors = [];
async function fixture(readOnly = false, active = false) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1080 }, serviceWorkers: 'block' });
  const queued = [], commits = [], cancels = [], saves = [];
  let hold = active;
  const cutJobId = `ved_${'a'.repeat(32)}`;
  let project = { id: 'prj_editor_fixture', name: 'Synthetic editor', revision: 1, readOnly, shots: [], canvas: {
    viewport: { x: 10, y: 20, zoom: 0.9 },
    nodes: [
      { id: 'source', type: 'media', position: { x: 0, y: 90 }, data: { kind: 'video', title: 'Synthetic source', localFile: true, assetPath: sourceAsset } },
      { id: 'edit', type: 'videoEdit', position: { x: 550, y: 90 }, data: { title: '视频编辑', status: active ? 'running' : 'idle', editDocument: defaultVideoEditDocument(), ...(active ? { videoEditJobId: `ved_${'f'.repeat(32)}` } : {}) } },
    ], edges: [{ id: 'input', source: 'source', sourceHandle: 'ref', target: 'edit', targetHandle: 'v1' }],
  } };
  await context.addInitScript(({ key, id, readOnly }) => {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, id, readOnly }));
    window.fixtureTools = new Map();
    Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
    window.EventSource = class { addEventListener() {} close() {} };
    window.WebSocket = class { addEventListener() {} close() {} };
  }, { key: PROJECT_SESSION_KEY, id: project.id, readOnly });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'request cannot reach a live host');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/projects') return json({ projects: [project] });
    if (url.pathname === '/api/projects/trash') return json({ projects: [] });
    if (url.pathname === '/api/projects/open') return readOnly && !request.postDataJSON()?.readOnly ? json({ error: 'locked' }, 423) : json(project);
    if (url.pathname === `/api/projects/${project.id}`) {
      if (request.method() === 'PUT') { const body = request.postDataJSON(); saves.push(body); project = { ...project, ...body, revision: project.revision + 1 }; }
      return json(project);
    }
    if (url.pathname === '/api/health') return json({ ok: true, comfy: { state: 'ready' } });
    if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
    if (url.pathname === '/api/queue') return json({ jobs: [] });
    if (url.pathname === '/api/video-edit/probe') return json({ frameCount: 96, frameTimebase: { num: 1, den: 24 }, fps: { num: 24, den: 1 }, width: 128, height: 72, hasAudio: true });
    if (url.pathname === '/api/video-edit/auto-cut') {
      assert.deepEqual(request.postDataJSON(), { projectId: project.id, nodeId: 'edit', slot: 'v1', assetPath: sourceAsset, mode: 'black' });
      return json({ id: cutJobId, status: 'queued' }, 201);
    }
    if (url.pathname === `/api/video-edit/jobs/${cutJobId}`) return json({
      id: cutJobId, status: 'completed', result: {
        removedFrames: 48, frameCount: 96, cuts: [[8, 32], [64, 88]], document: defaultVideoEditDocument(),
      },
    });
    if (url.pathname === '/api/video-edit/jobs') {
      queued.push(request.postDataJSON());
      return json({ id: `ved_${String(queued.length).repeat(32)}`, status: 'queued', stage: '排队中', progress: 0 }, 201);
    }
    if (/\/api\/video-edit\/jobs\/ved_[a-f0-9]{32}\/cancel$/.test(url.pathname)) { cancels.push(request.postDataJSON()); hold = false; return json({ status: 'cancelled' }); }
    if (/\/api\/video-edit\/jobs\/ved_[a-f0-9]{32}\/commit$/.test(url.pathname)) {
      commits.push(request.postDataJSON()); project.revision++;
      return json({ asset: { path: resultAsset }, revision: project.revision }, 201);
    }
    if (/\/api\/video-edit\/jobs\/ved_[a-f0-9]{32}$/.test(url.pathname)) return json({ id: url.pathname.split('/').at(-1), status: hold ? 'running' : 'completed', stage: hold ? '模拟导出' : '已导出', progress: hold ? 0.4 : 1, result: { frames: 24, width: 128, height: 72, audio: 'clips' } });
    if (url.pathname.startsWith('/api/projects/') && url.pathname.includes('/assets/')) return route.fulfill({ contentType: 'video/mp4', body: Buffer.from('synthetic encoded video') });
    if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'native mocks only' }, 503);
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByTestId('rf__node-edit').waitFor({ timeout: 8000 }).catch(async reason => { throw new Error(`${reason.message}; page errors: ${JSON.stringify(errors)}; body: ${await page.locator('body').innerText()}`); });
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
  const state = () => call('canvas_get_state');
  async function until(predicate) {
    for (let i = 0; i < 100; i++) { const current = await state(); if (predicate(current)) return current; await page.waitForTimeout(40); }
    throw new Error('Synthetic edit state did not settle');
  }
  return { context, page, call, state, until, queued, commits, cancels, saves, saved: () => project, hold: value => { hold = value; } };
}
try {
  const f = await fixture(); const { page } = f;
  const editor = page.getByTestId('rf__node-edit');
  await editor.getByRole('button', { name: '编辑视频', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '视频编辑' }); await panel.waitFor();
  await panel.getByRole('button', { name: '分析剪辑 v1' }).click();
  const suggestions = panel.getByRole('button', { name: '用建议替换时间线' });
  await suggestions.waitFor();
  assert.equal((await f.state()).nodes.find(n => n.id === 'edit').editDocument.clips[0].sourceOutPts, 24);
  await panel.getByRole('checkbox', { name: '00:00:00:08～00:00:01:08' }).uncheck();
  await suggestions.click();
  let edited = (await f.state()).nodes.find(n => n.id === 'edit').editDocument;
  assert.deepEqual(edited.clips.map(c => [c.sourceInPts, c.sourceOutPts]), [[0, 64], [88, 96]]);
  await panel.getByRole('button', { name: '撤销 (Ctrl+Z)' }).click();
  edited = (await f.state()).nodes.find(n => n.id === 'edit').editDocument;
  assert.deepEqual(edited, defaultVideoEditDocument());
  await panel.getByLabel('关闭', { exact: true }).click();
  const settings = defaultVideoEditDocument(); settings.clips[0].sourceOutPts = 24; settings.clips[0].reverse = true;
  const updated = await f.call('canvas_update_node', { nodeId: 'edit', settings: { editDocument: settings } });
  assert.equal(updated.ok, true, updated.error);
  const submitted = await f.call('canvas_generate_node', { nodeId: 'edit', wait: false });
  assert.equal(submitted.ok, true, submitted.error);
  let state = await f.until(s => s.nodes.find(n => n.id === 'edit')?.status === 'done');
  assert.equal(f.queued.length, 1); assert.equal(f.commits.length, 1);
  assert.equal(f.queued[0].document.clips[0].reverse, true);
  assert.deepEqual(f.queued[0].inputs, { v1: sourceAsset });
  assert.equal(state.nodes.find(n => n.id === 'edit').editResultAssetPath, resultAsset);
  assert.equal(state.edges.find(e => e.id === 'input').source, 'source');
  assert.equal(f.saved().canvas.nodes.find(n => n.id === 'source').data.assetPath, sourceAsset);
  await page.reload(); await editor.waitFor();
  state = await f.state(); assert.equal(state.nodes.find(n => n.id === 'edit').editResultAssetPath, resultAsset, 'asset identity survives reload');
  f.hold(true);
  await editor.getByRole('button', { name: '导出', exact: true }).click();
  await f.until(s => s.nodes.find(n => n.id === 'edit')?.videoEditJobId === `ved_${'2'.repeat(32)}`);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await f.until(s => s.nodes.find(n => n.id === 'edit')?.status === 'cancelled');
  assert.deepEqual(f.cancels, [{ projectId: 'prj_editor_fixture' }]);
  assert.equal((await f.state()).nodes.find(n => n.id === 'edit').editResultAssetPath, resultAsset, 'cancel preserves prior output');
  await f.context.close();
  const readOnly = await fixture(true, true);
  const cancel = readOnly.page.getByTestId('rf__node-edit').getByRole('button', { name: '取消', exact: true });
  await cancel.evaluate(button => { if (!button.disabled) throw new Error('readonly cancel must be disabled'); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  assert.equal(readOnly.cancels.length, 0); assert.equal(readOnly.queued.length, 0);
  await readOnly.context.close();
  assert.deepEqual(errors, []);
  console.log('VIDEO_EDIT_UI_MOCK_OK document/submit/commit, immutable source, reload, cancel retention, readonly; no live services');
} finally { await browser.close(); }
