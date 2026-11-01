async function request(path, options) {
  const response = await fetch(`/api/extensions${path}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || `工作流请求失败 (${response.status})`);
  return result;
}

export function extensionPath(digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('工作流包摘要无效。');
  return `/${digest}`;
}
export const listExtensions = () => request('');
export const getExtension = (digest) => request(extensionPath(digest));
export const importExtension = (file) => request('/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
export const prepareExtension = (data, inputs) => request(`${extensionPath(data.extensionDigest)}/prepare`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nodeDefinitionId: data.nodeDefinitionId, inputs, parameters: data.workflowParameters || {} }),
});

export function extensionNodeData(bundle, nodeDefinitionId) {
  extensionPath(bundle.digest);
  const definition = bundle.nodes.find((node) => node.definition.nodeDefinitionId === nodeDefinitionId)?.definition;
  if (!definition) throw new Error('节点定义不在该工作流包中。');
  return {
    mode: 'customWorkflow', title: definition.name, extensionDigest: bundle.digest,
    extensionPackageId: bundle.manifest.packageId, extensionVersion: bundle.manifest.version,
    nodeDefinitionId, workflowDefinition: definition,
    workflowParameters: Object.fromEntries(Object.entries(definition.parameters?.properties || {}).filter(([, field]) => field.default !== undefined).map(([id, field]) => [id, field.default])),
  };
}

export function customInput(data, portId) {
  return data?.mode === 'customWorkflow' && data.workflowDefinition?.inputs?.find((port) => port.id === portId && port.type === 'image' && !port.list);
}

export function validateWorkflowParameters(data, values) {
  if (data?.mode !== 'customWorkflow' || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error('工作流参数必须是自定义节点的参数对象。');
  const properties = data.workflowDefinition?.parameters?.properties || {};
  for (const [key, value] of Object.entries(values)) {
    const field = Object.hasOwn(properties, key) ? properties[key] : null;
    if (!field) throw new Error(`未知工作流参数：${key}`);
    const valid = field.type === 'integer' ? Number.isSafeInteger(value) : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : ['string', 'boolean'].includes(field.type) && typeof value === field.type;
    if (!valid || (field.enum && !field.enum.includes(value)) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) throw new Error(`工作流参数类型或范围无效：${key}`);
  }
  return { ...data.workflowParameters, ...values };
}

export function declaredHistory(entry, outputs) {
  const ids = new Set((outputs || []).map((output) => String(output.nodeId)));
  return { ...entry, outputs: Object.fromEntries(Object.entries(entry?.outputs || {}).filter(([id]) => ids.has(id))) };
}

export function extensionMedia(entry, outputs) {
  const files = [];
  for (const output of outputs || []) {
    const matcher = output.type === 'video' ? /\.(mp4|webm|mov|mkv)$/i : /\.(png|jpe?g|webp)$/i;
    const declaredFiles = [];
    for (const value of Object.values(entry?.outputs?.[output.nodeId] || {})) {
      if (!Array.isArray(value)) continue;
      for (const file of value) if (file?.filename && typeof file.subfolder === 'string' && file.type && matcher.test(file.filename)) {
        const url = `/api/comfy/view?${new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })}`;
        declaredFiles.push({ ...file, url, kind: output.type, extensionOutputId: output.id });
      }
    }
    if (!declaredFiles.length) throw new Error(`工作流缺少声明输出：${output.id}（节点 ${output.nodeId}）。`);
    for (const file of declaredFiles) if (!files.some((item) => item.url === file.url)) files.push(file);
  }
  return files;
}
