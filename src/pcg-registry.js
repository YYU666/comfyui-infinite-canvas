import registry from '../pcg/registry.json' with { type: 'json' };

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const PCG_REGISTRY = freeze(registry);
export const PCG_ACTIVE = ['queued', 'running'];
export const isPcgNode = node => node?.type === 'pcg';
export function pcgError(code, message) { return Object.assign(new Error(message), { code }); }

// The same closed schema is enforced for direct tools and page transport calls.
export function validatePcgSchema(value, schema, path = 'args') {
  if (schema.anyOf) {
    if (!schema.anyOf.some(option => { try { validatePcgSchema(value, option, path); return true; } catch { return false; } })) throw pcgError('INVALID_CONTRACT', `${path}: no declared schema matches`);
    return;
  }
  const type = schema.type;
  const valid = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value)
      : type === 'number' ? Number.isFinite(value) : !type || typeof value === type;
  if (!valid || (schema.enum && !schema.enum.includes(value))) throw pcgError('INVALID_CONTRACT', `${path}: expected declared ${type || 'value'}`);
  if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw pcgError('INVALID_CONTRACT', `${path}: outside declared range`);
  if (type === 'string' && ((schema.minLength !== undefined && [...value].length < schema.minLength) || (schema.maxLength !== undefined && [...value].length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) throw pcgError('INVALID_CONTRACT', `${path}: invalid string`);
  if (type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw pcgError('INVALID_CONTRACT', `${path}.${key}: required`);
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validatePcgSchema(entry, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw pcgError('INVALID_CONTRACT', `${path}.${key}: unsupported field`);
    }
  }
  if (type === 'array') {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw pcgError('INVALID_CONTRACT', `${path}: invalid item count`);
    value.forEach((entry, i) => validatePcgSchema(entry, schema.items || {}, `${path}[${i}]`));
  }
  return value;
}

export function pcgDescriptor(id, descriptorVersion = 1, operationVersion = 1) {
  const descriptor = PCG_REGISTRY.nodes.find(item => item.id === id);
  if (!descriptor) throw pcgError('INVALID_CONTRACT', `Unknown PCG descriptor: ${id}`);
  if (descriptorVersion !== PCG_REGISTRY.descriptorVersion || descriptor.descriptorVersion !== descriptorVersion || descriptor.operationVersion !== operationVersion) throw pcgError('VERSION_UNSUPPORTED', 'Unsupported PCG descriptor or operation version. Read canvas_pcg_describe.');
  if (descriptor.permissions.length) throw pcgError('PERMISSION_DENIED', 'This host grants no PCG runtime permissions.');
  return descriptor;
}

export function pcgNodeData(id, parameters, versions = {}) {
  const descriptor = pcgDescriptor(id, versions.descriptorVersion, versions.operationVersion);
  const defaults = Object.fromEntries(Object.entries(descriptor.parameters.properties).filter(([, schema]) => Object.hasOwn(schema, 'default')).map(([key, schema]) => [key, schema.default]));
  const values = parameters === undefined ? defaults : parameters;
  validatePcgSchema(values, descriptor.parameters, 'parameters');
  return { title: descriptor.label, descriptorId: id, descriptorVersion: descriptor.descriptorVersion, operationVersion: descriptor.operationVersion, parameters: structuredClone(values) };
}

export const PCG_PRESETS = Object.fromEntries(PCG_REGISTRY.nodes.map(descriptor => [descriptor.id.replace('refmuse.', '').replaceAll('.', '_'), ['pcg', pcgNodeData(descriptor.id)]]));

export function pcgNodeDescriptor(node) {
  if (!isPcgNode(node)) throw pcgError('INVALID_CONTRACT', 'Expected a PCG node.');
  const descriptor = pcgDescriptor(node.data.descriptorId, node.data.descriptorVersion, node.data.operationVersion);
  if (node.data.descriptorVersion === undefined || node.data.operationVersion === undefined) throw pcgError('VERSION_UNSUPPORTED', 'PCG node is missing explicit contract versions.');
  validatePcgSchema(node.data.parameters, descriptor.parameters, 'parameters');
  return descriptor;
}

export function planPcgConnection(connection, nodes, edges) {
  try {
    const source = nodes.find(node => node.id === connection.source), target = nodes.find(node => node.id === connection.target);
    const from = pcgNodeDescriptor(source), to = pcgNodeDescriptor(target);
    const output = from.outputs.find(port => port.name === connection.sourceHandle), input = to.inputs.find(port => port.name === connection.targetHandle);
    if (!output || !input || output.type !== input.type) throw pcgError('PORT_TYPE_MISMATCH', 'PCG ports require explicit matching output/input names and exact value types. Read canvas_pcg_describe.');
    const queue = [target.id], seen = new Set();
    while (queue.length) {
      const id = queue.pop();
      if (id === source.id) throw pcgError('INVALID_CONTRACT', 'PCG connections cannot form a cycle.');
      if (!seen.has(id)) { seen.add(id); edges.filter(edge => edge.source === id).forEach(edge => queue.push(edge.target)); }
    }
    const normalized = { source: source.id, target: target.id, sourceHandle: output.name, targetHandle: input.name };
    return { source, target, multiple: false, connection: normalized, edgeData: { pcgType: output.type }, edgeLabel: output.type, existing: edges.find(edge => Object.entries(normalized).every(([key, value]) => edge[key] === value)) };
  } catch (error) { return { error: `${error.code || 'INVALID_CONTRACT'}: ${error.message}` }; }
}

export function pcgPreview(data, task, error) {
  let descriptor;
  try { descriptor = pcgNodeDescriptor({ type: 'pcg', data }); } catch (failure) { return { label: data.title || 'PCG', status: 'invalid', message: `${failure.code}: ${failure.message}`, inputs: [], outputs: [] }; }
  const stale = Boolean(task?.stale || (task && (task.descriptorId !== descriptor.id || task.descriptorVersion !== descriptor.descriptorVersion || task.operationVersion !== descriptor.operationVersion)));
  return { label: descriptor.label, inputs: descriptor.inputs, outputs: descriptor.outputs, readiness: descriptor.readiness,
    status: task?.status || 'idle', stale, progress: task && Number.isFinite(task.progress) ? Math.max(0, Math.min(1, task.progress)) : null,
    message: error ? `${error.code || 'REQUEST_FAILED'}: ${error.message}` : task?.error ? `${task.error.code}: ${task.error.message}` : descriptor.readiness.state === 'unavailable' ? `${descriptor.readiness.code}: 几何执行器尚未提供` : '固定合同诊断 · 独立进程',
    report: task?.result?.report || null, task: task || null };
}
