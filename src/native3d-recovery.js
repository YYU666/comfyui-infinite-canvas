// Restore missing 3D records from a saved project snapshot through its active page.
// Existing records always win; this is not a whole-project rollback.
export function recoverNative3DFragment(nodes, edges, fragment) {
  if (!Array.isArray(fragment.nodes) || fragment.nodes.length > 256 || !Array.isArray(fragment.edges) || fragment.edges.length > 2048) throw new Error('恢复片段超出范围。');
  const ids = new Set(nodes.map(n => n.id)); const seen = new Set(); const added = [];
  for (const node of fragment.nodes) {
    if (!node || node.type !== 'native3d' || typeof node.id !== 'string' || !node.id.startsWith('native3d-') || seen.has(node.id)
      || !node.data || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) throw new Error('恢复片段包含无效3D节点。');
    seen.add(node.id);
    if (['queued','running','uploading','finishing'].includes(node.data.status)) throw new Error('不能恢复运行中的节点快照。');
    if (!ids.has(node.id)) { added.push(structuredClone(node)); ids.add(node.id); }
  }
  const nativeIds = new Set([...nodes, ...added].filter(n => n.type === 'native3d').map(n => n.id));
  const edgeIds = new Set(edges.map(e => e.id)); const restoredEdges = [];
  for (const edge of fragment.edges) {
    if (typeof edge?.id !== 'string' || !ids.has(edge.source) || !ids.has(edge.target)
      || (!nativeIds.has(edge.source) && !nativeIds.has(edge.target))) throw new Error('恢复连线必须关联已有3D节点。');
    if (!edgeIds.has(edge.id)) { restoredEdges.push(structuredClone(edge)); edgeIds.add(edge.id); }
  }
  return { nodes: [...nodes, ...added], edges: [...edges, ...restoredEdges], addedNodeIds: added.map(n => n.id), addedEdgeIds: restoredEdges.map(e => e.id) };
}
