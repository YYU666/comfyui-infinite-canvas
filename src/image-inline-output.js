export const INLINE_RESULT_KINDS = ['image', 'video', 'model'];

export function isInlineBackingMedia(node, owner) {
  return Boolean(node?.type === 'media' && node.data?.output && INLINE_RESULT_KINDS.includes(node.data?.kind) && owner?.type === 'generator');
}

// A single delivered file stays on the generating node. The media record remains
// the immutable identity that downstream edges bind to.
export function inlineSingleResult(generatorId, mediaNode, fileCount) {
  const kind = mediaNode?.data?.kind;
  if (!generatorId || fileCount !== 1 || !INLINE_RESULT_KINDS.includes(kind)) return { mediaNode, inlined: false };
  return { inlined: true, mediaNode: { ...mediaNode, data: { ...mediaNode.data, inlineImageOwnerId: generatorId } } };
}

export function extractInlineOutput(nodes, generatorId) {
  const owner = nodes.find((node) => node.id === generatorId);
  const outputId = owner?.type === 'generator' ? owner.data?.inlineImageOutputId : null;
  const output = outputId && nodes.find((node) => node.id === outputId && node.data?.inlineImageOwnerId === generatorId);
  if (!output) return { nodes, extracted: false };
  return {
    extracted: true, outputId,
    nodes: nodes.map((node) => {
      if (node.id === outputId) {
        const { inlineImageOwnerId, ...data } = node.data;
        return { ...node, data };
      }
      if (node.id === generatorId) {
        const { inlineImageOutputId, ...data } = node.data;
        return { ...node, data };
      }
      return node;
    }),
  };
}

// URLs can change from output to uploaded input; execution IDs identify the result.
export function currentImageOutputs(owner, outputs) {
  const pairs = [['promptId','sourcePromptId'], ['queueJobId','sourceQueueJobId']];
  const conflicts = node => pairs.some(([a,b]) => owner.data[a] && node.data[b] && owner.data[a] !== node.data[b]);
  const matches = node => pairs.some(([a,b]) => owner.data[a] && node.data[b] && owner.data[a] === node.data[b]);
  const eligible = outputs.filter(node => !node.data.sourceGeneratorId || node.data.sourceGeneratorId === owner.id);
  const linked = owner.data.inlineImageOutputId && eligible.find(node => node.id === owner.data.inlineImageOutputId);
  const identified = eligible.filter(node => matches(node));
  // Reject contradictory execution identities, including a stale explicit output ID.
  if ((linked && conflicts(linked)) || identified.some(conflicts)) return [];
  if (identified.length) {
    if (owner.data.inlineImageOutputId && (!linked || !identified.includes(linked))) return [];
    return identified;
  }
  if (owner.data.inlineImageOutputId) return linked && !conflicts(linked) ? [linked] : [];
  // Legacy nodes without execution metadata can retain their previous exact-URL lookup.
  if (pairs.some(([key]) => owner.data[key])) return [];
  return eligible.filter(node => node.data.url === owner.data.resultUrl);
}

// Presentation only: persisted edges always point to immutable media identities.
export function inlineImageView(nodes, edges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const owners = new Map();
  for (const node of nodes) {
    const owner = byId.get(node.data?.inlineImageOwnerId);
    if (isInlineBackingMedia(node, owner)) owners.set(node.id, owner);
  }
  return {
    nodes: nodes.map(node => owners.has(node.id) ? { ...node, hidden: true, selected: false } : node),
    edges: edges.map(edge => {
      if (owners.has(edge.target)) return { ...edge, hidden: true };
      const owner = owners.get(edge.source);
      if (!owner) return edge;
      const kind = byId.get(edge.source)?.data?.kind;
      const sourceHandle = kind === 'video' ? 'video' : kind === 'model' ? 'model' : 'image';
      return { ...edge, source: owner.id, sourceHandle, label: owner.data.inlineImageOutputId === edge.source ? edge.label : '已锁定历史结果', data: { ...edge.data, inlineImageSourceId: edge.source } };
    }),
  };
}

export function imageCompactArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['nodeIds', 'dryRun'].includes(key))
    || !Array.isArray(args.nodeIds) || !args.nodeIds.length || args.nodeIds.length > 100
    || args.nodeIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
    || (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')) throw new Error('请指定 1–100 个有效节点 ID；dryRun 只能为布尔值。');
  return { nodeIds: [...args.nodeIds], dryRun: args.dryRun ?? true };
}

export function compactInlineImages(nodes, edges, nodeIds) {
  imageCompactArgs({ nodeIds });
  const patches = new Map(); const compacted = []; const skipped = [];
  for (const id of [...new Set(nodeIds)]) {
    const owner = nodes.find(node => node.id === id);
    if (owner?.type !== 'generator' || !owner.data.resultUrl || !['done','completed'].includes(owner.data.status) || owner.data.error || owner.data.shareError) { skipped.push({id,reason:'节点未完成或没有可收拢的结果'}); continue; }
    const outputs = nodes.filter(node => node.type === 'media' && node.data.output && (node.data.sourceGeneratorId === id || edges.some(edge => edge.source === id && edge.target === node.id && edge.targetHandle === 'preview')));
    const current = currentImageOutputs(owner, outputs);
    if (current.length !== 1 || !INLINE_RESULT_KINDS.includes(current[0].data.kind)) { skipped.push({id,reason:'当前结果不唯一'}); continue; }
    const sameExecution = (a, b) => ['sourcePromptId', 'sourceQueueJobId'].some(key => a.data[key] && a.data[key] === b.data[key]);
    const singleOwnedImage = node => INLINE_RESULT_KINDS.includes(node.data.kind)
      && (!node.data.sourceGeneratorId || node.data.sourceGeneratorId === id)
      && (!node.data.inlineImageOwnerId || node.data.inlineImageOwnerId === id)
      && !edges.some(edge => edge.target === node.id && edge.targetHandle === 'preview' && edge.source !== id)
      && outputs.filter(other => sameExecution(node, other)).length === 1;
    if (!singleOwnedImage(current[0])) { skipped.push({id,reason:'多输出、来源不明确或缺少不可变任务来源，保留独立结果'}); continue; }
    const singles = outputs.filter(singleOwnedImage);
    for (const output of singles) patches.set(output.id, { inlineImageOwnerId:id });
    patches.set(id, { inlineImageOutputId:current[0].id });
    compacted.push({nodeId:id,outputId:current[0].id,backingIds:singles.map(node=>node.id)});
  }
  return { nodes:nodes.map(node => patches.has(node.id) ? {...node,data:{...node.data,...patches.get(node.id)}} : node), edges, compacted, skipped };
}
