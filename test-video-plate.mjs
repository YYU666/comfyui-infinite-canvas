import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { planCanvasConnection } from './src/canvas-connections.js';
import { NODE_PRESETS, registerCanvasMcp } from './src/canvas-mcp.js';
import { createVideoPlateRunner } from './src/video-plate-runtime.js';
import {
  defaultPlateSettings,
  normalizePlateDocument,
  plateDocumentFromNode,
  videoPlateSummary,
} from './src/video-plate-document.js';

const documents = [
  {},
  { keepPrompts: 'person, pole' },
  { keepPrompts: 'person，pole' },
  { keepPrompts: ['person', '杆子'] },
  { shadeMode: 'shaded', greenColor: '#00ff00', maskGrow: 0, maskFeather: 0 },
  { shadeMode: 'clay' },
  { greenColor: '#00FF00;rm' },
  { maskGrow: -1 },
  { maskGrow: true },
  { maskFeather: 1.5 },
  { keepPrompts: [] },
  { keepPrompts: ['person', 'pole', 'hat', 'bag', 'sky'] },
  { schemaVersion: 2 },
  { points: [[0, 0]] },
];
const jsDocuments = documents.map((value) => {
  try { return normalizePlateDocument(value); }
  catch { return { error: true }; }
});
const python = process.env.H3_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const script = `import json,sys
sys.path.insert(0, ".")
from video_plate_document import PlateDocumentError, normalize_plate_document
from test_video_plate import sample_report
payload = json.load(sys.stdin)
out = {"documents": [], "sample": sample_report()}
for item in payload["documents"]:
    try: out["documents"].append(normalize_plate_document(item))
    except PlateDocumentError: out["documents"].append({"error": True})
print(json.dumps(out))`;
const run = spawnSync(python, ['-c', script], { input: JSON.stringify({ documents }), encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr);
const parsed = JSON.parse(run.stdout);
assert.deepEqual(jsDocuments, parsed.documents, 'JS 与 Python 绿幕白模 schema 不一致');
assert.deepEqual(normalizePlateDocument({}), {
  schemaVersion: 1, keepPrompts: ['person', 'pole'], maskGrow: 8, maskFeather: 2, shadeMode: 'flat', greenColor: '#00FF00',
});

const report = parsed.sample;
assert.equal(report.width, 64);
assert.equal(report.height, 100);
assert.equal(report.frames, 8);
assert.deepEqual(report.frameTimebase, [1, 24]);
assert.equal(report.hasAudio, true);
assert.deepEqual(report.keepPrompts, ['person', 'pole']);
for (const key of ['floor', 'background', 'lastFloor', 'shadedFloor']) assert.deepEqual(report[key], [0, 255, 0], key);
assert.deepEqual(report.person, [255, 255, 255]);
assert.deepEqual(report.poleOnFloor, [255, 255, 255]);
for (const key of ['shadedPerson', 'shadedLight']) {
  const pixel = report[key];
  assert.equal(new Set(pixel).size, 1, key);
  assert.ok(Math.min(...pixel) >= 210, key);
  assert.notDeepEqual(pixel, [0, 255, 0]);
}
assert.ok(report.shadedLight.reduce((sum, item) => sum + item, 0) > report.shadedPerson.reduce((sum, item) => sum + item, 0));
assert.deepEqual(report.growEdge, [255, 255, 255]);
assert.deepEqual(report.growOutside, [0, 255, 0]);

const hash = (digit, ext) => `assets/${digit.repeat(64)}.${ext}`;
const video = { id: 'm1', type: 'media', data: { kind: 'video', assetPath: hash('a', 'mp4'), title: '原片' } };
const image = { id: 'i1', type: 'media', data: { kind: 'image', assetPath: hash('b', 'png'), title: '静帧' } };
const plate = { id: 'p1', type: 'videoWhitePlate', data: { title: '绿幕白模', ...defaultPlateSettings() } };
const plateAsset = { id: 'asset1', type: 'media', data: { kind: 'video', assetPath: hash('d', 'mp4'), title: '绿幕白模成片', output: true } };
const ready = { id: 'ready', type: 'videoWhitePlate', data: { title: '绿幕白模', ...defaultPlateSettings(), plateResultAssetPath: plateAsset.data.assetPath, plateResultNodeId: plateAsset.id } };
const chroma = { id: 'k1', type: 'videoChromaKey', data: { title: '绿幕扣像合成' } };
const speed = { id: 's1', type: 'videoSpeed', data: { title: '慢放', speed: 0.5, rhythmAudio: 'preserve' } };
const swap = { id: 'g1', type: 'generator', data: { mode: 'swap', title: '角色替换' } };
const nodes = [video, image, plate, plateAsset, ready, chroma, speed, swap];
assert.equal(planCanvasConnection({ source: 'm1', target: 'p1', targetHandle: 'v1' }, nodes, []).connection.targetHandle, 'v1');
assert.match(planCanvasConnection({ source: 'i1', target: 'p1', targetHandle: 'v1' }, nodes, []).error, /视频/);
assert.equal(planCanvasConnection({ source: 'p1', target: 's1', targetHandle: 'v1' }, nodes, []).connection.source, 'p1');
assert.match(planCanvasConnection({ source: 'p1', target: 'g1', targetHandle: 'guide' }, nodes, []).error, /导出/);
const wired = planCanvasConnection({ source: 'ready', target: 'g1', targetHandle: 'guide' }, nodes, []);
assert.equal(wired.connection.source, 'asset1');
assert.equal(wired.connection.targetHandle, 'guide');
assert.equal(wired.resolvedFrom, 'ready');
assert.equal(planCanvasConnection({ source: 'asset1', target: 'g1', targetHandle: 'guide' }, nodes, []).connection.targetHandle, 'guide');
assert.match(planCanvasConnection({ source: 'k1', target: 'g1', targetHandle: 'guide' }, nodes, []).error, /SAM3/);
assert.match(planCanvasConnection({ source: 'asset1', target: 'p1', targetHandle: 'v1' }, nodes, [{ source: 'p1', target: 'asset1', targetHandle: 'preview' }]).error, /循环/);
assert.equal(NODE_PRESETS.video_white_plate[0], 'videoWhitePlate');
assert.deepEqual(NODE_PRESETS.video_white_plate[1].keepPrompts, ['person', 'pole']);
const fresh = videoPlateSummary({ ...defaultPlateSettings(), plateResultAssetPath: hash('e', 'mp4'), plateSubmittedSettings: JSON.stringify(plateDocumentFromNode(defaultPlateSettings())) });
assert.equal(fresh.plateStale, false);

{
  const tools = new Map();
  const edges = [];
  const latest = { current: { projectId: 'prj_fixture', readOnly: false, nodesRef: { current: [video, swap] }, edgesRef: { current: edges }, actions: {
    addNode: (type, extra) => { const id = `${type}-new`; latest.current.nodesRef.current.push({ id, type, position: { x: 0, y: 0 }, data: { status: 'idle', ...extra } }); return id; },
    updateNode: (id, patch) => { const node = latest.current.nodesRef.current.find((item) => item.id === id); node.data = { ...node.data, ...patch }; },
    onConnect: (connection) => { const plan = planCanvasConnection(connection, latest.current.nodesRef.current, edges); if (plan.error) return { error: plan.error }; const edge = { ...plan.connection, id: `edge-${edges.length}` }; edges.push(edge); return { edgeId: edge.id }; },
    generateNode: async (id) => { const node = latest.current.nodesRef.current.find((item) => item.id === id); node.data = { ...node.data, status: 'running', plateJobId: `vwp_${'3'.repeat(32)}` }; return { ok: true, jobId: node.data.plateJobId }; },
    persistProject: async () => {},
  } } };
  const dispose = registerCanvasMcp(latest, { context: { registerTool: (tool) => tools.set(tool.name, tool) }, startPage: () => () => {} });
  const call = async (name, args) => JSON.parse(await tools.get(name).execute(args));
  try {
    const created = await call('canvas_create_node', { preset: 'video_white_plate', title: '绿幕白模' });
    assert.equal(created.node.type, 'videoWhitePlate');
    assert.deepEqual(created.node.keepPrompts, ['person', 'pole']);
    assert.equal(created.node.maskGrow, 8);
    assert.equal(created.node.maskFeather, 2);
    assert.equal(created.node.shadeMode, 'flat');
    assert.equal(created.node.greenColor, '#00FF00');
    const id = created.node.id;
    const input = await call('canvas_connect_nodes', { sourceId: 'm1', targetId: id });
    assert.equal(input.edge.targetHandle, 'v1');
    const updated = await call('canvas_update_node', { nodeId: id, settings: { keepPrompts: 'person, 杆子', maskGrow: 0, shadeMode: 'shaded', greenColor: '#00ff00' } });
    assert.equal(updated.ok, true, updated.error);
    assert.deepEqual(updated.node.keepPrompts, ['person', '杆子']);
    assert.equal(updated.node.maskGrow, 0);
    assert.equal(updated.node.shadeMode, 'shaded');
    assert.equal(updated.node.greenColor, '#00FF00');
    const rejected = await call('canvas_update_node', { nodeId: id, settings: { shadeMode: 'clay' } });
    assert.equal(rejected.ok, false);
    const wrongNode = await call('canvas_update_node', { nodeId: 'm1', settings: { maskGrow: 1 } });
    assert.equal(wrongNode.ok, false);
    const generated = await call('canvas_generate_node', { nodeId: id });
    assert.equal(generated.jobId, `vwp_${'3'.repeat(32)}`);
    assert.equal(generated.node.plateJobId, generated.jobId);
    latest.current.nodesRef.current.push(plateAsset);
    latest.current.actions.updateNode(id, { status: 'done', plateResultAssetPath: plateAsset.data.assetPath, plateResultNodeId: plateAsset.id });
    const toSwap = await call('canvas_connect_nodes', { sourceId: id, targetId: 'g1' });
    assert.equal(toSwap.edge.source, plateAsset.id);
    assert.equal(toSwap.edge.targetHandle, 'guide');
  } finally { dispose(); }
}

{
  const calls = [];
  const jobId = `vwp_${'4'.repeat(32)}`;
  let polls = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET', options.body ? JSON.parse(options.body) : null]);
    const json = (status, value) => ({ ok: status < 400, status, json: async () => value });
    if (url === '/api/video-plate/jobs') return json(201, { id: jobId, status: 'queued', stage: '排队中', progress: 0 });
    if (url === `/api/video-plate/jobs/${jobId}`) return json(200, ++polls < 2 ? { id: jobId, status: 'running', stage: 'SAM3 正在跟踪人物和杆子', progress: 0.4 } : { id: jobId, status: 'completed', stage: '已导出', progress: 1, result: { frames: 8, width: 64, height: 100, fps: { num: 24, den: 1 }, greenColor: '#00FF00' } });
    if (url === `/api/video-plate/jobs/${jobId}/commit`) return json(201, { asset: { path: hash('e', 'mp4') }, revision: 4 });
    return json(404, { message: 'nope' });
  };
  const node = { id: 'p9', type: 'videoWhitePlate', data: { title: '绿幕白模', status: 'idle', ...defaultPlateSettings() } };
  const nodes = [video, node];
  const edges = [{ source: 'm1', target: 'p9', targetHandle: 'v1' }];
  const jobs = new Map();
  let placed = null;
  const runner = createVideoPlateRunner({
    getProjectId: () => 'prj_fixture', getNodes: () => nodes, getEdges: () => edges, jobs,
    updateNode: (id, patch) => { const item = nodes.find((entry) => entry.id === id); item.data = { ...item.data, ...patch }; },
    saveCanvasMedia: async (write, onSaved) => onSaved(await write(3)),
    saveProjectFile: async () => { throw new Error('已有项目素材，不应重新上传'); },
    persistProject: async () => {},
    placeResult: (id, assetPath) => { placed = { id, assetPath }; return 'video-plate-asset'; },
  });
  const started = await runner.run('p9');
  assert.equal(started.jobId, jobId);
  const submit = calls.find(([url]) => url === '/api/video-plate/jobs')[2];
  assert.equal(submit.video, video.data.assetPath);
  assert.deepEqual(submit.settings.keepPrompts, ['person', 'pole']);
  assert.equal(submit.settings.maskGrow, 8);
  assert.equal(submit.settings.maskFeather, 2);
  assert.equal(submit.settings.shadeMode, 'flat');
  assert.equal(submit.settings.greenColor, '#00FF00');
  for (let index = 0; index < 40 && node.data.status !== 'done'; index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(node.data.status, 'done');
  assert.equal(node.data.plateResultAssetPath, hash('e', 'mp4'));
  assert.equal(node.data.plateResultNodeId, 'video-plate-asset');
  assert.deepEqual(placed, { id: 'p9', assetPath: hash('e', 'mp4') });
}
console.log('VIDEO_PLATE_OK schema parity, exact green and white, SAM3 wiring, agent settings, runner');
