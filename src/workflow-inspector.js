export const INSPECTOR_CHANNEL = 'h3-workflow-inspector';
export const INSPECTOR_VERSION = 1;
export const COMFY_INSPECTOR_ORIGIN = 'http://127.0.0.1:8188';

export function inspectionQuery(projectId, node, edges = []) {
  if (node.data?.sourcePromptId) {
    const source = node.data.sourceGeneratorId || edges.find((edge) => edge.target === node.id && edge.targetHandle === 'preview')?.source;
    return { projectId, promptId: node.data.sourcePromptId,
      ...(node.data.sourceQueueJobId ? { jobId: node.data.sourceQueueJobId } : {}), ...(source ? { nodeId: source } : {}) };
  }
  if (node.type !== 'generator') throw new Error('这个节点没有生成执行记录。');
  return { projectId, nodeId: node.id,
    ...(node.data.queueJobId ? { jobId: node.data.queueJobId } : node.data.promptId ? { promptId: node.data.promptId } : {}) };
}

export function canInspectNode(node) {
  return node.type === 'generator' || Boolean(node.data?.sourcePromptId);
}

export function isInspectorMessage(event, frameWindow, nonce) {
  return event.source === frameWindow && event.origin === COMFY_INSPECTOR_ORIGIN
    && event.data?.channel === INSPECTOR_CHANNEL && event.data.version === INSPECTOR_VERSION && event.data.nonce === nonce;
}

export function stageDescription(stage) {
  if (!stage.graph) return stage.reason || '这个阶段的工作流不可用。';
  if (stage.provenance === 'execution') return '实际执行图 · 来自 ComfyUI 历史';
  if (stage.executed === false) return '尚未执行 · 持久化计划副本';
  return stage.executed ? '已提交阶段 · 持久化计划还原' : '持久化计划副本 · 无法确认此阶段执行记录';
}
