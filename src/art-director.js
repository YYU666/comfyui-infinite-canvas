export const ART_PORTS = ['artwork', 'reference1', 'reference2', 'reference3'];
export const REFERENCE_PURPOSES = ['构图', '明暗', '配色', '光照', '材质', '身份', '比例'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}必须为 1–${max} 字文本。`); return value; };
const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function validateAnalysis(value, version) {
  if (!object(value) || value.schemaVersion !== 1 || value.sourceVersion !== version) throw new Error('解析格式或原图版本不匹配，请从当前节点下载 JSON 模板。');
  const result = { schemaVersion: 1, sourceVersion: version, summary: text(value.summary, '总结'), strengths: text(value.strengths, '保留优点'), limitations: text(value.limitations, '限制'), issues: [], guides: [] };
  if (!Array.isArray(value.issues) || value.issues.length > 5 || !Array.isArray(value.guides) || value.guides.length > 20) throw new Error('最多 5 条建议、20 条辅助线。');
  const ids = new Set();
  for (const issue of value.issues) {
    if (!object(issue) || typeof issue.id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(issue.id) || ids.has(issue.id) || !['高', '中', '低'].includes(issue.priority) || !['可见事实', '模型估计', '审美建议'].includes(issue.evidence)) throw new Error('建议编号、优先级或依据无效。');
    if (!Array.isArray(issue.box) || issue.box.length !== 4 || !issue.box.every(unit) || issue.box[2] <= 0 || issue.box[3] <= 0 || issue.box[0] + issue.box[2] > 1.000001 || issue.box[1] + issue.box[3] > 1.000001) throw new Error('局部框必须使用原图归一化坐标 [x,y,w,h]。');
    const clean = { id: issue.id, priority: issue.priority, evidence: issue.evidence, box: [...issue.box] };
    for (const key of ['observation', 'impact', 'action', 'preserve', 'uncertainty']) clean[key] = text(issue[key], key);
    if ('hidden' in issue) { if (typeof issue.hidden !== 'boolean') throw new Error('编号区域显示状态必须为布尔值。'); clean.hidden = issue.hidden; }
    result.issues.push(clean); ids.add(issue.id);
  }
  const guideIds = new Set();
  for (const guide of value.guides) {
    if (!object(guide) || typeof guide.id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(guide.id) || guideIds.has(guide.id) || !['rect', 'line'].includes(guide.kind) || !Array.isArray(guide.points) || guide.points.length !== 2 || !guide.points.every(p => Array.isArray(p) && p.length === 2 && p.every(unit)) || (guide.issueId && !ids.has(guide.issueId))) throw new Error('辅助线坐标或关联建议无效。');
    if (guide.kind === 'rect' && (guide.points[1][0] <= guide.points[0][0] || guide.points[1][1] <= guide.points[0][1])) throw new Error('辅助框终点必须在起点右下方。');
    if ('hidden' in guide && typeof guide.hidden !== 'boolean') throw new Error('辅助线显示状态必须为布尔值。');
    guideIds.add(guide.id); result.guides.push({ id: guide.id, kind: guide.kind, points: guide.points.map(p => [...p]), label: text(guide.label, '辅助线标签', 100), issueId: guide.issueId || null, hidden: guide.hidden === true });
  }
  return result;
}
export function artDirectorSnapshot(id, nodes, edges) {
  const node = nodes.find(n => n.id === id);
  if (node?.type !== 'artDirector') throw new Error('找不到电子主美节点。');
  const refs = ART_PORTS.map(slot => {
    const edge = edges.find(e => e.target === id && e.targetHandle === slot);
    if (!edge) return null;
    const source = nodes.find(n => n.id === edge.source);
    if (source?.type !== 'media' || source.data.kind !== 'image' || source.data.mediaRole === 'mask' || (!source.data.url && !source.data.assetPath)) throw new Error('请连接已保存的图片素材。');
    return { ...source, data: { ...source.data, slot, purpose: node.data.referencePurposes?.[slot] || '配色' } };
  }).filter(Boolean);
  const artwork = refs.find(r => r.data.slot === 'artwork');
  if (!artwork) throw new Error('请连接作品图片。');
  const signature = JSON.stringify([1, refs.map(r => [r.id, r.data.slot, r.data.assetPath || r.data.url, r.data.slot === 'artwork' ? '' : r.data.purpose]), node.data.brief || '', node.data.preserve || '']);
  return { node, artwork, refs, signature };
}
export function moveGuide(guide, dx, dy) {
  const xs = guide.points.map(p => p[0]), ys = guide.points.map(p => p[1]);
  dx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), dx)); dy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), dy));
  return { ...guide, points: guide.points.map(([x, y]) => [x + dx, y + dy]) };
}
export function demoAnalysis(sourceVersion) {
  return { schemaVersion: 1, sourceVersion, summary: '示例图解：演示编号、局部与辅助线。未进行模型视觉审查。', strengths: '原图完整保留；以下文字与位置是演示占位，不代表作品存在问题。', limitations: '示例不会识别图像语义。灰度、直方图与采色由本机实际像素计算。', issues: [{ id: 'sample1', priority: '中', evidence: '审美建议', box: [0.3, 0.25, 0.4, 0.5], observation: '示例观察区域（请按真实作品替换）。', impact: '演示如何把建议定位到图面；没有自动判定此处有问题。', action: '先选中并移动辅助框，再导出；真实审图可导入 Work 生成的结构化 JSON。', preserve: '保留原图的构图、身份、配色与风格。', uncertainty: '未调用云端视觉模型，本建议仅作操作示例。' }], guides: [{ id: 'sampleBox', kind: 'rect', points: [[0.3, 0.25], [0.7, 0.75]], label: '1 · 示例区域', issueId: 'sample1', hidden: false }, { id: 'sampleLine', kind: 'line', points: [[0.15, 0.7], [0.85, 0.7]], label: '候选线（示例）', issueId: null, hidden: false }] };
}
export function assertArtWritable({ readOnly, switching, signal, currentVersion, sourceVersion }) {
  signal?.throwIfAborted();
  if (readOnly || switching) throw new Error('当前画布不可编辑。');
  if (currentVersion !== sourceVersion) throw new Error('输入、参考或目标已改变，请重新分析。');
}
export function guideGeometry(analysis) {
  return { ...analysis, issues: analysis.issues.map(issue => {
    const guide = analysis.guides.find(g => g.kind === 'rect' && g.issueId === issue.id);
    if (!guide) return issue;
    const [[x,y],[xx,yy]] = guide.points;
    return { ...issue, box: [x,y,xx-x,yy-y], ...(guide.hidden || issue.hidden !== undefined ? {hidden:guide.hidden} : {}) };
  }) };
}
// Never remove immutable exports. A stale processor can only mark media it owns.
export function invalidateArtOutputs(nodes, edges) {
  const patches = new Map(), staleOwners = new Map();
  for (const node of nodes) {
    if (node.type !== 'artDirector' || !node.data.analysis) continue;
    let signature; try { signature = artDirectorSnapshot(node.id,nodes,edges).signature; } catch { signature = null; }
    if (node.data.analysis.sourceVersion !== signature) {
      patches.set(node.id,{analysis:null,boardAssetPath:null,boardSignature:null,status:'idle',stale:true});
      staleOwners.set(node.id,'输入、参考或目标已改变');
    } else if (node.data.boardResultId && node.data.boardSignature !== JSON.stringify([signature,node.data.analysis])) {
      staleOwners.set(node.id,'标注已改变，等待重新输出');
    }
  }
  if (!patches.size && !staleOwners.size) return nodes;
  let changed = false;
  const next = nodes.map(node => {
    const patch = patches.get(node.id);
    if (patch) { changed = true; return {...node,data:{...node.data,...patch}}; }
    const owner = node.data.sourceArtDirectorId;
    const reason = node.type === 'media' && staleOwners.get(owner);
    if (reason && (!node.data.artDirectorStale || node.data.artDirectorStaleReason !== reason)) { changed = true; return {...node,data:{...node.data,artDirectorStale:true,artDirectorStaleReason:reason}}; }
    return node;
  });
  return changed ? next : nodes;
}
export function removeArtGuide(analysis, id) {
  const guide = analysis.guides.find(g => g.id === id);
  return { ...analysis, guides: analysis.guides.filter(g => g.id !== id), issues: analysis.issues.map(issue => guide?.kind === 'rect' && guide.issueId === issue.id ? {...issue, hidden:true} : issue) };
}
