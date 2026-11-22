// Fully intercepted page fixture; no server, GPU, ComfyUI or user media.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { PROJECT_SESSION_KEY } from './src/project-session.js';

export async function runVideoProcessorFixture(config) {
  const origin = 'http://video-processor-fixture.test', dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
  const input = `assets/${'a'.repeat(64)}.mp4`, output = `assets/${'b'.repeat(64)}.mp4`;
  const browser = await chromium.launch({ headless: true });
  const errors = [], submitted = [], committed = [], cancelled = [], snapshots = [];
  let hold = false;
  let project = { id: 'prj_processor_fixture', name: 'Synthetic processor', revision: 1, shots: [], canvas: { viewport: { x: 0, y: 0, zoom: 0.8 },
    nodes: [{ id: 'source', type: 'media', position: { x: 0, y: 80 }, data: { kind: 'video', title: 'Synthetic source', localFile: true, assetPath: input } },
      { id: 'processor', type: config.type, position: { x: 500, y: 80 }, data: { title: config.title, status: 'idle', ...config.initial } }, ...(config.nodes || [])],
    edges: [{ id: 'input', source: 'source', sourceHandle: 'ref', target: 'processor', targetHandle: config.port || 'v1' }, ...(config.edges || [])] } };
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, serviceWorkers: 'block' });
    await context.addInitScript(({ key, id }) => {
      sessionStorage.setItem(key, JSON.stringify({ version: 1, id, readOnly: false }));
      window.fixtureTools = new Map();
      Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
      window.EventSource = class { addEventListener() {} close() {} };
      window.WebSocket = class { addEventListener() {} close() {} };
    }, { key: PROJECT_SESSION_KEY, id: project.id });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin, 'fixture must never reach a live host');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/api/projects') return json({ projects: [project] });
      if (url.pathname === '/api/projects/trash') return json({ projects: [] });
      if (url.pathname === '/api/projects/open') return json(project);
      if (url.pathname === `/api/projects/${project.id}`) {
        if (request.method() === 'PUT') { const data = request.postDataJSON(); snapshots.push(data); project = { ...project, ...data, revision: project.revision + 1 }; }
        return json(project);
      }
      if (url.pathname === '/api/health') return json({ ok: true, comfy: { state: 'ready' } });
      if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
      if (url.pathname === '/api/queue') return json({ jobs: [] });
      if (url.pathname === `/api/${config.api}/jobs`) { submitted.push(request.postDataJSON()); return json({ id: `${config.prefix}_${String(submitted.length).repeat(32)}`, status: 'queued', progress: 0 }, 201); }
      if (url.pathname.startsWith(`/api/${config.api}/jobs/`)) {
        if (url.pathname.endsWith('/cancel')) { cancelled.push(request.postDataJSON()); return json({ status: 'cancelled' }); }
        if (url.pathname.endsWith('/commit')) { committed.push(request.postDataJSON()); return json({ asset: { path: output }, revision: ++project.revision }, 201); }
        return json({ id: url.pathname.split('/').at(-1), status: hold ? 'running' : 'completed', progress: hold ? 0.4 : 1, result: { frames: 24, width: 128, height: 72, audio: 'preserve', ...config.result } });
      }
      if (url.pathname.includes('/assets/') && url.pathname.startsWith('/api/projects/')) return route.fulfill({ contentType: 'video/mp4', body: Buffer.from('synthetic encoded video') });
      if (url.pathname.startsWith('/api/agent/canvas/')) return json({}, 503);
      if (url.pathname.startsWith('/api/')) return json({});
      const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.getByTestId('rf__node-processor').waitFor({ timeout: 8000 }).catch(async reason => { throw new Error(`${reason.message}; errors=${JSON.stringify(errors)}; body=${await page.locator('body').innerText()}`); });
    const call = (name, args = {}) => page.evaluate(async ({ name, args }) => JSON.parse(await window.fixtureTools.get(name).execute(args)), { name, args });
    const state = () => call('canvas_get_state');
    const until = async predicate => { for (let i = 0; i < 150; i++) { const current = await state(); if (predicate(current)) return current; await page.waitForTimeout(40); } throw new Error('mock processor did not settle'); };
    const savedProcessor = () => project.canvas.nodes.find(n => n.id === 'processor')?.data;
    const updated = await call('canvas_update_node', { nodeId: 'processor', settings: config.settings }); assert.equal(updated.ok, true, updated.error);
    const start = await call('canvas_generate_node', { nodeId: 'processor', wait: false }); assert.equal(start.ok, true, start.error);
    const done = await until(s => s.nodes.find(n => n.id === 'processor')?.status === 'done');
    assert.equal(done.nodes.find(n => n.id === 'processor')[config.resultKey], output);
    assert.equal(submitted.length, 1); assert.equal(committed.length, 1);
    await until(() => savedProcessor()?.[config.resultKey] === output &&
      (!config.repeatExport || project.canvas.nodes.some(n => n.id === savedProcessor().plateResultNodeId)));
    config.check?.({ submitted: submitted[0], done, project, output, input });
    if (config.repeatExport) {
      const oldMedia = project.canvas.nodes.filter(n => n.type === 'media' && n.data.sourcePlateId === 'processor');
      assert.equal(oldMedia.length, 1);
      const oldId = oldMedia[0].id, oldData = structuredClone(oldMedia[0].data);
      assert.equal((await call('canvas_generate_node', { nodeId: 'processor', wait: false })).ok, true);
      await until(s => s.nodes.find(n => n.id === 'processor')?.status === 'done' && s.nodes.find(n => n.id === 'processor')?.plateResultNodeId !== oldId);
      await until(() => savedProcessor()?.plateResultNodeId !== oldId && project.canvas.nodes.some(n => n.id === savedProcessor()?.plateResultNodeId));
      assert.deepEqual(project.canvas.nodes.find(n => n.id === oldId).data, oldData);
      assert.equal(project.canvas.nodes.filter(n => n.type === 'media' && n.data.sourcePlateId === 'processor').length, 2);
    }
    assert.equal(project.canvas.nodes.find(n => n.id === 'source').data.assetPath, input);
    await page.reload(); await page.getByTestId('rf__node-processor').waitFor();
    assert.equal((await state()).nodes.find(n => n.id === 'processor')[config.resultKey], output);
    hold = true;
    const again = await call('canvas_generate_node', { nodeId: 'processor', wait: false }); assert.equal(again.ok, true, again.error);
    const cancel = await call('canvas_cancel_node', { nodeId: 'processor' }); assert.equal(cancel.ok, true, cancel.error);
    await until(s => s.nodes.find(n => n.id === 'processor')?.status === 'cancelled');
    assert.equal((await state()).nodes.find(n => n.id === 'processor')[config.resultKey], output);
    assert.equal(cancelled.length, 1); assert.ok(snapshots.length > 0); assert.deepEqual(errors, []);
    console.log(`${config.api.toUpperCase()}_UI_MOCK_OK settings submit commit reload cancel-retention immutable-source; no live services`);
  } finally { await browser.close(); }
}
