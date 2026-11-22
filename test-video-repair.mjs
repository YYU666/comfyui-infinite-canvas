import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { normalizeRepairDocument, repairSourceSignature, videoRepairSummary } from './src/video-repair-document.js';
import { planCanvasConnection } from './src/canvas-connections.js';
import { registerCanvasMcp } from './src/canvas-mcp.js';
import { createVideoRepairRunner } from './src/video-repair-runtime.js';
import { videoStreamAsset } from './src/video-stream.js';
const settings = { schemaVersion: 1, rect: { x: .4, y: .4, width: .2, height: .2 }, start: 0, end: 1 };
const cases = [settings, { ...settings, path: '../forbidden' }, { ...settings, start: -1 }, { ...settings, end: 0 }, { ...settings, rect: { x: .9, y: .9, width: .2, height: .2 } }];
const js = cases.map(value => { try { return normalizeRepairDocument(value); } catch { return { error: true }; } });
const python = process.env.H3_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['-X', 'utf8', '-c', `import json,sys
from video_repair_document import normalize_repair_document
out=[]
for value in json.load(sys.stdin):
 try: out.append(normalize_repair_document(value))
 except ValueError: out.append({'error':True})
print(json.dumps(out))`], { input: JSON.stringify(cases), encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr); assert.deepEqual(js, JSON.parse(result.stdout));
const source = { id: 'source', type: 'media', data: { kind: 'video', assetPath: `assets/${'a'.repeat(64)}.mp4` } };
const repair = { id: 'repair', type: 'videoLocalRepair', data: { repairSettings: settings } };
const edge = { source: 'source', target: 'repair', targetHandle: 'video' }, nodes = [source, repair], edges = [edge];
assert.equal(planCanvasConnection(edge, nodes, edges).error, undefined);
assert.ok(planCanvasConnection({ ...edge, targetHandle: 'bad' }, nodes, []).error);
const signature = repairSourceSignature('repair', nodes, edges);
Object.assign(repair.data, { repairResultAssetPath: `assets/${'b'.repeat(64)}.mp4`, repairResultSettings: JSON.stringify(settings), repairResultSource: signature });
assert.equal(videoRepairSummary(repair.data, { nodes, edges, nodeId: 'repair' }).repairResultCurrent, true);
assert.equal(videoStreamAsset(repair, {}, { nodes, edges }).assetPath, repair.data.repairResultAssetPath);
source.data.assetPath = `assets/${'c'.repeat(64)}.mp4`;
assert.ok(videoStreamAsset(repair, {}, { nodes, edges }).needsExport);
const tools = new Map(), latest = { current: { nodesRef: { current: nodes }, edgesRef: { current: edges }, actions: { updateNode: (_id, patch) => Object.assign(repair.data, patch), persistProject: async () => {} } } };
const dispose = registerCanvasMcp(latest, { context: { registerTool: tool => tools.set(tool.name, tool) }, startPage: () => () => {} });
try { const response = JSON.parse(await tools.get('canvas_update_node').execute({ nodeId: 'repair', settings: { repairSettings: settings, previewTime: .5 } })); assert.equal(response.ok, true, response.error); } finally { dispose(); }
// Late submit cancellation and readonly guards: no backend/global interrupt.
let release, sent = false; const cancelled = []; const fetchBefore = globalThis.fetch;
globalThis.fetch = async (url, options) => { if (url.endsWith('/jobs')) { sent = true; await new Promise(resolve => { release = resolve; }); return { ok: true, json: async () => ({ id: `vrp_${'d'.repeat(32)}` }) }; } if (url.endsWith('/cancel')) { cancelled.push(JSON.parse(options.body)); return { ok: true, json: async () => ({}) }; } throw new Error('Unexpected request'); };
const jobs = new Map(); let writable = true;
const runner = createVideoRepairRunner({ getProjectId: () => 'prj_test', getNodes: () => nodes, getEdges: () => edges, canWrite: () => writable, jobs, updateNode: (_id, patch) => Object.assign(repair.data, patch) });
const pending = runner.run('repair'); while (!sent) await new Promise(resolve => setTimeout(resolve, 1)); await runner.cancel('repair'); release();
assert.equal((await pending).ok, false); assert.deepEqual(cancelled, [{ projectId: 'prj_test' }]); assert.equal(jobs.size, 0);
writable = false; assert.equal((await runner.run('repair')).ok, false); assert.equal((await runner.preview('repair')).ok, false); assert.equal(runner.resume('repair'), false); globalThis.fetch = fetchBefore;
console.log('VIDEO_REPAIR_OK schema parity graph stale-source blocking MCP settings late-cancel readonly');

const { verifyVideoImportGuard } = await import('./test-video-import-guard.mjs');
await verifyVideoImportGuard(createVideoRepairRunner, 'videoLocalRepair', {repairSettings:settings}, 'video');
