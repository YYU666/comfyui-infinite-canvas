import { buildImageWorkflow, buildImageHdWorkflow, buildIdentityEditWorkflow, buildQwen21EditWorkflow, buildLocalRealismWorkflow, buildCharacterSheetQueuePlan } from './workbench-api';

const BUILDERS = { image: buildImageWorkflow, imageUpscale: buildImageHdWorkflow, identityEdit: buildIdentityEditWorkflow, qwenEdit: buildQwen21EditWorkflow, localRealism: buildLocalRealismWorkflow };
export function shareSource(node, references = []) {
  if (node.data.mode === 'customWorkflow') return { digest: node.data.extensionDigest, nodeDefinitionId: node.data.nodeDefinitionId, parameters: { ...node.data.workflowParameters } };
  const builder = BUILDERS[node.data.mode];
  if (!builder && node.data.mode !== 'characterSheet') throw new Error('当前节点暂不支持完整打包。支持单阶段图片和角色四视图节点；其他工作流可在 ComfyUI 中导出单个图片工作流的 API JSON，再从本地节点导入分享。');
  const placeholders = references.filter((reference) => reference.data.kind === 'image').map((reference, index) => ({ kind: 'image', slot: reference.data.slot, title: `输入 ${index + 1}`, name: `input_${index + 1}.png` }));
  if (!placeholders.some((reference) => reference.slot === 'guide') && node.data.mode !== 'image') placeholders.unshift({ kind: 'image', slot: 'guide', title: '输入图片', name: 'input_guide.png' });
  const options = { ...node.data, seed: Number(node.data.seed || 42), prompt: node.data.prompt || 'Describe the image.', references: placeholders };
  return node.data.mode === 'characterSheet' ? { plan: buildCharacterSheetQueuePlan(options) } : { workflow: builder(options) };
}

export function shareTextPreview(bundle) {
  return bundle.nodes.flatMap(({ definition, workflow }) => Object.entries(workflow).flatMap(([id, node]) => Object.entries(node.inputs || {}).filter(([, value]) => typeof value === 'string').map(([field, value]) => `${definition.name} / ${id}.${field}: ${value}`))).join('\n');
}

export function shareSummary(bundle) {
  const { packageId, version, name, description } = bundle.manifest;
  return { packageId, version, name, description,
    models: (bundle.dependencyReport?.models || []).map(({ category, name: modelName }) => ({ category, name: modelName })),
    comfyNodes: (bundle.dependencyReport?.comfyNodes || []).map(({ classType }) => ({ classType })),
  };
}
