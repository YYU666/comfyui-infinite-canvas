import viewportTools from '../pcg/viewport-tools.json' with { type: 'json' };
import { PCG_REGISTRY, pcgNodeData, pcgNodeDescriptor, validatePcgSchema, pcgError } from './pcg-registry.js';
import { pcgAgentState } from './pcg-runtime.js';

const object = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const token = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
const projectId = { type: 'string', pattern: '^prj_[A-Za-z0-9_-]+$', maxLength: 128 };
const versions = { descriptorVersion: { type: 'integer', enum: [PCG_REGISTRY.descriptorVersion] }, operationVersion: { type: 'integer', enum: [...new Set(PCG_REGISTRY.nodes.map(node => node.operationVersion))] } };
const identity = { projectId, nodeId: token, revision: { type: 'integer', minimum: 1 }, ...versions, runId: token };
const handle = { ...identity, jobId: token, inputHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } };
const exampleIdentity = { projectId: 'prj_example', nodeId: 'pcg-1', revision: 2, descriptorVersion: 1, operationVersion: 1, runId: 'run-001' };
const exampleHandle = { ...exampleIdentity, jobId: `pcg_${'0'.repeat(32)}`, inputHash: '0'.repeat(64) };
const recovery = {
  INVALID_CONTRACT: 'Read canvas_pcg_describe and retry with the declared schema and exact ports.',
  VERSION_UNSUPPORTED: 'Read the descriptor and create a node with supported explicit versions.',
  EXECUTOR_UNAVAILABLE: 'The legacy placeholder cannot execute. Discover the M2 task and atomic descriptors.',
  M3_BRIDGE_UNAVAILABLE: 'The game asset bridge awaits M3 approval. Keep the readable node; do not invent an output.',
  ISOLATION_UNAVAILABLE: 'Use a supported local restricted runtime. Keep the graph readable; never fall back to an unrestricted process.',
  BUDGET_EXCEEDED: 'Reduce subdivision, scatter count or graph size, then preflight with a new runId.',
  INSUFFICIENT_PLACEMENT: 'Reduce count or spacing, or relax slope/height constraints explicitly.',
  FIELD_BINDING_MISMATCH: 'Recompute the field from the current source geometry; do not reuse a field after content/topology changes.',
  FIELD_DOMAIN_MISMATCH: 'Read the declared domain. Position offsets require Point vector3; normals and UV samples use Corner.',
  CANCELLED: 'The retained task was cancelled. Use a new runId for an explicit rerun.',
  REVISION_CONFLICT: 'Read canvas_get_state for the saved revision, then preflight/run with a new runId.',
  INPUT_UNAVAILABLE: 'Read the upstream task. Disconnect unavailable inputs before running a diagnostic.',
  IDEMPOTENCY_CONFLICT: 'Use a new runId for a changed node, version, revision or input.',
  STALE_RESULT: 'Read the current graph, then start and verify a new run.',
  READ_ONLY: 'Use the current writable project page.',
  WORKER_TIMEOUT: 'Inspect the retained task error and explicitly run again with a new runId.',
  WORKER_CRASH: 'Inspect the retained task error and explicitly run again with a new runId.',
};

export function createPcgTools(latest, { summarize = node => node, waitForNode = async id => latest.current.nodesRef.current.find(node => node.id === id), connectionTool } = {}) {
  const tools = [];
  const current = args => {
    const context = latest.current.actions.getPcgContext();
    if (args.projectId !== context.projectId) throw pcgError('PROJECT_MISMATCH', 'Use the current project ID from canvas_get_state.');
    if (context.readOnly || context.switching) throw pcgError('READ_ONLY', 'The current project is not writable.');
    return context;
  };
  const getNode = id => latest.current.nodesRef.current.find(node => node.id === id);
  const define = (name, description, inputSchema, example, execute, readOnly = false) => {
    const tool = { name, description: `${description} Example: ${JSON.stringify(example)}. Errors and recovery: canvas_pcg_describe.`, inputSchema,
      annotations: { readOnlyHint: readOnly, untrustedContentHint: true },
      examples: [{ arguments: example }],
      execute: async (args = {}) => {
        try { validatePcgSchema(args, inputSchema); return JSON.stringify({ ok: true, ...await execute(args) }); }
        catch (error) { return JSON.stringify({ ok: false, code: error.code || 'INVALID_CONTRACT', error: error.message, recovery: recovery[error.code] || 'Read the current project, descriptor and retained task before retrying.', ...(error.details ? { details: error.details } : {}), ...(error.task ? { task: error.task } : {}) }); }
      } };
    tools.push(tool);
  };
  define('canvas_pcg_describe', 'Discover shared PCG NodeDescriptor v1, five task entries and eighteen atomic operations, exact ports, budgets, readiness, tool schemas, examples and recovery. M2 executes geometry in a restricted local worker; game_asset awaits M3.', object(), {}, async () => ({
    registry: PCG_REGISTRY, tools: [...tools, ...(connectionTool ? [{ ...connectionTool, examples: [{ arguments: { sourceId: 'pcg-stub', targetId: 'pcg-1', sourceHandle: 'geometry', targetHandle: 'geometry' } }] }] : [])].map(({ name, description, inputSchema, examples }) => ({ name, description, inputSchema, examples })), errors: recovery,
  }), true);
  define('canvas_pcg_create_node', 'Create and save a visible PCG node through the current page. Returns its actual saved revision for preflight/run.', object({ projectId, descriptorId: { type: 'string', enum: PCG_REGISTRY.nodes.map(node => node.id) }, ...versions, x: { type: 'number' }, y: { type: 'number' }, focus: { type: 'boolean' } }, ['projectId', 'descriptorId', ...Object.keys(versions)]),
    { projectId: 'prj_example', descriptorId: 'refmuse.pcg.diagnostic', descriptorVersion: 1, operationVersion: 1 }, async args => {
      current(args);
      const data = pcgNodeData(args.descriptorId, undefined, args);
      const id = latest.current.actions.addNode('pcg', data, Number.isFinite(args.x) && Number.isFinite(args.y) ? { x: args.x, y: args.y } : null, args.focus ?? false);
      const node = await waitForNode(id);
      if (!node) throw pcgError('NODE_NOT_FOUND', 'Created node has not appeared on the current page.');
      current(args);
      await latest.current.actions.persistProject();
      return { node: summarize(node), revision: current(args).revision };
    });
  define('canvas_pcg_set_parameters', 'Replace parameters using the node-specific closed schema from the shared descriptor; save before returning.', object({ projectId, nodeId: token, ...versions, parameters: { anyOf: PCG_REGISTRY.nodes.map(node => node.parameters) } }),
    { projectId: 'prj_example', nodeId: 'pcg-1', descriptorVersion: 1, operationVersion: 1, parameters: { label: 'Contract check' } }, async args => {
      current(args);
      const node = getNode(args.nodeId), descriptor = pcgNodeDescriptor(node);
      pcgNodeData(descriptor.id, args.parameters, args);
      if (descriptor.descriptorVersion !== args.descriptorVersion || descriptor.operationVersion !== args.operationVersion) throw pcgError('VERSION_UNSUPPORTED', 'Versions do not match the saved node.');
      const parameters = structuredClone(args.parameters);
      latest.current.actions.updateNode(args.nodeId, { parameters });
      await waitForNode(args.nodeId, next => next.data.parameters === parameters);
      current(args);
      await latest.current.actions.persistProject();
      return { node: summarize(getNode(args.nodeId)), revision: current(args).revision };
    });
  for (const action of ['preflight', 'run', 'wait', 'read', 'verify']) {
    const taskAction = ['wait', 'read', 'verify'].includes(action);
    const properties = taskAction ? { ...handle } : { ...identity };
    if (action === 'wait') properties.timeoutMs = { type: 'integer', minimum: 0, maximum: 20000 };
    const descriptions = {
      preflight: 'Validate the current saved PCG node, typed input identities, budgets and readiness. Does not run a worker.',
      run: 'Evaluate the saved dependency DAG in the restricted worker, reusing bounded project-scoped content cache. Publish real task-bound GLB/JSON/static preview assets. Reuse runId only for the identical request.',
      wait: 'Wait at most 20000 ms for an exact existing PCG task. Never resubmits; pending reflects actual backend status.',
      read: 'Read an exact task: bounded geometry samples, counts, bounds, domains, actual computed/cache-hit trace and managed assets. Original handles remain readable with stale:true after graph changes.',
      verify: 'Verify real result bindings and exported file hashes for the exact task. Stale or failed results cannot be accepted.',
    };
    define(`canvas_pcg_${action}`, descriptions[action], object(properties, Object.keys(taskAction ? handle : identity)), action === 'wait' ? { ...exampleHandle, timeoutMs: 1000 } : taskAction ? exampleHandle : exampleIdentity, async args => {
      current(args);
      const result = await latest.current.actions.pcg.invoke(action, args);
      return action === 'wait' ? { ...result, pending: ['queued', 'running'].includes(result.task?.status) } : result;
    }, action !== 'run');
  }
  define('canvas_pcg_cancel', 'Cancel only the exact owned PCG task. Retain its node and task record; never touches other services.', object(handle), exampleHandle, args => {
    current(args); return latest.current.actions.pcg.invoke('cancel', args);
  });
  define('canvas_pcg_export', 'Export a verified successful task geometry output to a real GLB or JSON managed asset. GLB retains shared instance prototypes; JSON preserves internal domains. Returns task-bound artifact identity, hash and authenticated local URL.', object({ ...handle, format: { type: 'string', enum: ['glb', 'json'] }, port: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9_]+$' } }, [...Object.keys(handle), 'format']), { ...exampleHandle, format: 'glb', port: 'geometry' }, args => {
    current(args); return latest.current.actions.pcg.invoke('export', args);
  });
  define('canvas_pcg_list_tasks', 'Discover retained PCG tasks for a saved node after reload. Tasks are newest first and include complete handles and stale markers.', object({ projectId, nodeId: token }), { projectId: 'prj_example', nodeId: 'pcg-1' }, args => {
    current(args); return latest.current.actions.pcg.listTasks(args);
  }, true);
  for (const descriptor of viewportTools.tools) {
    define(descriptor.name, descriptor.description, descriptor.inputSchema, descriptor.examples[0].arguments, async args => {
      const viewport = latest.current.actions.pcgViewport;
      if (!viewport) throw pcgError('PREVIEW_UNAVAILABLE', 'This host does not provide the canvas preview hook.');
      if (descriptor.name === 'canvas_pcg_preview_describe') return { contract: viewportTools, inCanvas: true, realWebGL: true, manualDcc: false, aiCallsPerFrame: 0, incrementalEvaluation: true, modelTransfer: 'verified-full-glb', realtimePerformance: 'not-passed' };
      current(args);
      switch (descriptor.name) {
        case 'canvas_pcg_preview_open': viewport.open(); break;
        case 'canvas_pcg_preview_close': viewport.close(); break;
        case 'canvas_pcg_preview_bind': viewport.bind(args.nodeId, args.autoRun ?? true); break;
        case 'canvas_pcg_preview_layout': viewport.layout(Object.fromEntries(['x','y','width','height'].map(k=>[k,args[k]]))); break;
      }
      const panel = viewport.snapshot();
      return { panel: { ...panel, run: pcgAgentState({ task: panel.run }).task } };
    }, ['canvas_pcg_preview_describe','canvas_pcg_preview_state'].includes(descriptor.name));
  }
  define('canvas_pcg_disconnect', 'Disconnect one exact visible PCG edge and save the current graph; bound preview preflights the changed actual graph.', object({ projectId, edgeId: { type:'string',minLength:1,maxLength:256 } }), { projectId:'prj_example', edgeId:'edge-1' }, async args => {
    current(args); const edge=latest.current.edgesRef.current.find(e=>e.id===args.edgeId);
    if(!edge || ![edge.source,edge.target].some(id=>getNode(id)?.type==='pcg')) throw pcgError('EDGE_NOT_FOUND','Use an actual visible PCG edge ID.');
    latest.current.actions.disconnectEdge(edge.id);
    const deadline=Date.now()+2500;
    while(latest.current.edgesRef.current.some(e=>e.id===edge.id)){if(Date.now()>deadline)throw pcgError('EDGE_REMOVE_TIMEOUT','The edge did not leave the visible page.');await new Promise(resolve=>setTimeout(resolve,10));}
    await latest.current.actions.persistProject();return {edgeId:edge.id,revision:current(args).revision};
  });
  return tools;
}
