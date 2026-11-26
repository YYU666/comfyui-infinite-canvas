
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, samePath } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-visible-generation-'));
const projects = path.join(temporary, 'projects'), runtime = path.join(temporary, 'runtime');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const prompts = new Map();
const stub = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  let body = {};
  if (url.pathname === '/system_stats') body = { system: {}, devices: [] };
  if (url.pathname === '/queue') body = { queue_pending: [], queue_running: [] };
  if (url.pathname === '/object_info') body = {
    LoadImage: { input: { required: { image: [['fixture-old.png']] } }, output: ['IMAGE', 'MASK'] },
    Fixture: { input: { required: { first: ['IMAGE'], second: ['IMAGE'], value: ['FLOAT'], normalize: ['BOOLEAN'] } }, output: ['IMAGE'] },
    SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [] },
  };
  if (url.pathname === '/prompt' && request.method === 'POST') {
    const parts = [];
    for await (const part of request) parts.push(part);
    const submitted = JSON.parse(Buffer.concat(parts));
    const promptId = 'fixture-prompt-' + (prompts.size + 1);
    prompts.set(promptId, submitted);
    body = { prompt_id: promptId };
  }
  if (url.pathname.startsWith('/history')) {
    body = Object.fromEntries([...prompts].map(([id, submission]) => [id, {
      prompt: [0, id, submission.prompt, { client_id: submission.client_id }, []],
      status: { completed: true, status_str: 'success' },
      outputs: { 4: { images: [{ filename: id + '.png', subfolder: '', type: 'output' }] } },
    }]));
  }
  if (url.pathname === '/view') {
    response.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects,
  H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1', H3_COMFY_URL: 'http://127.0.0.1:' + stub.address().port };
const backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serviceLogs = '', browser, base, token;
for (const stream of [backend.stdout, backend.stderr]) {
  stream.on('data', (chunk) => { serviceLogs = (serviceLogs + chunk.toString()).slice(-4000); });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, read) {
  for (let i = 0; i < 200; i += 1) {
    const result = await read();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(label + ' timed out. ' + serviceLogs);
}
async function api(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + route, { method, headers: { 'X-H3-Token': token,
    ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || JSON.stringify(data)), { code: data.code, status: response.status });
  return data;
}

try {
  const instance = await until('isolated workbench', async () => {
    try { return JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); }
    catch { return null; }
  });
  base = 'http://127.0.0.1:' + instance.port;
  token = instance.token;
  const health = await api('/api/health');
  assert.equal(health.pid, instance.pid);
  assert.ok(samePath(health.projectsRoot, projects));
  await api('/api/queue', { action: 'pause' });
  const workload = {
    '1': { class_type: 'LoadImage', inputs: { image: 'fixture-old.png' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'fixture-old.png' } },
    '3': { class_type: 'Fixture', inputs: { first: ['1', 0], second: ['2', 0], value: 0.5, normalize: true } },
    '4': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'workspace-fixture' } },
  };
  const imported = await fetch(base + '/api/extensions/import', {
    method: 'POST', headers: { 'X-H3-Token': token, 'Content-Type': 'application/json', 'X-Filename': 'synthetic-workflow.json' },
    body: JSON.stringify(workload),
  });
  assert.equal(imported.status, 200, await imported.clone().text());
  const { digest, nodes: [{ definition }] } = await imported.json();
  const workflowParameters = { node_3__value: 0.75 };
  const source = { id: 'reference', type: 'media', position: { x: 20, y: 80 },
    data: { kind: 'image', title: '合成参考图', remoteName: 'synthetic-input.png', url: 'data:image/png;base64,' + png.toString('base64') } };
  const secondSource = { ...source, id: 'reference_two', position: { x: 20, y: 360 },
    data: { ...source.data, title: '第二张参考图', remoteName: 'synthetic-second.png' } };
  const target = { id: 'custom_target', type: 'generator', position: { x: 430, y: 80 },
    data: { mode: 'customWorkflow', title: definition.name, extensionDigest: digest, nodeDefinitionId: definition.nodeDefinitionId,
      workflowDefinition: definition, workflowParameters } };
  const humanTarget = { ...target, id: 'human_target', position: { x: 430, y: 410 },
    data: { ...target.data, title: '人工提交样本' } };
  const project = await api('/api/projects', { name: 'Visible generation isolation', canvas: { nodes: [source, secondSource, target, humanTarget],
    edges: [target, humanTarget].flatMap((item) => [source, secondSource].map((input, index) =>
      ({ id: input.id + '-to-' + item.id, source: input.id, sourceHandle: 'ref', target: item.id, targetHandle: 'image_' + (index + 1) }))),
    viewport: { x: 0, y: 0, zoom: 0.8 } } });
  const projectPath = '/api/projects/' + project.id;
  const bridge = '/api/agent/canvas';
  const apply = '/api/agent/projects/' + project.id + '/apply';
  await assert.rejects(api(bridge + '/current?projectId=' + project.id), { code: 'NO_VISIBLE_CANVAS' });
  await assert.rejects(api('/api/queue', { projectId: project.id, nodeId: target.id, workflow: workload }), { code: 'VISIBLE_CANVAS_REQUIRED' });
  await assert.rejects(api(apply, { opId: 'mixed', revision: project.revision, ops: [
    { op: 'create', preset: 'text_video' }, { op: 'generate', target: 'g1' },
  ] }), { code: 'VISIBLE_CANVAS_REQUIRED' });
  assert.equal((await api(projectPath)).revision, project.revision);
  assert.equal((await api('/api/queue')).jobs.length, 0);
  await assert.rejects(api('/api/comfy/prompt', { prompt: workload, client_id: 'isolated-direct-probe' }), { code: 'VISIBLE_CANVAS_REQUIRED' });
  await assert.rejects(api('/api/legacy/prompt', { workflow: workload, clientId: 'legacy:cli-test' }), { code: 'LEGACY_MANUAL_REQUIRED' });
  assert.equal(prompts.size, 0);
  assert.equal((await api('/api/queue')).jobs.length, 0);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page, active;
  async function openPage() {
    page = await context.newPage();
    await page.route('**/api/extensions/' + digest + '/prepare', async (route) => {
      assert.deepEqual(route.request().postDataJSON(), { nodeDefinitionId: 'workflow',
        inputs: { image_1: 'synthetic-input.png', image_2: 'synthetic-second.png' }, parameters: workflowParameters });
      await route.continue();
    });
    await page.goto(base);
    await page.locator('.project-open').click();
    active = await until('current project page', async () => {
      try { return await api(bridge + '/current?projectId=' + project.id); }
      catch (error) { if (error.code === 'NO_VISIBLE_CANVAS') return null; throw error; }
    });
  }
  async function call(opId, expectedRevision, extra = {}, tool = 'canvas_generate_node') {
    const args = { nodeId: target.id, expectedRevision, ...(tool === 'canvas_generate_node' ? { wait: false } : {}), ...extra };
    const command = { ...active, tool, opId, args };
    await api(bridge + '/commands', command);
    return (await until(opId, async () => {
      const status = await api(bridge + '/commands/' + opId);
      return status.status === 'done' ? status : null;
    })).result;
  }
  await openPage();
  const savedAtOpen = (await api(projectPath)).revision;
  const stale = await call('wrong-revision', savedAtOpen + 10);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  assert.equal((await api('/api/queue')).jobs.length, 0);

  await page.route('**' + projectPath, (route) => {
    if (route.request().method() === 'PUT' && route.request().postDataJSON()?.canvas?.nodes
      .some((node) => node.data.visibleRun?.requestId === 'save-failure')) {
      return route.fulfill({ status: 503, json: { code: 'FIXTURE_SAVE', message: 'Fixture saved write failed' } });
    }
    return route.continue();
  });
  const failed = await call('save-failure', savedAtOpen);
  assert.equal(failed.ok, false);
  assert.match(await page.locator('.visible-generation-record').innerText(), /提交被拒绝/);
  assert.equal((await api('/api/queue')).jobs.length, 0);
  await page.close();
  // A normal page close or heartbeat expiry is observable via the existing bridge.
  await until('previous page release', async () => {
    try { await api(bridge + '/current?projectId=' + project.id); return false; }
    catch (error) { if (error.code === 'NO_VISIBLE_CANVAS') return true; throw error; }
  });
  await openPage();

  let prepared = null, queuedBody = null;
  await page.route('**/api/queue', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    queuedBody = route.request().postDataJSON();
    const visible = page.locator('.visible-generation-record[open][data-phase="prepared"]');
    assert.equal(await visible.count(), 1);
    assert.match(await visible.innerText(), /合成参考图/);
    assert.match(await visible.innerText(), /0.75/);
    assert.match(await visible.locator('pre').innerText(), /Fixture/);
    const disk = await api(projectPath);
    prepared = disk.canvas.nodes.find((node) => node.id === target.id).data.visibleRun;
    assert.equal(disk.revision, queuedBody.revision);
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.requestId, queuedBody.requestId);
    assert.equal((await api('/api/queue')).jobs.length, 0);
    await route.continue();
  });
  const accepted = await call('custom-fixture-run', (await api(projectPath)).revision);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.execution, 'accepted');
  assert.equal(accepted.attempt, 1);
  assert.equal(accepted.requestId, 'custom-fixture-run');
  assert.match(accepted.jobId, /^job_[a-f0-9]+$/);
  const actual = JSON.parse(queuedBody.executionJson);
  assert.equal(actual.workflow['3'].inputs.value, 0.75);
  assert.equal(actual.workflow['3'].inputs.normalize, true);
  assert.equal(actual.workflow['1'].inputs.image, 'synthetic-input.png');
  assert.equal(actual.workflow['2'].inputs.image, 'synthetic-second.png');
  assert.match(actual.workflow['4'].inputs.filename_prefix, /^H3\/extensions\//);
  assert.equal('snapshot' in prepared.execution, false, 'project retains digest, not raw execution config');
  assert.equal(prepared.execution.digest, createHash('sha256').update(queuedBody.executionJson).digest('hex'));
  assert.deepEqual(prepared.inputs.map(({ nodeId, slot, resolvedName }) => [nodeId, slot, resolvedName]), [
    [source.id, 'image_1', 'synthetic-input.png'], [secondSource.id, 'image_2', 'synthetic-second.png'],
  ]);
  assert.equal((await api('/api/queue')).jobs.length, 1);
  await page.close();
  await api('/api/queue', { action: 'resume' });
  const terminal = await until('job completes without page', async () => {
    const job = await api('/api/queue/' + accepted.jobId);
    assert.notEqual(job.status, 'error', JSON.stringify(job));
    return job.status === 'done' ? job : null;
  });
  assert.equal(terminal.requestId, accepted.requestId);
  assert.equal(prompts.size, 1);
  assert.deepEqual(prompts.values().next().value.prompt, actual.workflow);
  await until('accepted page release', async () => {
    try { await api(bridge + '/current?projectId=' + project.id); return false; }
    catch (error) { if (error.code === 'NO_VISIBLE_CANVAS') return true; throw error; }
  });
  await openPage();
  await until('reopen recovers job identity', async () => {
    const disk = await api(projectPath);
    const node = disk.canvas.nodes.find((item) => item.id === target.id);
    return node?.data.queueJobId === accepted.jobId && node.data.visibleRun?.jobId === accepted.jobId;
  });
  assert.equal(prompts.size, 1, 'reopening does not generate again');
  await api('/api/queue', { action: 'pause' });
  await assert.rejects(api('/api/queue/' + accepted.jobId + '/retry', {}), { code: 'VISIBLE_CANVAS_REQUIRED' });
  const retry = await call('visible-test-retry', undefined, { jobId: accepted.jobId, expectedAttempt: terminal.attempts }, 'canvas_retry_generation');
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.jobId, accepted.jobId);
  assert.equal(retry.attempt, terminal.attempts + 1);
  const superseded = await call('check-previous-attempt', undefined, { jobId: accepted.jobId, attempt: terminal.attempts }, 'canvas_wait_for_node');
  assert.equal(superseded.code, 'ATTEMPT_CHANGED', JSON.stringify(superseded));
  assert.equal((await api('/api/queue')).jobs.length, 1);
  assert.equal(prompts.size, 1, 'retry is queued and has a distinct attempt');
  let humanPrepared = null;
  await page.route('**/api/queue', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const payload = route.request().postDataJSON();
    const disk = await api(projectPath);
    assert.equal(disk.revision, payload.revision);
    humanPrepared = disk.canvas.nodes.find((node) => node.id === humanTarget.id).data.visibleRun;
    assert.equal(humanPrepared.phase, 'prepared');
    assert.equal(humanPrepared.origin, 'human');
    assert.equal(humanPrepared.requestId, payload.requestId);
    assert.equal('opId' in payload.page, false);
    await route.continue();
  });
  await page.locator('.react-flow__node[data-id="human_target"]').getByRole('button', { name: '运行工作流', exact: true }).click();
  const human = await until('human accepted through same page', async () => {
    const queue = await api('/api/queue');
    return queue.jobs.find((job) => job.id !== accepted.jobId);
  });
  assert.equal(human.requestId, humanPrepared.requestId);
  assert.equal(prompts.size, 1, 'the human job stays paused for the fixture');
  await context.close();
  const legacyContext = await browser.newContext();
  await legacyContext.addInitScript(() => localStorage.setItem('h3-workbench-mode', 'simple'));
  const legacy = await legacyContext.newPage();
  await legacy.goto(base);
  await legacy.locator('.project-open').click();
  await until('visible simple mode', async () => {
    try { return await api(bridge + '/current?projectId=legacy'); }
    catch (error) { if (error.code === 'NO_VISIBLE_CANVAS') return null; throw error; }
  });
  await legacy.locator('textarea').fill('Isolated simple-mode fixture');
  const legacyResponse = legacy.waitForResponse((response) => response.url().endsWith('/api/legacy/prompt'));
  await legacy.getByRole('button', { name: /开始生成/ }).click({ timeout: 12000 });
  const legacyResult = await (await legacyResponse).json();
  assert.equal(legacyResult.origin, 'legacy-manual', JSON.stringify(legacyResult));
  assert.equal(legacyResult.canvasOwned, false);
  const pausedLegacy = await api('/api/queue/' + legacyResult.jobId);
  assert.equal(pausedLegacy.status, 'queued');
  assert.equal(pausedLegacy.comfyPromptId, null);
  await api('/api/queue', { action: 'resume' });
  const legacyJob = await until('legacy queue dispatch', async () => {
    const job = await api('/api/queue/' + legacyResult.jobId);
    return job.comfyPromptId ? job : null;
  });
  assert.match(prompts.get(legacyJob.comfyPromptId).client_id, /^legacy:/);
  assert.equal(legacyJob.projectId, null);
  assert.equal(legacyJob.nodeId, null);
  assert.equal((await api('/api/queue')).jobs.filter((job) => job.canvasOwned !== false).length, 2,
    'simple mode shares the scheduler without claiming canvas ownership');
  await legacyContext.close();
  console.log(JSON.stringify({ legacyManualIdentified: true, humanSameGate: true, directProxyRejected: true, retryAttempt: retry.attempt, customWorkflow: true, realExtensionCompile: true, staleRevisionRejected: true, saveFailureNoJob: true,
    noVisiblePageNoJob: true, persistedBeforeEnqueue: true, accepted: accepted.jobId, closedPageTerminal: terminal.status,
    reopenedReceipt: true, fakeCanvasComfySubmissions: 1, fakeLegacyComfySubmissions: prompts.size - 1 }));
} finally {
  if (browser) await browser.close();
  if (base) spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
  if (backend.exitCode === null) backend.kill();
  for (let i = 0; i < 50 && backend.exitCode === null; i += 1) await sleep(100);
  stub.closeAllConnections();
  await new Promise((resolve) => stub.close(resolve));
  assert.ok(path.dirname(temporary).toLowerCase() === path.resolve(tmpdir()).toLowerCase()
    && path.basename(temporary).startsWith('h3-visible-generation-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
