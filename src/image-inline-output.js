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
    if (node.type === 'media' && node.data.kind === 'image' && node.data.output && owner?.type === 'generator') owners.set(node.id, owner);
  }
  return {
    nodes: nodes.map(node => owners.has(node.id) ? { ...node, hidden: true, selected: false } : node),
    edges: edges.map(edge => {
      if (owners.has(edge.target)) return { ...edge, hidden: true };
      const owner = owners.get(edge.source);
      if (!owner) return edge;
      return { ...edge, source: owner.id, sourceHandle: 'image', label: owner.data.inlineImageOutputId === edge.source ? edge.label : '已锁定历史结果', data: { ...edge.data, inlineImageSourceId: edge.source } };
    }),
  };
}

export function compactInlineImages(nodes, edges, nodeIds) {
  if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > 100 || nodeIds.some(id => typeof id !== 'string')) throw new Error('请指定 1–100 个生成节点 ID。');
  const patches = new Map(); const compacted = []; const skipped = [];
  for (const id of [...new Set(nodeIds)]) {
    const owner = nodes.find(node => node.id === id);
    if (owner?.type !== 'generator' || !owner.data.resultUrl || ['uploading','queued','running','finishing'].includes(owner.data.status)) { skipped.push({id,reason:'节点未完成或不是图片生成节点'}); continue; }
    const outputs = nodes.filter(node => node.type === 'media' && node.data.output && (node.data.sourceGeneratorId === id || edges.some(edge => edge.source === id && edge.target === node.id && edge.targetHandle === 'preview')));
    const current = currentImageOutputs(owner, outputs);
    if (current.length !== 1 || current[0].data.kind !== 'image') { skipped.push({id,reason:'当前图片结果不唯一'}); continue; }
    const groupKey = node => node.data.sourcePromptId || node.data.sourceQueueJobId;
    const currentKey = groupKey(current[0]);
    if (!currentKey || outputs.filter(node => groupKey(node) === currentKey).length !== 1) { skipped.push({id,reason:'多输出或缺少不可变任务来源，保留独立结果'}); continue; }
    const singles = outputs.filter(node => node.data.kind === 'image' && groupKey(node) && outputs.filter(other => groupKey(other) === groupKey(node)).length === 1);
    for (const output of singles) patches.set(output.id, { inlineImageOwnerId:id });
    patches.set(id, { inlineImageOutputId:current[0].id });
    compacted.push({nodeId:id,outputId:current[0].id,backingIds:singles.map(node=>node.id)});
  }
  return { nodes:nodes.map(node => patches.has(node.id) ? {...node,data:{...node.data,...patches.get(node.id)}} : node), edges, compacted, skipped };
}
