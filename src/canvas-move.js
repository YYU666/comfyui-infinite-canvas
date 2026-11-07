export function moveSpecifiedNodes(nodes, moves) {
  if (!Array.isArray(moves) || moves.length<1 || moves.length>30) throw new Error('指定移动必须为1至30个节点。');
  const map=new Map();
  for (const item of moves) {
    if (!item || Object.keys(item).some(k=>!['nodeId','x','y'].includes(k)) || typeof item.nodeId!=='string' || !Number.isFinite(item.x) || !Number.isFinite(item.y) || map.has(item.nodeId)) throw new Error('移动参数无效、重复或坐标非有限。');
    if (!nodes.some(n=>n.id===item.nodeId)) throw new Error('指定节点不存在。');
    map.set(item.nodeId,item);
  }
  return nodes.map(n=>map.has(n.id)?{...n,position:{x:map.get(n.id).x,y:map.get(n.id).y}}:n);
}
