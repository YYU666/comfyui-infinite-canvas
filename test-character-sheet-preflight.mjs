import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const { buildCharacterSheetWorkflow } = await import('./src/workbench-api.js');
const graph = buildCharacterSheetWorkflow({
  prompt: '角色设定预检', seed: 42,
  references: [{ kind: 'image', slot: 'guide', name: 'workbench/preflight-only.png' }],
});
const response = await fetch('http://127.0.0.1:8188/object_info');
if (!response.ok) throw new Error(`ComfyUI object_info 读取失败：${response.status}`);
const info = await response.json();
const missingNodes = [...new Set(Object.values(graph).map((node) => node.class_type).filter((name) => !info[name]))];
assert.deepEqual(missingNodes, [], `未注册节点：${missingNodes.join(', ')}`);
const modelInputs = { UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name', LoraLoaderModelOnly: 'lora_name' };
const models = [];
const missingModels = [];
for (const node of Object.values(graph)) {
  const field = modelInputs[node.class_type];
  if (!field) continue;
  const value = node.inputs[field];
  const definition = info[node.class_type]?.input?.required?.[field];
  const choices = Array.isArray(definition?.[0]) ? definition[0] : null;
  if (choices && !choices.includes(value)) missingModels.push(value);
  else models.push(value);
}
assert.deepEqual([...new Set(missingModels)], [], `缺少模型：${missingModels.join(', ')}`);
console.log(JSON.stringify({ ok: true, submitted: false, nodes: Object.keys(graph).length, models: [...new Set(models)] }));
