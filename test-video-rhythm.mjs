import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { planCanvasConnection } from './src/canvas-connections.js';
import { NODE_PRESETS, generateNodeForMcp, registerCanvasMcp } from './src/canvas-mcp.js';
import { normalizeVideoEditDocument } from './src/video-edit-document.js';
import { createVideoRhythmRunner } from './src/video-rhythm-runtime.js';
import {
  defaultRemapKeyframes,
  freezeAt,
  normalizeRemapDocument,
  normalizeSpeedDocument,
  sampleSourceTime,
  speedFrameCount,
} from './src/video-rhythm-document.js';

const speed = (value, audio = 'preserve') => ({ schemaVersion: 1, operation: 'speed', speed: value, audio });
const remap = (keyframes) => ({ schemaVersion: 1, operation: 'remap', keyframes });
const cases = [
  speed(0.5), speed(2), speed(1, 'mute'), speed(0.25, 'stretch'),
  remap(freezeAt(2, 1)), remap(defaultRemapKeyframes()),
  remap([{ output: 0, source: 0, interpolation: 'easeInOut' }, { output: 4, source: 2 }]),
  { ...speed(0.5), filter: 'atempo=2' }, speed(0), speed(8), speed(Number.NaN),
  remap([{ output: 0, source: 1 }, { output: 1, source: 0 }]),
  remap([{ output: 1, source: 0 }, { output: 2, source: 1 }]),
  remap([{ output: 0, source: 0, interpolation: 'bezier' }]),
];
const js = cases.map((value) => {
  try { return 'keyframes' in value ? normalizeRemapDocument(value) : normalizeSpeedDocument(value); }
  catch { return { error: true }; }
});
const python = process.env.H3_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const script = `import json,sys
sys.path.insert(0, ".")
from video_rhythm_document import RhythmDocumentError, normalize_remap_document, normalize_speed_document
out=[]
for item in json.load(sys.stdin):
    try:
        out.append(normalize_remap_document(item) if "keyframes" in item else normalize_speed_document(item))
    except RhythmDocumentError:
        out.append({"error": True})
print(json.dumps(out))`;
const run = spawnSync(python, ['-c', script], { input: JSON.stringify(cases), encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr);
assert.deepEqual(js, JSON.parse(run.stdout), 'JS 与 Python 节奏 schema 不一致');
assert.equal(sampleSourceTime(freezeAt(2, 1), 2.5), 2);
assert.equal(speedFrameCount(24, 0.5), 48);
assert.equal(speedFrameCount(24, 2), 12);

const video = { id: 'm1', type: 'media', data: { kind: 'video', assetPath: `assets/${'a'.repeat(64)}.mp4`, title: '原片' } };
const speedNode = { id: 's1', type: 'videoSpeed', data: { title: '慢放', speed: 0.5, rhythmAudio: 'preserve' } };
const remapNode = { id: 'r1', type: 'videoTimeRemap', data: { title: '定格', remapKeyframes: freezeAt(2, 1) } };
const edit = { id: 'e1', type: 'videoEdit', data: { title: '剪辑', editDocument: normalizeVideoEditDocument({ schemaVersion: 1, outputProfile: { fps: { num: 24, den: 1 } }, clips: [{ id: 'c1', inputSlot: 'v1', sourceInPts: 0, sourceOutPts: 24, timebase: { num: 1, den: 24 } }] }) } };
const generator = { id: 'g1', type: 'generator', data: { mode: 'swap', title: '角色替换' } };
const nodes = [video, speedNode, remapNode, edit, generator];
assert.equal(planCanvasConnection({ source: 'm1', target: 's1', targetHandle: 'v1' }, nodes, []).connection.targetHandle, 'v1');
assert.equal(planCanvasConnection({ source: 's1', target: 'r1', targetHandle: 'v1' }, nodes, []).connection.targetHandle, 'v1');
assert.equal(planCanvasConnection({ source: 'r1', target: 'e1', targetHandle: 'v1' }, nodes, []).connection.targetHandle, 'v1');
assert.equal(planCanvasConnection({ source: 'e1', target: 's1', targetHandle: 'v1' }, nodes, []).connection.targetHandle, 'v1');
assert.match(planCanvasConnection({ source: 's1', target: 'r1', targetHandle: 'v1' }, nodes, [{ source: 'r1', target: 's1', targetHandle: 'v1' }]).error, /循环/);
assert.match(planCanvasConnection({ source: 's1', target: 'g1', targetHandle: 'guide' }, nodes, []).error, /SAM3/);
assert.deepEqual(NODE_PRESETS.video_speed.slice(0, 1), ['videoSpeed']);
assert.equal(NODE_PRESETS.video_time_remap[0], 'videoTimeRemap');

{
  const tools = new Map();
  const edges = [];
  const latest = { current: { projectId: 'prj_fixture', readOnly: false, nodesRef: { current: [video, speedNode] }, edgesRef: { current: edges }, actions: {
    addNode: (type, extra) => { const id = `${type}-new`; latest.current.nodesRef.current.push({ id, type, position: { x: 0, y: 0 }, data: { status: 'idle', ...extra } }); return id; },
    updateNode: (id, patch) => { const node = latest.current.nodesRef.current.find((item) => item.id === id); node.data = { ...node.data, ...patch }; },
    onConnect: (connection) => { const plan = planCanvasConnection(connection, latest.current.nodesRef.current, edges); if (plan.error) return { error: plan.error }; const edge = { ...plan.connection, id: `edge-${edges.length}` }; edges.push(edge); return { edgeId: edge.id }; },
    generateNode: async (id) => { const node = latest.current.nodesRef.current.find((item) => item.id === id); node.data = { ...node.data, status: 'running', rhythmJobId: `vry_${'3'.repeat(32)}` }; return { ok: true, jobId: node.data.rhythmJobId }; },
    persistProject: async () => {},
  } } };
  const dispose = registerCanvasMcp(latest, { context: { registerTool: (tool) => tools.set(tool.name, tool) }, startPage: () => () => {} });
  const call = async (name, args) => JSON.parse(await tools.get(name).execute(args));
  try {
    const created = await call('canvas_create_node', { preset: 'video_speed', title: '升格' });
    assert.equal(created.node.type, 'videoSpeed');
    const id = created.node.id;
    const connected = await call('canvas_connect_nodes', { sourceId: 'm1', targetId: id });
    assert.equal(connected.edge.targetHandle, 'v1');
    const updated = await call('canvas_update_node', { nodeId: id, settings: { speed: 2, rhythmAudio: 'mute' } });
    assert.equal(updated.node.speed, 2);
    assert.equal(updated.node.rhythmAudio, 'mute');
    const wrong = await call('canvas_update_node', { nodeId: 'm1', settings: { speed: 2 } });
    assert.equal(wrong.ok, false);
    const generated = await call('canvas_generate_node', { nodeId: id });
    assert.equal(generated.jobId, `vry_${'3'.repeat(32)}`);
    const remapNodeId = (await call('canvas_create_node', { preset: 'video_time_remap' })).node.id;
    const frozen = await call('canvas_update_node', { nodeId: remapNodeId, settings: { remapKeyframes: freezeAt(2, 1) } });
    assert.equal(frozen.ok, true, frozen.error);
    assert.equal(frozen.node.remapKeyframes[2].source, 2);
    assert.equal(frozen.node.remapKeyframes[2].output, 3);
    const badCurve = await call('canvas_update_node', { nodeId: remapNodeId, settings: { remapKeyframes: [{ output: 0, source: 1 }, { output: 1, source: 0 }] } });
    assert.equal(badCurve.ok, false);
  } finally { dispose(); }
}

{
  const calls = [];
  const jobId = `vry_${'4'.repeat(32)}`;
  let polls = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET', options.body ? JSON.parse(options.body) : null]);
    const json = (status, value) => ({ ok: status < 400, status, json: async () => value });
    if (url === '/api/video-rhythm/jobs') return json(201, { id: jobId, status: 'queued', stage: '排队中', progress: 0 });
    if (url === `/api/video-rhythm/jobs/${jobId}`) return json(200, ++polls < 2 ? { id: jobId, status: 'running', stage: '正在逐帧导出', progress: 0.4 } : { id: jobId, status: 'completed', stage: '已导出', progress: 1, result: { frames: 48, audio: 'preserve' } });
    if (url === `/api/video-rhythm/jobs/${jobId}/commit`) return json(201, { asset: { path: `assets/${'e'.repeat(64)}.mp4` }, revision: 4 });
    return json(404, { message: 'nope' });
  };
  const node = { id: 's9', type: 'videoSpeed', data: { title: '慢放', status: 'idle', speed: 0.5, rhythmAudio: 'preserve' } };
  const nodes = [video, node];
  const edges = [{ source: 'm1', target: 's9', targetHandle: 'v1' }];
  const jobs = new Map();
  const runner = createVideoRhythmRunner({
    getProjectId: () => 'prj_fixture', getNodes: () => nodes, getEdges: () => edges, jobs,
    updateNode: (id, patch) => { const item = nodes.find((entry) => entry.id === id); item.data = { ...item.data, ...patch }; },
    saveCanvasMedia: async (write, onSaved) => onSaved(await write(3)),
    saveProjectFile: async () => { throw new Error('已有项目素材，不应重新上传'); },
    persistProject: async () => {},
  });
  const started = await runner.run('s9');
  assert.equal(started.jobId, jobId);
  const submit = calls.find(([url]) => url === '/api/video-rhythm/jobs')[2];
  assert.equal(submit.operation, 'speed');
  assert.equal(submit.settings.speed, 0.5);
  assert.equal(submit.input, video.data.assetPath);
  for (let index = 0; index < 40 && node.data.status !== 'done'; index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(node.data.rhythmResultAssetPath, `assets/${'e'.repeat(64)}.mp4`);
  assert.equal(node.data.status, 'done');
}
console.log('VIDEO_RHYTHM_OK schema parity, freeze curve, downstream connections, agent speed/remap, runner');
