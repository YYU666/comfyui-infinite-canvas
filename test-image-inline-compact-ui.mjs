import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';
import { PROJECT_SESSION_KEY } from './src/project-session.js';
import { imageInlineFixture } from './test-fixtures/image-inline-fixture.mjs';
import { migrateCanvas } from './src/canvas-migration.js';

// Everything, including the page bridge and save queue, is synthetic and routed.
// The browser never contacts localhost, user services, ComfyUI, or remote media.
const origin = 'http://image-inline-fixture.test';
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const projectId = 'prj_inline_fixture';
let project = { id: projectId, name: 'Inline fixture', revision: 1, shots: [], canvas: migrateCanvas(imageInlineFixture(), projectId) };
let lease, pending, saves = 0, failSave = false;
const receipts = new Map(), errors = [], requests = [];
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 }, serviceWorkers: 'block' });
await context.addInitScript(({ key, id }) => {
  sessionStorage.setItem(key, JSON.stringify({ version: 1, id, readOnly: localStorage.getItem('fixtureReadOnly') === 'true' }));
  window.fixtureTools = new Map();
  Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) {
    window.fixtureTools.set(tool.name, tool);
    options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name));
  } } });
  window.EventSource = class { addEventListener() {} close() {} };
  window.WebSocket = class { addEventListener() {} close() {} };
}, { key: PROJECT_SESSION_KEY, id: projectId });
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, origin, 'requests never leave isolated fixture');
  requests.push({ path: url.pathname, method: request.method() });
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/agent/canvas/heartbeat') {
    const page = request.postDataJSON(); lease = page;
    const command = pending && !page.busy ? pending : null;
    if (command) pending = null;
    return json({ epoch: 'fixture_epoch', command });
  }
  if (url.pathname === '/api/agent/canvas/result') {
    const result = request.postDataJSON(); receipts.set(result.opId, result); return json({ status: 'done' });
  }
  if (url.pathname === '/api/agent/canvas/release') return json({ released: true });
  if (url.pathname === '/api/projects') return json({ projects: [project] });
  if (url.pathname === '/api/projects/trash') return json({ projects: [] });
  if (url.pathname === '/api/projects/open') return json(project);
  if (url.pathname === `/api/projects/${projectId}`) {
    if (request.method() === 'PUT') {
      saves++;
      if (failSave) return json({ code: 'REVISION_CONFLICT', message: 'synthetic revision conflict' }, 409);
      const doc = request.postDataJSON();
      assert.equal(doc.revision, project.revision, 'save still uses current revision protection');
      assert.equal(request.headers()['if-match'], String(project.revision), 'CAS header remains bound to loaded revision');
      project = { ...project, ...doc, revision: project.revision + 1 };
    }
    return json(project);
  }
  if (url.pathname === '/api/queue') {
    assert.equal(request.method(), 'GET', 'fixture never submits generation');
    return json({ jobs: project.canvas.nodes.filter(node => node.data.status === 'queued').map(node => ({
      id: node.data.queueJobId, nodeId: node.id, projectId, status: 'queued', stage: 'synthetic pending task',
    })) });
  }
  if (url.pathname === '/api/thumbnails' || url.pathname === '/api/comfy/view') return route.fulfill({ contentType: 'image/png', body: pixel });
  if (url.pathname === '/api/health') return json({ ok: true });
  if (url.pathname === '/api/settings') return json({ notifications: false, updates: { autoCheck: false } });
  if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
  if (url.pathname.startsWith('/api/')) return json({});
  const file = path.resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  assert.ok(file.startsWith(`${dist}${path.sep}`));
  return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const until = async read => {
  for (let i = 0; i < 100; i++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Synthetic inline fixture timed out');
};
const native = args => page.evaluate(async args => JSON.parse(await window.fixtureTools.get('canvas_image_compact').execute(args)), args);
let sequence = 0;
const dispatch = async (args, overrides = {}) => {
  const active = await until(() => lease?.visible && lease);
  const opId = `compact_${++sequence}`;
  pending = { epoch: 'fixture_epoch', sessionId: active.sessionId, projectId, opId, tool: 'canvas_image_compact', args, ...overrides };
  return (await until(() => receipts.get(opId))).result;
};
const ready = async () => {
  await page.waitForFunction(() => window.fixtureTools.has('canvas_image_compact'));
  await page.locator('[data-id="g1"]').waitFor();
};
try {
  await page.goto(origin); await ready();
  // Let initial node measurement/autosave finish before proving dry-run has no save.
  await page.waitForTimeout(1200);
  const before = structuredClone(project.canvas), initialSaves = saves;
  const preview = await dispatch({ nodeIds: ['g1', 'multi'] });
  assert.equal(preview.ok, true); assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.compacted[0].backingIds, ['current', 'historical']);
  await page.waitForTimeout(1000);
  assert.equal(saves, initialSaves, 'default dry run never saves');
  assert.deepEqual(project.canvas, before);
  assert.equal((await dispatch({ nodeIds: ['g1'], dryRun: false }, { projectId: 'prj_wrong' })).ok, false, 'stale project dispatch is refused by mounted page');
  assert.equal((await dispatch({ nodeIds: ['g1'], dryRun: false }, { sessionId: 'stale_page' })).ok, false);
  assert.equal(saves, initialSaves);
  const executed = await dispatch({ nodeIds: ['g1', 'multi'], dryRun: false });
  assert.equal(executed.ok, true); assert.equal(executed.dryRun, false);
  assert.ok(saves > initialSaves, 'success acknowledges a persisted mutation');
  assert.deepEqual(project.canvas.edges, before.edges, 'all saved edge identities and endpoints remain unchanged');
  for (const node of project.canvas.nodes) {
    const { inlineImageOwnerId, inlineImageOutputId, ...data } = node.data;
    assert.deepEqual(data, before.nodes.find(item => item.id === node.id).data, 'files, URLs, histories and multi-output data remain unchanged');
  }
  assert.equal(project.canvas.nodes.find(node => node.id === 'g1').data.inlineImageOutputId, 'current');
  assert.equal(project.canvas.nodes.find(node => node.id === 'historical').data.inlineImageOwnerId, 'g1');
  assert.equal(project.canvas.nodes.find(node => node.id === 'old-multi-a').data.inlineImageOwnerId, undefined);
  assert.equal(await page.locator('[data-id="current"]').count(), 0);
  const savedCanvas = structuredClone(project.canvas);
  lease = null;
  await page.reload(); await ready();
  assert.equal(await page.locator('[data-id="current"]').count(), 0, 'saved compact view survives reload');
  assert.deepEqual(project.canvas.edges, savedCanvas.edges);
  assert.equal((await dispatch({ nodeIds: ['g1'] })).compacted[0].outputId, 'current');

  // A different active node must block compacting even a completed target.
  project.canvas.nodes.push({ id: 'busy', type: 'generator', position: { x: 7000, y: 0 }, data: { title: 'Pending synthetic task', mode: 'image', status: 'queued', queueJobId: 'busy-job' } });
  lease = null; await page.reload(); await ready();
  await page.waitForTimeout(500);
  const busySaves = saves;
  const busy = await dispatch({ nodeIds: ['g1'], dryRun: false });
  assert.equal(busy.ok, false); assert.match(busy.error, /任务或编辑进行中/);
  assert.equal(saves, busySaves);
  project.canvas.nodes = project.canvas.nodes.filter(node => node.id !== 'busy');

  await page.evaluate(() => localStorage.setItem('fixtureReadOnly', 'true'));
  project.readOnly = true; lease = null;
  await page.reload(); await ready();
  const readonlySaves = saves;
  assert.equal((await native({ nodeIds: ['g1'], dryRun: false })).ok, false);
  assert.equal((await native({ nodeIds: ['g1'] })).ok, false, 'action also checks read-only for previews');
  assert.equal(saves, readonlySaves);

  await page.evaluate(() => localStorage.removeItem('fixtureReadOnly'));
  project.readOnly = false; lease = null;
  await page.reload(); await ready();
  await page.waitForTimeout(1200);
  failSave = true;
  // Change a presentation flag so this is a real new mutation before conflict.
  project.canvas.nodes.find(node => node.id === 'g1').data.inlineImageOutputId = undefined;
  project.canvas.nodes.find(node => node.id === 'current').data.inlineImageOwnerId = undefined;
  lease = null; await page.reload(); await ready();
  const conflict = await dispatch({ nodeIds: ['g1'], dryRun: false });
  assert.equal(conflict.ok, false); assert.equal(conflict.localChangesRetained, true);
  assert.equal((await native({ nodeIds: ['g1'], dryRun: false })).ok, false, 'save failure blocks further compaction');
  assert.deepEqual(errors, []);
  assert.equal(context.pages().length, 1);
  assert.ok(requests.every(request => request.path !== '/api/comfy/prompt'));
  console.log('IMAGE_INLINE_COMPACT_UI_OK syntheticOnly=true samePage=true dryRunNoSave=true persistedReload=true immutableEdges=true multiOutputPreserved=true busyRejected=true readonlyRejected=true conflictRetained=true');
} finally { await browser.close(); }
