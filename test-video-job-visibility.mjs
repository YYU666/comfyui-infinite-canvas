// Browser, page bridge and worker verification. Only a temporary project and synthetic input.
import assert from 'node:assert/strict';
import { defaultVideoEditDocument } from './src/video-edit-document.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-video-edit-'));
const runtime = path.join(temporary, 'runtime');
const gate = path.join(temporary, 'gate');
await mkdir(gate);
const projects = path.join(temporary, 'projects');
const env = { ...process.env, REFMUSE_VIDEO_TEST_GATE: gate, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects, H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'), H3_COMFY_URL: 'http://127.0.0.1:1', H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1', PYTHONUTF8: '1' };
const py = (code, ...args) => {
  const result = spawnSync(python, ['-X', 'utf8', '-c', `import sys; sys.path.insert(0, '.')\n${code}`, ...args], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const source = path.join(temporary, 'source.mp4');
py('import sys; from fractions import Fraction; from video_edit_testmedia import make_video; make_video(sys.argv[1], 120, Fraction(24))', source);
const backend = spawn(python, ['-X', 'utf8', 'test_video_visibility_server.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; backend.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-3500); });
let browser; let base; let token;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await pause(100); } throw new Error(`video edit UI timed out\n${logs}`); }
async function api(route, payload, method = payload ? 'POST' : 'GET') {
  const response = await fetch(base + route, { method, headers: { 'X-H3-Token': token, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
try {
  const instance = await until(async () => { try { return JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); } catch { if (backend.exitCode !== null) throw new Error(logs); return null; } });
  base = `http://127.0.0.1:${instance.port}`; token = instance.token;
  const fixture = await api('/api/projects', { name: 'Video edit synthetic QA', canvas: { nodes: [
    { id: 'source', type: 'media', position: { x: 20, y: 100 }, data: { kind: 'video', title: '合成原片', url: '' } },
  ], edges: [], viewport: { x: 30, y: 30, zoom: 0.6 } } });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const interrupts = []; page.on('request', (request) => { if (/interrupt/.test(request.url()) || (request.method() === 'POST' && /\/api\/queue|\/prompt/.test(request.url()))) interrupts.push(request.url()); });
  await page.goto(base); await page.locator('.project-open').click();
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await node('source').locator('input[type=file]').setInputFiles({ name: 'source.mp4', mimeType: 'video/mp4', buffer: await readFile(source) });
  const read = () => api(`/api/projects/${fixture.id}`);
  await until(async () => (await read()).canvas.nodes.find((n) => n.id === 'source')?.data.assetPath);
  const call = async (opId, tool, args) => {
    const current = await until(async () => {
      try { return await api(`/api/agent/canvas/current?projectId=${fixture.id}`); }
      catch (error) { if (/AMBIGUOUS_CANVAS|NO_VISIBLE_CANVAS/.test(error.message)) return null; throw error; }
    });
    await api('/api/agent/canvas/commands', { ...current, opId, tool, args });
    return until(async () => { const status = await api(`/api/agent/canvas/commands/${opId}`); return status.status === 'done' ? status.result : null; }, 120000);
  };

  const evidence = [];
  const evidencePath = process.env.REFMUSE_VIDEO_EVIDENCE;
  if (evidencePath) await mkdir(evidencePath, { recursive: true });
  let op = 0;
  const agent = (tool, args) => call(`qa-${++op}`, tool, args);
  const payloads = [];
  let probePost = false;
  page.on('request', (request) => {
    if (!probePost && request.method() === 'POST' && /\/api\/video-(edit|rhythm|chroma|plate|repair)\/jobs$/.test(request.url())) {
      payloads.push(request.postDataJSON());
    }
  });
  async function create(preset, edges) {
    const created = await agent('canvas_create_node', { preset, title: preset, focus: false });
    assert.equal(created.ok, true, created.error);
    const id = created.node.id;
    for (const slot of edges) {
      const result = await agent('canvas_connect_nodes', { sourceId: 'source', targetId: id, targetHandle: slot });
      assert.equal(result.ok, true, result.error);
    }
    return id;
  }
  async function focus(id) {
    const result = await agent('canvas_focus_node', { nodeId: id });
    assert.equal(result.ok, true, result.error);
  }
  async function direct(pathname, body) {
    const response = await fetch(base + pathname, { method: 'POST',
      headers: { 'X-H3-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function browserPost(pathname, body) {
    probePost = true;
    try { return await page.evaluate(async ({ pathname, body }) => {
      const response = await fetch(pathname, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, { pathname, body }); } finally { probePost = false; }
  }
  async function reopen(id) {
    await page.reload();
    if (await page.locator('.project-open').first().isVisible()) await page.locator('.project-open').first().click();
    await focus(id);
    await node(id).waitFor({ timeout: 15000 });
  }

  const cases = [
    ['video_edit','edit','ved','videoEditJobId',['v1'],'agent'],
    ['video_speed','rhythm','vry','rhythmJobId',['v1'],'manual'],
    ['video_time_remap','rhythm','vry','rhythmJobId',['v1'],'agent'],
    ['video_chroma_key','chroma','vck','chromaJobId',['fg','bg'],'manual'],
    ['video_white_plate','plate','vwp','plateJobId',['v1'],'agent'],
    ['video_local_repair','repair','vrp','repairJobId',['video'],'agent'],
  ];
  for (const [preset, family, prefix, key, edges, entry] of cases) {
    const id = await create(preset, edges);
    await focus(id);
    const before = payloads.length;
    if (entry === 'agent') {
      const receipt = await agent('canvas_generate_node', { nodeId: id, wait: false });
      assert.equal(receipt.ok, true, receipt.error);
      assert.match(receipt.jobId, new RegExp(`^${prefix}_[a-f0-9]{32}$`));
    } else {
      await node(id).getByRole('button', { name: '导出', exact: true }).click();
    }
    const getNode = async () => (await read()).canvas.nodes.find((item) => item.id === id);
    const prepared = await until(async () => (await getNode())?.data.videoSubmission);
    const jobId = prepared.id;
    const route = `/api/video-${family}/jobs`;
    const progress = node(id).getByRole('progressbar', { name: '视频任务进度' });
    await progress.waitFor({ timeout: 13000 });
    const executing = await until(async () => {
      const job = await api(`${route}/${jobId}`);
      return job.status === 'running' && job.progress > 0.01 ? job : null;
    });
    const approx = String(Math.round(executing.progress * 100));
    await until(async () => (await progress.getAttribute('value')) === approx);
    assert.equal(executing.projectId, fixture.id);
    assert.equal(executing.nodeId, id);
    assert.equal(prepared.intent.nodeId, id);
    assert.equal(prepared.intent.projectId, fixture.id);
    assert.equal(payloads.length, before + 1);
    const { requestId, page: proof, ...intent } = payloads.at(-1);
    assert.deepEqual(prepared.intent, intent);
    assert.deepEqual(prepared.page, proof);
    assert.equal(Boolean(proof.opId), entry === 'agent');
    const offPage = await direct(route, { ...intent, requestId, page: proof });
    assert.equal(offPage.status, 403);
    assert.equal(offPage.body.code, 'VIDEO_PAGE_REQUIRED');
    const showPage = { epoch: proof.epoch, sessionId: proof.sessionId };
    const missingProof = await browserPost(route, { ...intent, requestId });
    assert.equal(missingProof.status, 403);
    const noRecord = await browserPost(route, { ...intent, page: showPage });
    assert.equal(noRecord.status, 409);
    assert.equal(noRecord.body.code, 'VIDEO_PREPARATION_REQUIRED');
    const unknown = await browserPost(route, { ...intent, requestId: 'f'.repeat(32), page: showPage });
    assert.equal(unknown.status, 409);
    const replay = await browserPost(route, { ...intent, requestId, page: proof });
    if (entry === 'manual') {
      assert.equal(replay.status, 201);
      assert.equal(replay.body.id, jobId);
    } else {
      assert.equal(replay.status, 409);
      assert.equal(replay.body.code, 'CANVAS_OP_CONFLICT');
    }
    let noCurrentPage;
    if (preset === 'video_speed') {
      const pollRoute = '**/api/agent/canvas/poll';
      await page.route(pollRoute, route => route.abort());
      try {
        const released = await browserPost('/api/agent/canvas/release', showPage);
        assert.equal(released.status, 200);
        noCurrentPage = await browserPost(route, { ...intent, requestId, page: proof });
        assert.equal(noCurrentPage.status, 409);
        assert.equal(noCurrentPage.body.code, 'NO_VISIBLE_CANVAS');
        assert.equal((await api(route + '/' + jobId)).id, jobId);
      } finally { await page.unroute(pollRoute); }
    }
    await reopen(id);
    await node(id).getByRole('progressbar', { name: '视频任务进度' }).waitFor({timeout: 12000});
    assert.equal(payloads.length, before + 1, 'reload only polls, never resubmits');
    if (evidencePath) await node(id).screenshot({ path: path.join(evidencePath, `${preset}-running.png`) });
    await writeFile(path.join(gate, jobId), '');
    const done = await until(async () => {
      const current = (await getNode()).data;
      if (current.status === 'error') throw new Error(current.error);
      return current.status === 'done' ? current : null;
    });
    const pathKey = { edit: 'editResultAssetPath', rhythm: 'rhythmResultAssetPath', chroma: 'chromaResultAssetPath', plate: 'plateResultAssetPath', repair: 'repairResultAssetPath' }[family];
    const assetPath = done[pathKey];
    assert.equal(done[key], jobId);
    assert.match(assetPath, /^assets\/[a-f0-9]{64}\.mp4$/);
    await reopen(id);
    assert.equal((await getNode()).data[pathKey], assetPath);
    const downloaded = await fetch(`${base}/api/projects/${fixture.id}/${assetPath}`, { headers: { 'X-H3-Token': token } });
    assert.ok(downloaded.ok);
    const filename = path.join(evidencePath || temporary, `${preset}-sample.mp4`);
    await writeFile(filename, Buffer.from(await downloaded.arrayBuffer()));
    const media = JSON.parse(py(`import json,sys
from video_edit_ffmpeg import Runner, probe, public_probe
print(json.dumps(public_probe(probe(Runner(),sys.argv[1]))))`, filename));
    assert.ok(media.frameCount > 0);
    evidence.push({ preset, entry, jobId, nodeId: id, progress: executing.progress, stage: executing.stage, assetPath, media,
      offPage: offPage.status, missingProof: missingProof.status, noCurrentPage: noCurrentPage?.status,
      noRecord: noRecord.status, unknown: unknown.status, replay: replay.status, reloadSubmitCount: payloads.length - before });
    if (evidencePath) await writeFile(path.join(evidencePath, 'browser-evidence.json'), JSON.stringify({ evidence }, null, 2));
    console.log(JSON.stringify(evidence.at(-1)));
  }

  const analysisNodeId = await create('video_edit', ['v1']);
  const analysis = await agent('canvas_start_video_analysis', { nodeId: analysisNodeId, slot: 'v1', mode: 'black' });
  assert.equal(analysis.ok, true, analysis.error);
  await writeFile(path.join(gate, analysis.jobId), '');
  const analyzed = await until(async () => {
    const status = await agent('canvas_get_video_analysis', { nodeId: analysisNodeId, jobId: analysis.jobId });
    assert.equal(status.ok, true, status.error);
    return ['queued', 'running'].includes(status.status) ? null : status;
  });
  assert.equal(analyzed.status, 'completed', analyzed.error);
  const savedAnalysis = (await read()).canvas.nodes.find(item => item.id === analysisNodeId).data.videoAnalysisSubmission;
  assert.equal(savedAnalysis.id, analysis.jobId);
  assert.ok(savedAnalysis.page.opId);

  const cancelledId = await create('video_speed', ['v1']);
  await focus(cancelledId);
  await node(cancelledId).getByRole('button', { name: '导出', exact: true }).click();
  const findCancelled = async () => (await read()).canvas.nodes.find((item) => item.id === cancelledId)?.data;
  const cancelJobId = await until(async () => (await findCancelled())?.rhythmJobId);
  await until(async () => (await api(`/api/video-rhythm/jobs/${cancelJobId}`)).progress > 0.01);
  assert.equal((await agent('canvas_cancel_video', { nodeId: cancelledId, jobId: 'vry_' + 'f'.repeat(32) })).code, 'JOB_CHANGED');
  const cancellation = await agent('canvas_cancel_video', { nodeId: cancelledId, jobId: cancelJobId });
  assert.equal(cancellation.ok, true, cancellation.error);
  assert.equal(cancellation.status, 'checking');
  const terminal = await agent('canvas_wait_for_node', { nodeId: cancelledId, jobId: cancelJobId, timeoutMs: 2500 });
  assert.equal(terminal.ok, true, terminal.error);
  assert.equal(terminal.node.status, 'cancelled');
  await node(cancelledId).getByRole('status').getByText('已取消', { exact: true }).waitFor();
  assert.equal((await api(`/api/video-rhythm/jobs/${cancelJobId}`)).status, 'cancelled');
  await until(async () => (await findCancelled())?.status === 'cancelled');
  await reopen(cancelledId);
  assert.equal((await findCancelled()).status, 'cancelled');
  assert.equal((await findCancelled()).rhythmResultAssetPath, undefined);
  const manualCancelId = await create('video_speed', ['v1']);
  await focus(manualCancelId);
  await node(manualCancelId).getByRole('button', { name: '导出', exact: true }).click();
  const manualCancelJob = await until(async () => (await read()).canvas.nodes.find((item) => item.id === manualCancelId)?.data.rhythmJobId);
  const manualCancelRoute = '/api/video-rhythm/jobs/' + manualCancelJob;
  await until(async () => (await api(manualCancelRoute)).progress > 0.01);
  await node(manualCancelId).getByRole('button', { name: '取消', exact: true }).click();
  await node(manualCancelId).getByRole('status').getByText('已取消', { exact: true }).waitFor();
  assert.equal((await api(manualCancelRoute)).status, 'cancelled');

  const failedId = await create('video_edit', ['v1']);
  await focus(failedId);
  const editDocument = defaultVideoEditDocument();
  editDocument.clips[0].sourceOutPts = 480;
  const invalidSettings = await agent('canvas_update_node', { nodeId: failedId, settings: { editDocument } });
  assert.equal(invalidSettings.ok, true, invalidSettings.error);
  const failing = await agent('canvas_generate_node', { nodeId: failedId, wait: false });
  assert.equal(failing.ok, true, failing.error);
  await writeFile(path.join(gate, failing.jobId), '');
  const failed = await until(async () => {
    const job = await api('/api/video-edit/jobs/' + failing.jobId);
    if (job.status === 'completed') assert.fail('An out-of-range clip must fail in the real worker.');
    return job.status === 'failed' ? job : null;
  });
  await node(failedId).getByRole('alert').filter({ hasText: failed.error }).waitFor();
  await until(async () => (await read()).canvas.nodes.find((item) => item.id === failedId)?.data.status === 'error');
  if (evidencePath) {
    await node(failedId).screenshot({ path: path.join(evidencePath, 'video-edit-worker-error.png') });
    await writeFile(path.join(evidencePath, 'terminal-evidence.json'), JSON.stringify({ agentCancel: cancelJobId,
      manualCancel: manualCancelJob, failedJobId: failing.jobId, failure: failed.error }, null, 2));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(interrupts, []);
  if (evidencePath) await writeFile(path.join(evidencePath, 'browser-evidence.json'), JSON.stringify({ evidence, cancelJobId, cancelledId }, null, 2));
  console.log('VIDEO_JOB_VISIBILITY_OK');
} catch (error) {
  console.error('Isolated backend status:', backend.exitCode, logs);
  throw error;
} finally {
  await browser?.close();
  backend.kill();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
