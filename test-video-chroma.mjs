import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { planCanvasConnection } from './src/canvas-connections.js';
import { NODE_PRESETS, registerCanvasMcp } from './src/canvas-mcp.js';
import { createVideoChromaRunner } from './src/video-chroma-runtime.js';
import {
  defaultChromaSettings,
  normalizeChromaDocument,
  planPlacement,
} from './src/video-chroma-document.js';

const documents = [
  {},
  { keyColor: '#00ff00', similarity: 0.2, blend: 0.08, despill: 0.5, audio: 'mute' },
  { keyColor: '#0000FF', scale: 2, anchor: 'bottom', offsetX: 10, offsetY: -4, outputSize: 'foreground', backgroundFit: 'contain', choke: 2, feather: 1, startOffset: 0.5 },
  { secondKey: true, secondKeyColor: '#ffffff', secondSimilarity: 0.1, secondBlend: 0.04 },
  { secondKey: 'yes' },
  { keyColor: '#00FF00;rm' },
  { keyColor: '#00FF00', filter: 'chromakey=color=red' },
  { similarity: 2 },
  { anchor: 'expression' },
  { choke: 9 },
  { scale: 0.01 },
  { outputSize: '../x' },
  { startOffset: -1 },
  { schemaVersion: 2 },
  { path: 'C:/secret.mp4' },
];
const plans = [
  { document: {}, fg: [480, 832], bg: [720, 1280] },
  { document: {}, fg: [480, 832], bg: [721, 1281] },
  { document: { outputSize: 'foreground' }, fg: [481, 833], bg: [720, 1280] },
  { document: { scale: 2 }, fg: [480, 832], bg: [720, 1280] },
  { document: { anchor: 'bottom', offsetX: 10, offsetY: -4 }, fg: [480, 832], bg: [720, 1280] },
];
const jsDocuments = documents.map((value) => {
  try { return normalizeChromaDocument(value); }
  catch { return { error: true }; }
});
const jsPlans = plans.map((value) => {
  try { return planPlacement(normalizeChromaDocument(value.document), ...value.fg, ...value.bg); }
  catch { return { error: true }; }
});
const python = process.env.H3_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const script = `import json,sys
sys.path.insert(0, ".")
from video_chroma_document import ChromaDocumentError, normalize_chroma_document, plan_placement
payload = json.load(sys.stdin)
out = {"documents": [], "plans": []}
for item in payload["documents"]:
    try: out["documents"].append(normalize_chroma_document(item))
    except ChromaDocumentError: out["documents"].append({"error": True})
for item in payload["plans"]:
    try:
        out["plans"].append(plan_placement(normalize_chroma_document(item["document"]), *item["fg"], *item["bg"]))
    except ChromaDocumentError:
        out["plans"].append({"error": True})
print(json.dumps(out))`;
const run = spawnSync(python, ['-c', script], { input: JSON.stringify({ documents, plans }), encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr);
const parsed = JSON.parse(run.stdout);
assert.deepEqual(jsDocuments, parsed.documents, 'JS 与 Python 绿幕 schema 不一致');
assert.deepEqual(jsPlans, parsed.plans, 'JS 与 Python 绿幕落点不一致');
assert.deepEqual(planPlacement(normalizeChromaDocument({}), 480, 832, 720, 1280), {
  outputWidth: 720, outputHeight: 1280, foregroundWidth: 480, foregroundHeight: 832, overlayX: 120, overlayY: 224,
});

const hash = (digit, ext) => `assets/${digit.repeat(64)}.${ext}`;
const video = { id: 'm1', type: 'media', data: { kind: 'video', assetPath: hash('a', 'mp4'), title: '绿幕人物' } };
const image = { id: 'i1', type: 'media', data: { kind: 'image', assetPath: hash('b', 'png'), title: '夜景' } };
const otherVideo = { id: 'm2', type: 'media', data: { kind: 'video', assetPath: hash('c', 'mp4'), title: '背景视频' } };
const chroma = { id: 'k1', type: 'videoChromaKey', data: { title: '绿幕扣像合成', ...defaultChromaSettings() } };
const speed = { id: 's1', type: 'videoSpeed', data: { title: '慢放', speed: 0.5, rhythmAudio: 'preserve' } };
const edit = { id: 'e1', type: 'videoEdit', data: { title: '剪辑' } };
const generator = { id: 'g1', type: 'generator', data: { mode: 'swap', title: '角色替换' } };
const nodes = [video, image, otherVideo, chroma, speed, edit, generator];
assert.equal(planCanvasConnection({ source: 'm1', target: 'k1', targetHandle: 'fg' }, nodes, []).connection.targetHandle, 'fg');
assert.equal(planCanvasConnection({ source: 'i1', target: 'k1', targetHandle: 'bg' }, nodes, []).connection.targetHandle, 'bg');
assert.equal(planCanvasConnection({ source: 's1', target: 'k1', targetHandle: 'fg' }, nodes, []).connection.targetHandle, 'fg');
assert.equal(planCanvasConnection({ source: 'k1', target: 's1', targetHandle: 'v1' }, nodes, []).connection.targetHandle, 'v1');
assert.equal(planCanvasConnection({ source: 'k1', target: 'e1', targetHandle: 'v1' }, nodes, []).connection.targetHandle, 'v1');
assert.equal(planCanvasConnection({ source: 'e1', target: 'k1', targetHandle: 'bg' }, nodes, []).connection.targetHandle, 'bg');
assert.match(planCanvasConnection({ source: 'i1', target: 'k1', targetHandle: 'fg' }, nodes, []).error, /前景/);
assert.match(planCanvasConnection({ source: 'k1', target: 'g1', targetHandle: 'guide' }, nodes, []).error, /SAM3/);
assert.match(planCanvasConnection({ source: 'k1', target: 's1', targetHandle: 'v1' }, nodes, [{ source: 's1', target: 'k1', targetHandle: 'fg' }]).error, /循环/);
assert.equal(NODE_PRESETS.video_chroma_key[0], 'videoChromaKey');

{
  const tools = new Map();
  const edges = [];
  const latest = { current: { projectId: 'prj_fixture', readOnly: false, nodesRef: { current: [video, image, otherVideo] }, edgesRef: { current: edges }, actions: {
    addNode: (type, extra) => { const id = `${type}-new`; latest.current.nodesRef.current.push({ id, type, position: { x: 0, y: 0 }, data: { status: 'idle', ...extra } }); return id; },
    updateNode: (id, patch) => { const node = latest.current.nodesRef.current.find((item) => item.id === id); node.data = { ...node.data, ...patch }; },
    onConnect: (connection) => { const plan = planCanvasConnection(connection, latest.current.nodesRef.current, edges); if (plan.error) return { error: plan.error }; const edge = { ...plan.connection, id: `edge-${edges.length}` }; edges.push(edge); return { edgeId: edge.id }; },
    generateNode: async (id) => { const node = latest.current.nodesRef.current.find((item) => item.id === id); node.data = { ...node.data, status: 'running', chromaJobId: `vck_${'3'.repeat(32)}` }; return { ok: true, jobId: node.data.chromaJobId }; },
    persistProject: async () => {},
  } } };
  const dispose = registerCanvasMcp(latest, { context: { registerTool: (tool) => tools.set(tool.name, tool) }, startPage: () => () => {} });
  const call = async (name, args) => JSON.parse(await tools.get(name).execute(args));
  try {
    const created = await call('canvas_create_node', { preset: 'video_chroma_key', title: '绿幕扣像合成' });
    assert.equal(created.node.type, 'videoChromaKey');
    assert.equal(created.node.keyColor, '#00FF00');
    assert.equal(created.node.similarity, 0.2);
    const id = created.node.id;
    const foreground = await call('canvas_connect_nodes', { sourceId: 'm1', targetId: id });
    assert.equal(foreground.edge.targetHandle, 'fg');
    const background = await call('canvas_connect_nodes', { sourceId: 'i1', targetId: id });
    assert.equal(background.edge.targetHandle, 'bg');
    const secondVideo = await call('canvas_connect_nodes', { sourceId: 'm2', targetId: id, targetHandle: 'bg' });
    assert.equal(secondVideo.edge.targetHandle, 'bg');
    const updated = await call('canvas_update_node', { nodeId: id, settings: { keyColor: '#00ff00', similarity: 0.3, chromaAudio: 'mute', previewTime: 1.5 } });
    assert.equal(updated.ok, true, updated.error);
    assert.equal(updated.node.keyColor, '#00FF00');
    assert.equal(updated.node.similarity, 0.3);
    assert.equal(updated.node.chromaAudio, 'mute');
    assert.equal(updated.node.previewTime, 1.5);
    const second = await call('canvas_update_node', { nodeId: id, settings: { secondKey: true, secondKeyColor: '#ffffff', secondSimilarity: 0.1, secondBlend: 0.04 } });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.node.secondKey, true);
    assert.equal(second.node.secondKeyColor, '#FFFFFF');
    assert.equal(second.node.secondSimilarity, 0.1);
    assert.equal(second.node.secondBlend, 0.04);
    const rejectedFlag = await call('canvas_update_node', { nodeId: id, settings: { secondKey: 'yes' } });
    assert.equal(rejectedFlag.ok, false);
    const bad = await call('canvas_update_node', { nodeId: id, settings: { keyColor: '#00FF00;rm' } });
    assert.equal(bad.ok, false);
    const wrongNode = await call('canvas_update_node', { nodeId: 'm1', settings: { similarity: 0.3 } });
    assert.equal(wrongNode.ok, false);
    const generated = await call('canvas_generate_node', { nodeId: id });
    assert.equal(generated.jobId, `vck_${'3'.repeat(32)}`);
    assert.equal(generated.node.chromaJobId, generated.jobId);
  } finally { dispose(); }
}

{
  const calls = [];
  const jobId = `vck_${'4'.repeat(32)}`;
  let polls = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET', options.body ? JSON.parse(options.body) : null]);
    const json = (status, value) => ({ ok: status < 400, status, json: async () => value });
    if (url === '/api/video-chroma/jobs') return json(201, { id: jobId, status: 'queued', stage: '排队中', progress: 0 });
    if (url === `/api/video-chroma/jobs/${jobId}`) return json(200, ++polls < 2 ? { id: jobId, status: 'running', stage: '正在抠像合成', progress: 0.4 } : { id: jobId, status: 'completed', stage: '已导出', progress: 1, result: { frames: 12, width: 720, height: 1280, audio: 'preserve' } });
    if (url === `/api/video-chroma/jobs/${jobId}/commit`) return json(201, { asset: { path: hash('e', 'mp4') }, revision: 4 });
    if (url === '/api/video-chroma/preview') return json(200, { width: 720, height: 1280, frame: 0, time: 0, mode: 'composite', pngBase64: 'iVBORw0KGgo=' });
    return json(404, { message: 'nope' });
  };
  const node = { id: 'k9', type: 'videoChromaKey', data: { title: '绿幕扣像合成', status: 'idle', ...defaultChromaSettings() } };
  const nodes = [video, image, node];
  const edges = [
    { source: 'm1', target: 'k9', targetHandle: 'fg' },
    { source: 'i1', target: 'k9', targetHandle: 'bg' },
  ];
  const jobs = new Map();
  const runner = createVideoChromaRunner({
    getProjectId: () => 'prj_fixture', getNodes: () => nodes, getEdges: () => edges, jobs,
    updateNode: (id, patch) => { const item = nodes.find((entry) => entry.id === id); item.data = { ...item.data, ...patch }; },
    saveCanvasMedia: async (write, onSaved) => onSaved(await write(3)),
    saveProjectFile: async () => { throw new Error('已有项目素材，不应重新上传'); },
    persistProject: async () => {},
  });
  const started = await runner.run('k9');
  assert.equal(started.jobId, jobId);
  const submit = calls.find(([url]) => url === '/api/video-chroma/jobs')[2];
  assert.equal(submit.foreground, video.data.assetPath);
  assert.equal(submit.background, image.data.assetPath);
    assert.equal(submit.settings.keyColor, '#00FF00');
    assert.equal(submit.settings.similarity, 0.2);
    assert.equal(submit.settings.audio, 'preserve');
    assert.equal(submit.settings.secondKey, false);
    assert.equal(submit.settings.secondKeyColor, '#FFFFFF');
    assert.equal(submit.settings.secondSimilarity, 0.06);
  assert.equal(submit.settings.outputSize, 'background');
  for (let index = 0; index < 40 && node.data.status !== 'done'; index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(node.data.chromaResultAssetPath, hash('e', 'mp4'));
  assert.equal(node.data.status, 'done');
  const preview = await runner.preview('k9', { mode: 'composite', time: 0 });
  assert.equal(preview.ok, true);
  assert.equal(preview.frame, 0);
  assert.equal(preview.pngBase64, 'iVBORw0KGgo=');
}
console.log('VIDEO_CHROMA_OK schema parity, portrait placement, connections, agent settings, runner');
