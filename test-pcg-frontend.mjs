import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PCG_REGISTRY, PCG_PRESETS, pcgNodeData, pcgPreview, validatePcgSchema } from './src/pcg-registry.js';
import { planCanvasConnection } from './src/canvas-connections.js';
import { createPcgRuntime, pcgTaskHandle, pcgRequest } from './src/pcg-runtime.js';
import { registerCanvasMcp, generateNodeForMcp, waitForNodeForMcp } from './src/canvas-mcp.js';

const node = (id = 'pcg-1', descriptorId = 'refmuse.pcg.diagnostic') => ({ id, type: 'pcg', position: { x: 0, y: 0 }, data: pcgNodeData(descriptorId) });
const identity = { projectId: 'prj_test', nodeId: 'pcg-1', revision: 2, descriptorVersion: 1, operationVersion: 1, runId: 'run-1' };
const task = (args = identity, overrides = {}) => ({ ...args, jobId: `pcg_${'1'.repeat(32)}`, inputHash: 'a'.repeat(64), descriptorId: 'refmuse.pcg.diagnostic', status: 'running', progress: 0, result: null, error: null, resultHash: null, ...overrides });
const done = args => task(args, { status: 'succeeded', progress: 1, resultHash: 'b'.repeat(64), result: { report: { contractVersion: 1, type: 'DiagnosticReport', operation: 'refmuse.pcg.diagnostic', workerPid: 123, inputHash: 'a'.repeat(64) } } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Shared registry, exact typed ports, closed parameters and no guessed geometry.
assert.equal(Object.keys(PCG_PRESETS).length, 25);
assert.ok(PCG_PRESETS.pcg_diagnostic && PCG_PRESETS.pcg_geometry_stub && PCG_PRESETS.pcg_rock);
assert.equal(PCG_REGISTRY.nodes.filter(item => item.category === 'operator').length, 18);
assert.equal(PCG_REGISTRY.nodes.filter(item => item.category === 'task').length, 5);
assert.equal(pcgNodeData('refmuse.pcg.rock').parameters.seed, 0);
assert.match(pcgPreview(pcgNodeData('refmuse.pcg.game_asset')).message, /M3_BRIDGE_UNAVAILABLE/);
const rock = node('rock', 'refmuse.pcg.rock'), move = node('move', 'refmuse.pcg.transform');
assert.equal(planCanvasConnection({ source: 'rock', target: 'move', sourceHandle: 'geometry', targetHandle: 'geometry' }, [rock, move], []).edgeData.pcgType, 'Geometry');
assert.throws(() => pcgNodeData('refmuse.pcg.rock', { roughness: 99 }), /outside declared range/);
assert.equal(pcgNodeData('refmuse.pcg.diagnostic').parameters.label, 'Contract check');
assert.throws(() => pcgNodeData('refmuse.pcg.diagnostic', { code: 'run()' }), /unsupported field/);
assert.throws(() => pcgNodeData('refmuse.pcg.diagnostic', { label: 'x'.repeat(81) }), /invalid string/);
assert.equal(pcgNodeData('refmuse.pcg.diagnostic', { label: '😀'.repeat(80) }).parameters.label.length, 160);
assert.throws(() => pcgNodeData('refmuse.pcg.geometry_stub', { label: 'wrong' }), /unsupported field/);
assert.throws(() => pcgNodeData('refmuse.pcg.diagnostic', {}, { descriptorVersion: 2 }), /Unsupported/);
const stub = node('stub', 'refmuse.pcg.geometry_stub'), check = node();
const connection = { source: 'stub', target: check.id, sourceHandle: 'geometry', targetHandle: 'geometry' };
const plan = planCanvasConnection(connection, [stub, check], []);
assert.deepEqual(plan.edgeData, { pcgType: 'GeometryArtifact' });
assert.deepEqual(plan.connection, connection);
assert.ok(planCanvasConnection({ ...connection, sourceHandle: 'report' }, [stub, check], []).error);
assert.ok(planCanvasConnection({ source: check.id, target: stub.id, sourceHandle: 'report', targetHandle: 'geometry' }, [stub, check], []).error);
assert.ok(planCanvasConnection(connection, [stub, check], [{ source: check.id, target: stub.id }]).error);
assert.ok(planCanvasConnection(connection, [stub, check], [], { readOnly: true }).error);
assert.ok(planCanvasConnection(connection, [{ ...stub, type: 'media' }, check], []).error);
assert.match(pcgPreview(stub.data).message, /EXECUTOR_UNAVAILABLE/);
assert.equal(pcgPreview(stub.data).report, null);
assert.equal(pcgPreview(check.data, done(identity)).report.workerPid, 123);
assert.equal(pcgPreview(check.data, { ...done(identity), stale: true }).stale, true);

function runtimeFixture(request) {
  const context = { projectId: identity.projectId, revision: identity.revision, readOnly: false, switching: false };
  const nodes = [node(), node('stub', 'refmuse.pcg.geometry_stub')];
  let writes = 0, changes = 0;
  const runtime = createPcgRuntime({ getContext: () => context, getNode: id => nodes.find(item => item.id === id), persistProject: async () => { writes++; }, onChange: () => { changes++; }, request });
  return { runtime, context, nodes, get writes() { return writes; }, get changes() { return changes; } };
}

// Dedicated process errors preserve failed tasks; geometry never fabricates a mesh.
{
  const failed = task({ ...identity, nodeId: 'stub' }, { descriptorId: 'refmuse.pcg.geometry_stub', status: 'failed', error: { code: 'EXECUTOR_UNAVAILABLE', message: 'No geometry executor' } });
  const fixture = runtimeFixture(async () => { throw Object.assign(new Error('No geometry executor'), { code: 'EXECUTOR_UNAVAILABLE', task: failed }); });
  await assert.rejects(fixture.runtime.invoke('run', { ...identity, nodeId: 'stub' }), /No geometry executor/);
  assert.equal(fixture.runtime.getState('stub').task.status, 'failed');
  assert.equal(fixture.runtime.getState('stub').task.result, null);
  assert.equal(fixture.nodes[1].data.status, undefined, 'runtime task never mutates saved node data');
}

// Reverse delivery cannot replace a newer submitted task, including dedicated invoke.
{
  const older = deferred(), newer = deferred();
  const fixture = runtimeFixture(async (_path, args) => args.runId === 'older' ? older.promise : newer.promise);
  const oldArgs = { ...identity, runId: 'older' }, newArgs = { ...identity, runId: 'newer' };
  const first = fixture.runtime.invoke('run', oldArgs), second = fixture.runtime.invoke('run', newArgs);
  newer.resolve({ task: done(newArgs) }); await second;
  older.resolve({ task: done(oldArgs) }); await first;
  assert.equal(fixture.runtime.getState('pcg-1').task.runId, 'newer');
}

// Equal node IDs in cloned projects cannot leak reports, status, or busy guards.
{
  const pending = deferred();
  const fixture = runtimeFixture(async (_path, args) => args.projectId === 'prj_test' ? pending.promise : { task: done(args) });
  const first = fixture.runtime.runNode('pcg-1', { runId: 'old-project' }); await tick();
  const firstOutcome = assert.rejects(first, /current project ID/);
  fixture.context.projectId = 'prj_clone';
  assert.equal(fixture.runtime.getState('pcg-1').task, null);
  const second = await fixture.runtime.runNode('pcg-1', { runId: 'clone-project' });
  pending.resolve({ task: done({ ...identity, runId: 'old-project' }) }); await firstOutcome;
  assert.equal(second.task.projectId, 'prj_clone');
  assert.equal(fixture.runtime.getState('pcg-1').task.runId, 'clone-project');
}

// Reload discovery filters foreign identities and marks old revisions as stale.
{
  const original = done(identity), wrong = done({ ...identity, projectId: 'prj_other' });
  const fixture = runtimeFixture(async (path, args) => path.startsWith('/tasks?') ? { tasks: [wrong, original] } : { task: { ...original, stale: true } });
  fixture.context.revision = 3;
  await fixture.runtime.listTasks({ projectId: identity.projectId, nodeId: 'pcg-1' });
  assert.equal(fixture.runtime.getState('pcg-1').task.projectId, identity.projectId);
  assert.equal(fixture.runtime.getState('pcg-1').task.stale, true);
  await fixture.runtime.invoke('read', pcgTaskHandle(original));
  await assert.rejects(fixture.runtime.invoke('run', identity), /Graph revision changed/);
  fixture.context.readOnly = true;
  await assert.rejects(fixture.runtime.invoke('read', pcgTaskHandle(original)), /not writable/);
}

// A late history restore cannot overwrite an explicit newer run.
{
  const restore = deferred();
  const fixture = runtimeFixture(async (path, args) => path.startsWith('/tasks?') ? restore.promise : { task: done(args) });
  const history = fixture.runtime.listTasks({ projectId: identity.projectId, nodeId: 'pcg-1' });
  await fixture.runtime.invoke('run', { ...identity, runId: 'new' });
  restore.resolve({ tasks: [done(identity)] }); await history;
  assert.equal(fixture.runtime.getState('pcg-1').task.runId, 'new');
}

// Bounded HTTP transport preserves structured failures; all calls are mocks.
{
  let seen;
  const response = await pcgRequest('/read', identity, { fetchImpl: async (url, options) => { seen = { url, options }; return { ok: true, json: async () => ({ task: done(identity) }) }; } });
  assert.equal(seen.url, '/api/pcg/read'); assert.equal(seen.options.method, 'POST');
  assert.equal(response.task.status, 'succeeded');
  await assert.rejects(pcgRequest('/run', identity, { fetchImpl: async () => ({ ok: false, json: async () => ({ code: 'EXECUTOR_UNAVAILABLE', message: 'missing', task: task(identity, { status: 'failed' }) }) }) }), error => error.code === 'EXECUTOR_UNAVAILABLE' && error.task.status === 'failed');
}

// Register the actual page tools with mock native actions and a mock backend.
{
  const nodes = [], edges = [], registered = new Map();
  let revision = 0, dirty = false, requests = 0, saves = 0;
  const context = () => ({ projectId: 'prj_tools', revision, readOnly: latest.current.readOnly, switching: false });
  const actions = {
    getPcgContext: context,
    addNode(type, data, position) { const next = { id: `pcg-${nodes.length + 1}`, type, data, position: position || { x: 0, y: 0 } }; nodes.push(next); dirty = true; return next.id; },
    updateNode(id, patch) { Object.assign(nodes.find(item => item.id === id).data, patch); dirty = true; },
    async persistProject() { saves++; if (dirty) { revision++; dirty = false; } },
    onConnect(connection) { const plan = planCanvasConnection(connection, nodes, edges); if (plan.error) return plan; const edge = { ...plan.connection, id: `edge-${edges.length + 1}`, data: plan.edgeData }; edges.push(edge); dirty = true; return { edgeId: edge.id }; },
  };
  const latest = { current: { projectId: 'prj_tools', projectName: 'Test', nodesRef: { current: nodes }, edgesRef: { current: edges }, actions, readOnly: false } };
  const runtime = createPcgRuntime({ getContext: context, getNode: id => nodes.find(item => item.id === id), persistProject: actions.persistProject, request: async (path, args) => {
    requests++;
    if (path === '/preflight') return { identity: args, inputHash: 'a'.repeat(64), readiness: { state: 'ready' } };
    if (path === '/verify') return { verified: true, jobId: args.jobId, inputHash: args.inputHash, resultHash: 'b'.repeat(64) };
    if (path.startsWith('/tasks?')) return { tasks: [] };
    if (path === '/run') return { task: task(args) };
    return { task: done(pcgTaskHandle(args)) };
  } });
  actions.pcg = runtime; actions.getPcgState = id => runtime.getState(id);
  const stop = registerCanvasMcp(latest, { context: { registerTool(tool) { registered.set(tool.name, tool); } }, startPage: () => () => {} });
  const call = async (name, args = {}) => JSON.parse(await registered.get(name).execute(args));
  const catalog = await call('canvas_pcg_describe');
  assert.deepEqual(catalog.registry, PCG_REGISTRY);
  assert.equal(catalog.tools.length, 12);
  for (const tool of catalog.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const example of tool.examples) validatePcgSchema(example.arguments, tool.inputSchema);
  }
  assert.equal((await call('canvas_pcg_describe', { extra: true })).code, 'INVALID_CONTRACT');
  assert.equal((await call('canvas_pcg_create_node', { projectId: 'prj_wrong', descriptorId: 'refmuse.pcg.diagnostic', descriptorVersion: 1, operationVersion: 1 })).code, 'PROJECT_MISMATCH');
  const created = await call('canvas_pcg_create_node', { projectId: 'prj_tools', descriptorId: 'refmuse.pcg.diagnostic', descriptorVersion: 1, operationVersion: 1 });
  assert.equal(created.node.type, 'pcg'); assert.equal(created.revision, 1);
  const parameters = { label: 'Strict tool check' };
  const updated = await call('canvas_pcg_set_parameters', { projectId: 'prj_tools', nodeId: created.node.id, descriptorVersion: 1, operationVersion: 1, parameters });
  assert.equal(updated.revision, 2); assert.deepEqual(updated.node.parameters, parameters);
  const args = { projectId: 'prj_tools', nodeId: created.node.id, revision: updated.revision, descriptorVersion: 1, operationVersion: 1, runId: 'tools-run' };
  assert.equal((await call('canvas_pcg_preflight', args)).ok, true);
  const started = await call('canvas_pcg_run', args), fullHandle = pcgTaskHandle(started.task);
  assert.equal(started.ok, true);
  const before = requests;
  assert.equal((await call('canvas_pcg_wait', { ...fullHandle, timeoutMs: 20001 })).ok, false);
  assert.equal((await call('canvas_pcg_read', { ...fullHandle, inputHash: 'wrong' })).ok, false);
  assert.equal(requests, before, 'strict tool args reject before calling backend');
  assert.equal((await call('canvas_pcg_wait', { ...fullHandle, timeoutMs: 100 })).pending, false);
  assert.equal((await call('canvas_pcg_read', fullHandle)).task.result.report.workerPid, 123);
  assert.equal((await call('canvas_pcg_verify', fullHandle)).verified, true);
  assert.equal((await call('canvas_pcg_cancel', fullHandle)).ok, true);
  assert.equal((await call('canvas_pcg_export', { ...fullHandle, format: 'glb' })).ok, true);
  assert.equal((await call('canvas_pcg_export', { ...fullHandle, format: 'exe' })).ok, false);
  const state = await call('canvas_get_state', { nodeId: created.node.id });
  assert.equal(state.projectId, 'prj_tools'); assert.equal(state.revision, 2);
  assert.equal(state.nodes[0].task.jobId, started.task.jobId);
  assert.equal(nodes[0].data.pcgTask, undefined);
  await call('canvas_update_node', { nodeId: created.node.id, settings: { parameters: { label: 'Generic alias' } } });
  assert.equal(nodes[0].data.parameters.label, 'Generic alias');
  assert.equal((await call('canvas_update_node', { nodeId: created.node.id, settings: { parameters: { script: 'no' } } })).ok, false);
  const geometric = await call('canvas_create_node', { preset: 'pcg_geometry_stub' });
  const connected = await call('canvas_connect_nodes', { sourceId: geometric.node.id, targetId: created.node.id, sourceHandle: 'geometry', targetHandle: 'geometry' });
  assert.equal(connected.ok, true); assert.equal(edges[0].data.pcgType, 'GeometryArtifact');
  assert.equal((await call('canvas_connect_nodes', { sourceId: geometric.node.id, targetId: created.node.id, targetHandle: 'geometry' })).ok, false);
  latest.current.readOnly = true;
  assert.equal((await call('canvas_pcg_run', args)).ok, false);
  assert.equal((await call('canvas_pcg_read', fullHandle)).code, 'READ_ONLY');
  assert.equal((await call('canvas_pcg_describe')).ok, true);
  assert.ok(saves > 0);
  stop();
}

// Generic generation/wait aliases use the PCG runtime, never another service.
{
  let submitted = 0, waited;
  const latest = { current: { nodesRef: { current: [node()] }, actions: { pcg: { runNode: async (_id, options) => { submitted++; return { task: done(identity), options }; }, invoke: async (_action, args) => { waited = args; return { task: done(identity) }; } }, getPcgState: () => ({ task: task() }) } } };
  const result = await generateNodeForMcp(latest, { nodeId: 'pcg-1', wait: false });
  assert.equal(result.task.status, 'succeeded'); assert.equal(submitted, 1);
  assert.equal((await waitForNodeForMcp(latest, { nodeId: 'pcg-1', timeoutMs: 300000 })).pending, false);
  assert.equal(waited.timeoutMs, 20000);
}

// Isolated component/source checks: no viewport controls or fake mesh/URL output.
const previewSource = await readFile(new URL('./src/PcgNode.jsx', import.meta.url), 'utf8');
assert.ok(!/<(?:button|input|canvas|video)\b/.test(previewSource));
assert.ok(previewSource.includes('pcgPreview(data, state.task, state.error)'));
assert.ok(previewSource.includes('过期任务，仅供查看'));
const hostSource = await readFile(new URL('./src/CanvasWorkbench.jsx', import.meta.url), 'utf8');
assert.ok(hostSource.includes('3D与游戏资产 / 程序化建模〔PCG插件〕'));
assert.ok(hostSource.includes('PCG插件 / M2'));
assert.ok(hostSource.includes("filter(descriptor => descriptor.category === 'task')"));
console.log('PCG_FRONTEND_OK sharedSchema=true strictTools=true typedEdges=true retainedFailure=true reload=true stale=true projectIsolation=true reverseDelivery=true previewReadOnly=true');
