import { buildImageWorkflow, buildImageHdWorkflow, buildIdentityEditWorkflow, buildQwen21EditWorkflow, buildLocalRealismWorkflow, buildCharacterSheetQueuePlan } from './workbench-api.js';

const BUILDERS = { image: buildImageWorkflow, imageUpscale: buildImageHdWorkflow, identityEdit: buildIdentityEditWorkflow, qwenEdit: buildQwen21EditWorkflow, localRealism: buildLocalRealismWorkflow };

// This exact pre-v1.0.2 capability error became obsolete when staged sharing shipped.
export function resolvedLegacyShareError(data) {
  return data?.mode === 'characterSheet' && data.error === '当前节点是视频或多阶段队列，暂不能完整打包。请在 ComfyUI 中导出单个图片工作流的 API JSON，再从本地节点导入分享。';
}

// Describe the operation, not the author's canvas title or private prompt.
export function suggestShareMetadata(node, source = {}) {
  const data = node?.data || {};
  const staged = data.mode === 'characterSheet' || data.workflowDefinition?.execution?.kind === 'characterSheet' || source.plan?.kind === 'characterSheet';
  const recipes = {
    image: [data.imageModel === 'flux3_klein' ? 'FLUX 3 Klein 文生图' : data.imageModel === 'moss' ? 'MOSS 文生图' : 'Krea2 文生图', '根据文字描述生成图片。', '填写画面描述，按需连接参考图片，调整尺寸和种子后运行。'],
    imageUpscale: ['图片放大与清晰度增强', '对输入图片进行放大处理。', '连接待放大的图片，检查放大模型与输出参数后运行。'],
    identityEdit: ['人物参考图编辑', '以人物参考图为基础进行图片编辑。', '连接人物参考图，填写需要修改的内容，再运行并检查人物特征与画面效果。'],
    qwenEdit: [data.qwenModel === 'flux3_klein' ? 'FLUX 3 Klein 图片编辑' : 'Qwen 图片编辑', '结合参考图片与文字指令生成编辑后的图片。', '连接原图和需要的参考图，描述修改目标，调整采样参数后运行。'],
    localRealism: ['人像局部肤质修复', '对人像皮肤区域进行局部写实处理。', '连接正面人像，按需提供遮罩，检查修复区域与强度后运行。'],
  };
  let recipe = staged ? ['单图生成角色四视图', '从一张人物参考图依次生成正面头像、45°头像、背面全身和正面全身，最后拼成四视图。', '连接一张单人角色参考图，检查角色描述、尺寸与采样参数后运行。45°头像使用已生成的正面头像作为参考，其余视角使用原始参考图。'] : recipes[data.mode];
  if (!recipe) {
    const definition = data.workflowDefinition || {};
    const inputs = definition.inputs?.filter((input) => input.type === 'image').length ?? Object.values(source.workflow || {}).filter((entry) => entry.class_type === 'LoadImage').length;
    const outputs = definition.outputs?.length || 1;
    recipe = [inputs ? `${inputs}图输入的图片处理工作流` : '图片生成与输出工作流', `接收${inputs ? ` ${inputs} 个图片输入` : '工作流参数'}，按预设处理并提供 ${outputs} 个图片输出端口。`, inputs ? '按输入端口连接图片，核对参数后运行；具体处理效果请结合封面和工作流预览确认。' : '核对提示词与工作流参数后运行；具体处理效果请结合封面和工作流预览确认。'];
  }
  return { name: recipe[0], description: `${recipe[1]}\n\n使用方法：${recipe[2]}\n\n运行前请检查模型、LoRA 和 ComfyUI 节点依赖，缺少的内容需要补齐。结果受参考图、提示词与模型配置影响。` };
}
export function shareSource(node, references = []) {
  if (node.data.mode === 'customWorkflow') return { digest: node.data.extensionDigest, nodeDefinitionId: node.data.nodeDefinitionId, parameters: { ...node.data.workflowParameters } };
  const builder = BUILDERS[node.data.mode];
  if (!builder && node.data.mode !== 'characterSheet') throw new Error('当前节点暂不支持完整打包。支持单阶段图片和角色四视图节点；其他工作流可在 ComfyUI 中导出单个图片工作流的 API JSON，再从本地节点导入分享。');
  const placeholders = references.filter((reference) => reference.data.kind === 'image').map((reference, index) => ({ id: reference.id, kind: 'image', slot: reference.data.slot, title: `输入 ${index + 1}`, name: `input_${index + 1}.png` }));
  if (!placeholders.some((reference) => reference.slot === 'guide') && !['image', 'qwenEdit'].includes(node.data.mode)) placeholders.unshift({ kind: 'image', slot: 'guide', title: '输入图片', name: 'input_guide.png' });
  if (node.data.mode === 'qwenEdit' && !placeholders.length) placeholders.push({ kind: 'image', slot: 'references', name: 'input_1.png' });
  const options = { ...node.data, seed: Number(node.data.seed || 42), prompt: node.data.prompt || 'Describe the image.', references: placeholders };
  return node.data.mode === 'characterSheet' ? { plan: buildCharacterSheetQueuePlan(options) } : { workflow: builder(options) };
}

export function shareTextPreview(bundle) {
  return bundle.nodes.flatMap(({ definition, workflow }) => Object.entries(workflow).flatMap(([id, node]) => Object.entries(node.inputs || {}).filter(([, value]) => typeof value === 'string').map(([field, value]) => `${definition.name} / ${id}.${field}: ${value}`))).join('\n');
}

export function shareSummary(bundle) {
  const { packageId, version, name, description } = bundle.manifest;
  return { packageId, version, name, description, ...(bundle.manifest.preview ? { preview: bundle.manifest.preview } : {}),
    models: (bundle.dependencyReport?.models || []).map(({ category, name: modelName }) => ({ category, name: modelName })),
    comfyNodes: (bundle.dependencyReport?.comfyNodes || []).map(({ classType }) => ({ classType })),
  };
}
