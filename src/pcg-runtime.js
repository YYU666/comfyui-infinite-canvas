import { pcgError, pcgNodeDescriptor, PCG_ACTIVE } from './pcg-registry.js';

export const PCG_HANDLE_KEYS = ['projectId', 'nodeId', 'revision', 'descriptorVersion', 'operationVersion', 'runId', 'jobId', 'inputHash'];
export const pcgTaskHandle = task => Object.fromEntries(PCG_HANDLE_KEYS.map(key => [key, task[key]]));
export async function pcgRequest(path, body, { fetchImpl = globalThis.fetch, signal } = {}) {
  const response = await fetchImpl(`/api/pcg${path}`, body === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw Object.assign(pcgError(result.code || 'REQUEST_FAILED', result.message || 'PCG request failed.'), { task: result.task, details: result.details });
  return result;
}

// Task state stays outside the saved node: status polling must not change the
// saved graph revision used by the worker's immutable request identity.
export function createPcgRuntime({ getContext, getNode, persistProject, onChange = () => {}, request = pcgRequest }) {
  const states = new Map(), inflight = new Map(), epochs = new Map();
  const stateKey = (projectId, nodeId) => `${projectId}:${nodeId}`;
  const context = projectId => {
    const current = getContext();
    if (current.projectId !== projectId) throw pcgError('PROJECT_MISMATCH', 'Use the current project ID from canvas_get_state.');
    if (current.readOnly || current.switching) throw pcgError('READ_ONLY', 'The current project is not writable.');
    return current;
  };
  const nodeContract = args => {
    context(args.projectId);
    const descriptor = pcgNodeDescriptor(getNode(args.nodeId));
    if (descriptor.descriptorVersion !== args.descriptorVersion || descriptor.operationVersion !== args.operationVersion) throw pcgError('VERSION_UNSUPPORTED', 'Read the current descriptor versions before retrying.');
    return descriptor;
  };
  const publish = (projectId, nodeId, patch) => {
    if (getContext().projectId !== projectId) return;
    const key = stateKey(projectId, nodeId), previous = states.get(key) || {};
    // A response for an earlier run can be read by its caller without replacing
    // the latest visible task. Restore uses the backend's newest-first ordering.
    if (patch.task && previous.task && patch.task.jobId !== previous.task.jobId && !patch.replace) return;
    states.set(key, { ...previous, ...patch }); onChange();
  };
  const invoke = async (action, args) => {
    nodeContract(args);
    const key = stateKey(args.projectId, args.nodeId);
    const epoch = action === 'run' ? (epochs.get(key) || 0) + 1 : epochs.get(key) || 0;
    if (action === 'run') epochs.set(key, epoch);
    if (['preflight', 'run'].includes(action)) {
      await persistProject();
      if (context(args.projectId).revision !== args.revision) throw pcgError('REVISION_CONFLICT', 'Graph revision changed. Read canvas_get_state and start a new runId.');
      nodeContract(args);
    }
    try {
      const result = await request(`/${action}`, args);
      context(args.projectId);
      if (result.task && PCG_HANDLE_KEYS.some(field => Object.hasOwn(args, field) && result.task[field] !== args[field])) throw pcgError('TASK_IDENTITY_MISMATCH', 'The response does not match the requested task identity.');
      if (result.task && epoch === (epochs.get(key) || 0)) publish(args.projectId, args.nodeId, { task: result.task, error: null, replace: action === 'run' });
      return result;
    } catch (error) {
      const matchingTask = error.task && PCG_HANDLE_KEYS.every(field => !Object.hasOwn(args, field) || error.task[field] === args[field]);
      const sameVisibleJob = !args.jobId || !states.get(key)?.task || states.get(key).task.jobId === args.jobId;
      if (epoch === (epochs.get(key) || 0) && sameVisibleJob) publish(args.projectId, args.nodeId, { ...(matchingTask ? { task: error.task } : {}), error: { code: error.code, message: error.message }, replace: action === 'run' });
      throw error;
    }
  };
  return {
    getState(nodeId) {
      const state = states.get(stateKey(getContext().projectId, nodeId)) || {};
      return { ...state, task: state.task ? { ...state.task, stale: state.task.stale || state.task.revision !== getContext().revision } : null };
    },
    async listTasks({ projectId, nodeId }) {
      context(projectId); const descriptor = pcgNodeDescriptor(getNode(nodeId));
      const key = stateKey(projectId, nodeId), epoch = epochs.get(key) || 0;
      const result = await request(`/tasks?${new URLSearchParams({ projectId, nodeId })}`);
      context(projectId);
      const task = result.tasks?.find(item => item.projectId === projectId && item.nodeId === nodeId && item.descriptorId === descriptor.id && item.descriptorVersion === descriptor.descriptorVersion && item.operationVersion === descriptor.operationVersion);
      if (task && epoch === (epochs.get(key) || 0)) publish(projectId, nodeId, { task, error: null });
      return result;
    },
    invoke,
    async runNode(nodeId, { runId = globalThis.crypto.randomUUID(), wait = false, timeoutMs = 1000 } = {}) {
      const key = stateKey(getContext().projectId, nodeId);
      if (inflight.has(key)) throw pcgError('NODE_BUSY', 'A PCG submission is already in progress. Read or wait for its task.');
      if (PCG_ACTIVE.includes(states.get(key)?.task?.status)) throw pcgError('NODE_BUSY', 'A PCG task is active. Read or wait for its task.');
      const promise = (async () => {
        const current = getContext(); context(current.projectId);
        const descriptor = pcgNodeDescriptor(getNode(nodeId));
        await persistProject();
        const args = { projectId: current.projectId, nodeId, revision: context(current.projectId).revision, descriptorVersion: descriptor.descriptorVersion, operationVersion: descriptor.operationVersion, runId };
        const result = await invoke('run', args);
        return wait ? invoke('wait', { ...pcgTaskHandle(result.task), timeoutMs: Math.min(20000, timeoutMs) }) : result;
      })();
      inflight.set(key, promise);
      try { return await promise; } finally { inflight.delete(key); }
    },
  };
}
