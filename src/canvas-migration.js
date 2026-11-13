import { assetUrl } from './project-store-http.js';
import { settleSavedNode } from './canvas-task-state.js';
import { qwenCanvasReferences, bindQwenPrompt } from './qwen-references.js';
import { ensureReferenceTags } from './reference-tags.js';

export const DEFAULT_GENERATOR = {
  title: '视频生成', mode: 'reference', prompt: '', ratio: '16:9', resolution: '480P', duration: 5,
  turbo: false, refImageSize: 'max', referenceSettingsVersion: 3, seed: 42, randomSeed: true,
  preserveBackground: true, targetQuery: 'person', targetIndex: 0, targetDescription: '', precision: 1,
  imageModel: 'krea2', imageLora: 'none', loraStrength: 0.8, imageScale: 1.5,
  status: 'idle', progress: 0, stage: '', pinned: false, runs: [],
};
export function initialCanvas() {
  return {
    nodes: [
      { id: 'reference-image', type: 'media', position: { x: 60, y: 180 }, data: { kind: 'image', title: '角色参考', url: '', name: '', pinned: false } },
      { id: 'main-generator', type: 'generator', position: { x: 430, y: 120 }, data: { ...DEFAULT_GENERATOR } },
    ],
    edges: [{ id: 'edge-reference-image-main-generator', source: 'reference-image', target: 'main-generator', sourceHandle: 'ref', targetHandle: 'references' }],
    viewport: { x: 0, y: 0, zoom: 0.9 },
  };
}

export function migrateCanvas(value, projectId) {
  if (!Array.isArray(value?.nodes)) return initialCanvas();
  const nodes = value.nodes.map((node) => {
    if (node.type === 'generator' || node.type === 'h3') {
      const mode = node.data.mode || 'reference';
      const title = ['reference', 'frames', 'text'].includes(mode) && ['全能参考', 'H3 视频生成', '首尾帧生成视频', '文生视频'].includes(node.data.title) ? '视频生成' : mode === 'image' && node.data.title === '本地生图' ? '文生图' : node.data.title;
      const data = { ...DEFAULT_GENERATOR, ...node.data, title: title || DEFAULT_GENERATOR.title, mode };
      if (data.mode === 'reference' && node.data.referenceSettingsVersion !== 3) Object.assign(data, { turbo: false, refImageSize: 'max', referenceSettingsVersion: 3 });
      return { ...node, type: 'generator', data };
    }
    if (node.type === 'media' || node.type === 'image') {
      const kind = node.data.kind || 'image';
      return { ...node, type: 'media', data: { ...node.data, kind, title: node.data.title === '首帧素材' ? '角色参考' : node.data.title, ...(projectId && node.data.sourceProcessId && node.data.assetPath ? { url: assetUrl(projectId, node.data.assetPath) } : {}) } };
    }
    if (node.type === 'video') return { ...node, type: 'media', data: { ...node.data, kind: 'video', output: true } };
    if (node.type === 'prompt') return { ...node, data: { title: 'H3 提示词优化', idea: '', optimizedPrompt: '', status: 'idle', ...node.data } };
    if (node.type === 'imageProcess' || node.type === 'artDirector') return { ...node, data: { ...node.data, status: ['running', 'uploading', 'finishing'].includes(node.data.status) ? 'idle' : node.data.status } };
    if (node.type === 'note') return { ...node, data: node.data.title === '从这里开始' ? { ...node.data, text: '① 上传图片、视频或音频素材\n② 选中视频生成，用 + 添加或连线素材\n③ 输入 @ 名称引用角色、动作或声音\n④ 点击右下角箭头，本地生成视频\n\n视频生成支持全能参考和首尾帧两种模式。' } : node.data };
    // Retain newer/extension node types when reopening with an older client.
    // Dropping them here would make the next autosave permanently delete their data.
    return node;
  }).filter(Boolean).map((node) => settleSavedNode(node));
  const edges = (value.edges || []).map((edge) => {
    const target = nodes.find((node) => node.id === edge.target);
    const isReference = target?.type === 'generator' && (target.data.mode || 'reference') === 'reference';
    return {
      ...edge,
      type: 'default',
      sourceHandle: nodes.find((node) => node.id === edge.source)?.type === 'media' && ['image', 'video'].includes(edge.sourceHandle) ? 'ref' : edge.sourceHandle,
      targetHandle: !['generator', 'media', 'prompt', 'note'].includes(target?.type) ? edge.targetHandle : target?.data.mode === 'customWorkflow' ? edge.targetHandle : isReference && ['first', 'last'].includes(edge.targetHandle) ? 'references' : ['first', 'last', 'preview', 'prompt', 'guide', 'identity', 'mask'].includes(edge.targetHandle) ? edge.targetHandle : 'references',
    };
  }).filter((edge) => nodes.some((n) => n.id === edge.source) && nodes.some((n) => n.id === edge.target));
  const migrated = nodes.map((node) => {
    if (node.data.mode !== 'qwenEdit') return node;
    const refs = qwenCanvasReferences(node, nodes, edges);
    return { ...node, data: { ...node.data, qwenReferenceOrder: node.data.qwenReferenceOrder || refs.map((ref) => ref.id), prompt: bindQwenPrompt(node.data.prompt || '', refs) } };
  });
  return { ...value, nodes: ensureReferenceTags(migrated), edges: edges.map((edge) => migrated.some((node) => node.id === edge.target && node.data.mode === 'qwenEdit') && ['guide', 'identity'].includes(edge.targetHandle) ? { ...edge, targetHandle: 'references' } : edge) };
}
