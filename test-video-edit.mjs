import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { normalizeVideoEditDocument, defaultVideoEditDocument, planVideoEditConnection, nextVideoEditPort, framesOf, videoEditInputs, videoEditSummary } from './src/video-edit-document.js';
import { planCanvasConnection } from './src/canvas-connections.js';
import { registerCanvasMcp, generateNodeForMcp, waitForNodeForMcp, NODE_PRESETS } from './src/canvas-mcp.js';
import { createVideoEditRunner } from './src/video-edit-runtime.js';

const F24 = { num: 1, den: 24 };
const clip = (extra = {}) => ({ id: 'c1', inputSlot: 'v1', sourceInPts: 0, sourceOutPts: 24, timebase: F24, ...extra });
const doc = (clips = [clip()], profile = {}) => ({ schemaVersion: 1, outputProfile: { fps: { num: 24, den: 1 }, ...profile }, clips });

// 1. JS schema == Python schema (same accept/reject and same normalized output).
const cases = [
  doc(), defaultVideoEditDocument(), doc([clip({ reverse: true, pad: { mode: 'last_frame', count: 5 }, gain: 0.5, muted: true })]),
  doc([clip()], { fps: { num: 30000, den: 1001 } }), { ...doc(), timelineTimebase: { num: 1, den: 12288 } },
  doc([clip()], { audio: 'external', audioFrom: { inputSlot: 'a1', sourceInPts: 0, sourceOutPts: 24, timebase: F24 } }),
  doc([clip()], { width: 1280, height: 720, crf: 18 }),
  // invalid
  { ...doc(), path: 'C:/x' }, doc([clip({ inputSlot: 'C:/x.mp4' })]), doc([clip({ filter: 'hflip' })]), doc([clip()], { filter: 'x' }),
  doc([clip({ sourceOutPts: 0 })]), doc([clip({ sourceInPts: -1 })]), doc([clip({ sourceInPts: 1.5 })]), doc([clip({ gain: 2 })]),
  doc([clip({ pad: { mode: 'none', count: 2 } })]), doc([clip({ id: 'a b' })]), doc([clip(), clip()]), doc([clip()], { width: 101, height: 72 }),
  doc([clip()], { videoCodec: 'copy' }), { ...doc(), timelineTimebase: { num: 1, den: 25 } }, doc([clip()], { audioFrom: { inputSlot: 'v1', sourceInPts: 0, sourceOutPts: 1 } }),
  doc([]), { ...doc(), schemaVersion: 2 }, doc([clip({ inputSlot: 'a1' })]),
];
const js = cases.map((value) => { try { return normalizeVideoEditDocument(value); } catch { return { error: true }; } });
const python = process.env.H3_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const script = 'import json,sys\nsys.path.insert(0, ".")\nfrom video_edit_document import normalize_document, EditDocumentError\nout=[]\nfor d in json.load(sys.stdin):\n    try: out.append(normalize_document(d))\n    except EditDocumentError: out.append({"error": True})\nprint(json.dumps(out))';
const run = spawnSync(python, ['-c', script], { input: JSON.stringify(cases), encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr);
assert.deepEqual(js, JSON.parse(run.stdout), 'JS 与 Python editDocument schema 结果不一致');
assert.equal(js.filter((item) => item.error).length, 18);

// 2. Frame count helper mirrors the Python grid.
assert.equal(framesOf(clip({ sourceInPts: 7, sourceOutPts: 19, pad: { mode: 'last_frame', count: 3 } }), { num: 24, den: 1 }), 15);
assert.equal(framesOf({ ...clip(), timebase: { num: 1001, den: 30000 }, sourceInPts: 0, sourceOutPts: 37 }, { num: 24, den: 1 }), Math.ceil(37 * 24 * 1001 / 30000));

// 3. Connections.
const video = { id: 'm1', type: 'media', data: { kind: 'video', assetPath: `assets/${'a'.repeat(64)}.mp4`, title: '原片' } };
const image = { id: 'm2', type: 'media', data: { kind: 'image', assetPath: `assets/${'b'.repeat(64)}.png` } };
const audio = { id: 'm3', type: 'media', data: { kind: 'audio', assetPath: `assets/${'c'.repeat(64)}.wav` } };
const edit = { id: 'e1', type: 'videoEdit', data: { title: '剪辑', editDocument: normalizeVideoEditDocument(doc()) } };
const edit2 = { id: 'e2', type: 'videoEdit', data: { title: '二剪', editDocument: normalizeVideoEditDocument(doc()) } };
const nodes = [video, image, audio, edit, edit2];
assert.ok(!planCanvasConnection({ source: 'm1', target: 'e1', targetHandle: 'v1' }, nodes, []).error);
assert.match(planCanvasConnection({ source: 'm2', target: 'e1', targetHandle: 'v1' }, nodes, []).error, /视频端口/);
assert.match(planCanvasConnection({ source: 'm3', target: 'e1', targetHandle: 'v2' }, nodes, []).error, /视频端口/);
assert.ok(!planCanvasConnection({ source: 'm3', target: 'e1', targetHandle: 'a1' }, nodes, []).error);
assert.match(planCanvasConnection({ source: 'm1', target: 'e1', targetHandle: 'guide' }, nodes, []).error, /v1–v8/);
assert.ok(!planCanvasConnection({ source: 'e1', target: 'e2', targetHandle: 'v1' }, nodes, []).error);
assert.match(planCanvasConnection({ source: 'e2', target: 'e1', targetHandle: 'v1' }, nodes, [{ source: 'e1', target: 'e2', targetHandle: 'v1' }]).error, /循环/);
assert.equal(nextVideoEditPort(edit, video, [{ source: 'm1', target: 'e1', targetHandle: 'v1' }]), 'v2');
assert.equal(nextVideoEditPort(edit, audio, []), 'a1');
assert.throws(() => videoEditInputs('e2', nodes, [{ source: 'e1', target: 'e2', targetHandle: 'v1' }]), /请先导出上游/);
assert.equal(planCanvasConnection({ source: 'm2', target: 'e1', targetHandle: 'v1' }, [...nodes, { id: 'g', type: 'generator', data: { mode: 'qwenEdit' } }], []).error !== undefined, true);

// 4. Agent tools through the real registration.
assert.deepEqual(NODE_PRESETS.video_edit, ['videoEdit', { title: '视频编辑' }]);
{
  const tools = new Map();
  const created = [];
  const edges = [];
  const latest = { current: { projectId: 'prj_fixture', readOnly: false, nodesRef: { current: [video, image, { ...edit, data: { ...edit.data } }] }, edgesRef: { current: edges }, actions: {
    addNode: (type, extra) => { created.push([type, extra]); const id = 'videoEdit-new'; latest.current.nodesRef.current.push({ id, type, position: { x: 0, y: 0 }, data: { status: 'idle', editDocument: defaultVideoEditDocument(), ...extra } }); return id; },
    updateNode: (id, patch) => { const node = latest.current.nodesRef.current.find((item) => item.id === id); node.data = { ...node.data, ...patch }; },
    onConnect: (connection) => { const plan = planCanvasConnection(connection, latest.current.nodesRef.current, edges); if (plan.error) return { error: plan.error }; const e = { ...plan.connection, id: `edge-${edges.length}` }; edges.push(e); return { edgeId: e.id }; },
    generateNode: async (id) => { const node = latest.current.nodesRef.current.find((item) => item.id === id); node.data = { ...node.data, status: 'running', videoEditJobId: `ved_${'1'.repeat(32)}` }; setTimeout(() => { node.data = { ...node.data, status: 'done', editResultAssetPath: `assets/${'d'.repeat(64)}.mp4` }; }, 20); return { ok: true, jobId: `ved_${'1'.repeat(32)}` }; },
    persistProject: async () => {},
  } } };
  const dispose = registerCanvasMcp(latest, { context: { registerTool: (tool) => tools.set(tool.name, tool) }, startPage: () => () => {} });
  const call = async (name, args) => JSON.parse(await tools.get(name).execute(args));
  try {
    const node = await call('canvas_create_node', { preset: 'video_edit' });
    assert.equal(node.ok, true); assert.equal(node.node.type, 'videoEdit'); assert.equal(created[0][0], 'videoEdit');
    const id = node.node.id;
    const c1 = await call('canvas_connect_nodes', { sourceId: 'm1', targetId: id });
    assert.equal(c1.edge.targetHandle, 'v1');
    const bad = await call('canvas_connect_nodes', { sourceId: 'm2', targetId: id });
    assert.equal(bad.ok, false);
    const document = doc([clip({ sourceInPts: 12, sourceOutPts: 372 }), clip({ id: 'c2', sourceInPts: 372, sourceOutPts: 400, reverse: true, pad: { mode: 'last_frame', count: 4 } })], { audio: 'external', audioFrom: { inputSlot: 'v1', sourceInPts: 12, sourceOutPts: 404, timebase: F24 } });
    const updated = await call('canvas_update_node', { nodeId: id, settings: { editDocument: document } });
    assert.equal(updated.ok, true, updated.error);
    assert.equal(updated.node.clipCount, 2);
    assert.deepEqual(updated.node.editDocument.clips[1].pad, { mode: 'last_frame', count: 4 });
    assert.equal(updated.node.editDocument.clips[0].gain, 1, '缺省值已规范化');
    const invalid = await call('canvas_update_node', { nodeId: id, settings: { editDocument: { ...document, clips: [clip({ inputSlot: '../x' })] } } });
    assert.equal(invalid.ok, false);
    const wrongNode = await call('canvas_update_node', { nodeId: 'm1', settings: { editDocument: document } });
    assert.equal(wrongNode.ok, false);
    assert.match(wrongNode.error, /仅适用于视频编辑节点/);
    const unknown = await call('canvas_update_node', { nodeId: id, settings: { ffmpegArgs: ['-i', 'x'] } });
    assert.equal(unknown.ok, false);
    const big = doc(Array.from({ length: 64 }, (_, index) => clip({ id: `shot_${index}`, sourceInPts: index * 10, sourceOutPts: index * 10 + 10, reverse: index % 2 === 1, pad: { mode: 'last_frame', count: 17 }, gain: 0.75 })), { width: 1920, height: 1080 });
    assert.ok(new TextEncoder().encode(JSON.stringify({ tool: 'canvas_update_node', args: { nodeId: id, settings: { editDocument: big } } })).length < 32768, '64 镜头文档仍在页面桥 32KB 以内');
    const generated = await call('canvas_generate_node', { nodeId: id });
    assert.equal(generated.ok, true); assert.equal(generated.jobId, `ved_${'1'.repeat(32)}`); assert.equal(generated.node.status, 'running');
    const fastWait = async (read, timeoutMs = 1000) => { const end = Date.now() + timeoutMs; for (;;) { const v = read(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 2)); } };
    const finished = await waitForNodeForMcp(latest, { nodeId: id, timeoutMs: 1000 }, fastWait);
    assert.equal(finished.node.status, 'done'); assert.equal(finished.node.hasMedia, true); assert.equal(finished.node.editResultAssetPath, `assets/${'d'.repeat(64)}.mp4`);
    const state = await call('canvas_get_state', { nodeId: id });
    assert.equal(state.nodes[0].editStale, true, '未经 runner 写回签名的结果视为待重新导出');
  } finally { dispose(); }
}

// 5. Runner: submit → poll → commit through the page's versioned asset channel → same node.
{
  const calls = [];
  const jobId = `ved_${'2'.repeat(32)}`;
  let polls = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET', options.body ? JSON.parse(options.body) : null]);
    const json = (status, value) => ({ ok: status < 400, status, json: async () => value, blob: async () => new Blob(['x'], { type: 'video/mp4' }) });
    if (url === '/comfy/view?filename=sam3.mp4') return json(200, {});
    if (url === '/api/video-edit/jobs') return json(201, { id: jobId, status: 'queued', stage: '排队中', progress: 0 });
    if (url === `/api/video-edit/jobs/${jobId}`) return json(200, ++polls < 2 ? { id: jobId, status: 'running', stage: '正在逐帧导出', progress: 0.5 } : { id: jobId, status: 'completed', stage: '已导出', progress: 1, result: { frames: 24, width: 128, height: 72, audio: 'clips' } });
    if (url === `/api/video-edit/jobs/${jobId}/commit`) return json(201, { asset: { path: `assets/${'e'.repeat(64)}.mp4` }, revision: 9 });
    if (url.endsWith('/cancel')) return json(200, {});
    return json(404, { message: 'nope' });
  };
  const generated = { id: 'r1', type: 'media', data: { kind: 'video', url: '/comfy/view?filename=sam3.mp4', name: 'sam3.mp4', title: 'SAM3 成品' } };
  const node = { id: 'e9', type: 'videoEdit', data: { title: '剪', status: 'idle', editDocument: normalizeVideoEditDocument(doc()) } };
  const nodes = [generated, node];
  const edges = [{ source: 'r1', target: 'e9', targetHandle: 'v1' }];
  const jobs = new Map();
  const uploads = [];
  let revision = 7, persisted = 0;
  const runner = createVideoEditRunner({ getProjectId: () => 'prj_fixture', getNodes: () => nodes, getEdges: () => edges, jobs,
    updateNode: (id, patch) => { const item = nodes.find((n) => n.id === id); item.data = { ...item.data, ...patch }; },
    saveCanvasMedia: async (write, onSaved) => { const result = await write(revision); revision = result.revision; return onSaved(result); },
    saveProjectFile: async (storageId, file, rev) => { uploads.push([file.name, rev]); return { asset: { path: `assets/${'f'.repeat(64)}.mp4` }, revision: rev + 1 }; },
    persistProject: async () => { persisted += 1; } });
  const started = await runner.run('e9');
  assert.deepEqual(started, { ok: true, jobId });
  assert.deepEqual(uploads, [['sam3.mp4', 7]], '生成结果经页面通道导入一次');
  const submit = calls.find(([url]) => url === '/api/video-edit/jobs')[2];
  assert.deepEqual(submit.inputs, { v1: `assets/${'f'.repeat(64)}.mp4` });
  assert.equal(generated.data.assetPath, undefined, '源结果节点不被修改');
  assert.equal(jobs.has('e9'), true);
  for (let i = 0; i < 100 && node.data.status !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(nodes[1].data.status, 'done');
  assert.equal(nodes[1].data.editResultAssetPath, `assets/${'e'.repeat(64)}.mp4`);
  assert.equal(calls.find(([url]) => url.endsWith('/commit'))[2].revision, 8, 'commit 使用页面当前 revision');
  assert.equal(nodes[1].data.editResultDocument, JSON.stringify(nodes[1].data.editDocument));
  assert.equal(videoEditSummary(nodes[1].data).editStale, false);
  assert.equal(persisted, 1);
  assert.equal(jobs.has('e9'), false);
  // second run reuses the cached import and can be cancelled (only this job).
  polls = -1000;
  const again = await runner.run('e9');
  assert.equal(again.ok, true);
  assert.equal(uploads.length, 1, '已导入的生成结果不重复上传');
  runner.cancel('e9');
  for (let i = 0; i < 40 && nodes[1].data.status !== 'cancelled'; i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(nodes[1].data.status, 'cancelled');
  assert.ok(calls.some(([url, method]) => url === `/api/video-edit/jobs/${jobId}/cancel` && method === 'POST'));
  assert.ok(!calls.some(([url]) => url.includes('interrupt')), '不调用全局 interrupt');
  // invalid documents never reach the backend
  const before = calls.length;
  nodes[1].data = { ...nodes[1].data, status: 'idle', editDocument: { ...doc(), clips: [clip({ inputSlot: 'C:/x.mp4' })] } };
  assert.equal((await runner.run('e9')).ok, false);
  assert.equal(calls.length, before);
}
console.log('VIDEO_EDIT_OK schema parity with Python, connections, agent tools (create/connect/update/generate/wait), 32KB budget, runner import/commit/cancel');
