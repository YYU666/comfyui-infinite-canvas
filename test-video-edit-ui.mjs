// Offline end-to-end check of the video edit node: a temporary backend + project,
// a synthetic frame-indexed video, and only the existing agent canvas tools.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'h3-video-edit-'));
const runtime = path.join(temporary, 'runtime');
const projects = path.join(temporary, 'projects');
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: projects, H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'), H3_COMFY_URL: 'http://127.0.0.1:1', H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1', PYTHONUTF8: '1' };
const py = (code, ...args) => {
  const result = spawnSync(python, ['-X', 'utf8', '-c', `import sys; sys.path.insert(0, '.')\n${code}`, ...args], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const source = path.join(temporary, 'source.mp4');
py('import sys; from fractions import Fraction; from video_edit_testmedia import make_video; make_video(sys.argv[1], 480, Fraction(24))', source);
const backend = spawn(python, ['-X', 'utf8', 'video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  let op = 0;
  const tb = { num: 1, den: 24 };
  const fps = { num: 24, den: 1 };
  const clip = (id, inputSlot, sourceInPts, sourceOutPts, extra = {}) => ({ id, inputSlot, sourceInPts, sourceOutPts, timebase: tb, ...extra });
  const editNode = async (title, sources, document) => {
    const created = await call(`qa-${++op}`, 'canvas_create_node', { preset: 'video_edit', title, focus: false });
    assert.equal(created.ok, true, created.error); assert.equal(created.node.type, 'videoEdit');
    for (const [sourceId, port] of sources) {
      const edge = await call(`qa-${++op}`, 'canvas_connect_nodes', { sourceId, targetId: created.node.id, ...(port ? { targetHandle: port } : {}) });
      assert.equal(edge.ok, true, edge.error);
    }
    const updated = await call(`qa-${++op}`, 'canvas_update_node', { nodeId: created.node.id, settings: { editDocument: { schemaVersion: 1, ...document } } });
    assert.equal(updated.ok, true, updated.error);
    const submitted = await call(`qa-${++op}`, 'canvas_generate_node', { nodeId: created.node.id, wait: false });
    assert.equal(submitted.ok, true, submitted.error); assert.match(submitted.jobId || submitted.node.videoEditJobId || '', /^ved_[a-f0-9]{32}$/);
    // The page bridge only accepts wait:false and has no canvas_wait_for_node; poll canvas_get_state.
    const done = await until(async () => {
      const state = await call(`qa-${++op}`, 'canvas_get_state', { nodeId: created.node.id });
      const item = state.nodes?.find((n) => n.id === created.node.id);
      if (['error', 'cancelled'].includes(item?.status)) throw new Error(JSON.stringify(item));
      return item?.status === 'done' ? { ok: true, node: item } : null;
    }, 120000);
    assert.equal(done.node.status, 'done', JSON.stringify(done.node));
    assert.equal(done.node.editStale, false);
    return { id: created.node.id, node: done.node };
  };
  // 1. 从原片剪 15 秒 (2s–17s)
  const cut = await editNode('剪 15 秒', [['source']], { outputProfile: { fps }, clips: [clip('cut', 'v1', 48, 408)] });
  // 2+3. 取第二个镜头（5s–10s），倒放并补 12 帧（模拟送去生成前的补帧）
  const reversed = await editNode('倒放+补帧', [[cut.id]], { outputProfile: { fps }, clips: [clip('shot2', 'v1', 120, 240, { reverse: true, pad: { mode: 'last_frame', count: 12 } })] });
  // 4. 还原（再倒放）+ 裁掉补帧
  const restored = await editNode('还原+裁补帧', [[reversed.id]], { outputProfile: { fps }, clips: [clip('restore', 'v1', 0, 120, { reverse: true })] });
  // 5. 拼回并贴上 15 秒段的原声
  const final = await editNode('拼回+原声', [[cut.id, 'v1'], [restored.id, 'v2']], { outputProfile: { fps, audio: 'external', audioFrom: { inputSlot: 'v1', sourceInPts: 0, sourceOutPts: 360, timebase: tb } },
    clips: [clip('s1', 'v1', 0, 120), clip('s2', 'v2', 0, 120), clip('s3', 'v1', 240, 360)] });
  assert.equal(final.node.editResult.frames, 360);
  assert.deepEqual(final.node.editResult.clips.map((item) => item.timelineStartFrame), [0, 120, 240]);
  const saved = await until(async () => { const doc = await read(); return doc.canvas.nodes.find((n) => n.id === final.id)?.data.editResultAssetPath ? doc : null; });
  const assetPath = saved.canvas.nodes.find((n) => n.id === final.id).data.editResultAssetPath;
  assert.ok(saved.assets.some((asset) => asset.path === assetPath), 'result committed as a versioned project asset');
  const reversedPath = saved.canvas.nodes.find((n) => n.id === reversed.id).data.editResultAssetPath;
  const download = async (asset, name) => { const response = await fetch(`${base}/api/projects/${fixture.id}/${asset}`, { headers: { 'X-H3-Token': token } }); assert.ok(response.ok); const file = path.join(temporary, name); await writeFile(file, Buffer.from(await response.arrayBuffer())); return file; };
  const finalFile = await download(assetPath, 'final.mp4');
  const reversedFile = await download(reversedPath, 'reversed.mp4');
  const check = JSON.parse(py(`import sys, json
from fractions import Fraction
from video_edit_testmedia import read_indices, audio_marks
final = read_indices(sys.argv[1]); marks, samples = audio_marks(sys.argv[1], Fraction(24), len(final)); rev = read_indices(sys.argv[2])
print(json.dumps({"final": final, "marks": marks, "samples": samples, "rev": rev}))`, finalFile, reversedFile));
  assert.deepEqual(check.final, Array.from({ length: 360 }, (_, index) => 48 + index), '拼回后与原片逐帧一致');
  assert.deepEqual(check.marks, check.final.map((index) => index % 10 === 0), '外挂原声与画面逐帧同步');
  assert.equal(check.samples, 360 * 2000);
  assert.deepEqual(check.rev, [...Array.from({ length: 120 }, (_, index) => 287 - index), ...Array(12).fill(168)], '倒放+补帧');
  // The panel opens on double click and shows the four timeline clips of the final node.
  await call(`qa-${++op}`, 'canvas_focus_node', { nodeId: final.id });
  await node(final.id).locator('.video-edit-result video').waitFor();
  await node(final.id).screenshot({ path: path.join(process.env.H3_TEST_SCREENSHOT_DIR || temporary, 'video-edit-node.png') });
  await node(final.id).locator('.video-edit-heading').dblclick();
  await page.locator('.video-edit-panel').waitFor();
  assert.equal(await page.locator('.video-edit-panel .video-edit-clip').count(), 3);
  await page.screenshot({ path: path.join(process.env.H3_TEST_SCREENSHOT_DIR || temporary, 'video-edit-panel.png') });
  await page.keyboard.press('Escape');
  await until(async () => (await page.locator('.video-edit-panel').count()) === 0, 5000);
  // An invalid agent document is rejected before reaching the backend.
  const invalid = await call(`qa-${++op}`, 'canvas_update_node', { nodeId: final.id, settings: { editDocument: { schemaVersion: 1, clips: [{ id: 'x', inputSlot: 'C:/Windows/x.mp4', sourceInPts: 0, sourceOutPts: 1 }] } } });
  assert.equal(invalid.ok, false);
  assert.deepEqual(interrupts, [], 'no ComfyUI queue or interrupt requests');
  assert.deepEqual(errors, []);
  console.log('VIDEO_EDIT_UI_OK cut 15s → reverse+pad → restore+trim → reassemble with original audio via agent tools; frame-exact, audio-synced, versioned assets, panel opens');
} finally {
  await browser?.close();
  backend.kill();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
