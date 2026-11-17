import assert from 'node:assert/strict';
import { copyCanvasSelection, pasteCanvasSelection } from './src/canvas-clipboard.js';
import { CANVAS_SPACING, nodeLayoutSize } from './src/canvas-layout.js';

const nodes = [
  {
    id: 'media-a', type: 'media', position: { x: 100, y: 120 }, selected: true,
    data: { kind: 'image', title: '角色', refTag: '<Picture 1>', mediaStorageId: 'shared-media', url: 'blob:local', file: { excluded: true } },
  },
  {
    id: 'generator-b', type: 'generator', position: { x: 600, y: 320 }, selected: true,
    data: {
      title: '换装', prompt: '@角色 换成白色夏装', optimizedPrompt: 'Use <Picture 1> as identity.', seed: 123, status: 'done', progress: 100,
      stage: '生成完成', promptId: 'old-task', resultUrl: 'http://old-result', error: 'old-error',
      hasMedia: true, runs: [{ promptId: 'old-task' }],
    },
  },
  { id: 'note-outside', type: 'note', position: { x: 1200, y: 100 }, data: { title: '外部', text: '不复制' } },
];
const edges = [
  { id: 'inside', source: 'media-a', target: 'generator-b', sourceHandle: 'ref', targetHandle: 'guide' },
  { id: 'outside', source: 'generator-b', target: 'note-outside', sourceHandle: 'preview', targetHandle: 'references' },
];
const clipboard = copyCanvasSelection(nodes, edges);
assert.equal(clipboard.nodes.length, 2);
assert.equal(clipboard.edges.length, 1, '只复制选区内部连线');
assert.equal('file' in clipboard.nodes[0].data, false, 'File 对象不进入剪贴板快照');
assert.equal(nodes[0].data.file.excluded, true, '复制不修改原节点');

let sequence = 0;
const idFactory = (kind) => `${kind}-new-${++sequence}`;
const first = pasteCanvasSelection(clipboard, nodes, idFactory);
assert.equal(first.nodes.length, 2);
assert.equal(first.edges.length, 1);
assert.equal(first.idMap.size, 2);
assert.ok(first.nodes.every((node) => !nodes.some((old) => old.id === node.id)), '所有节点使用新 ID');
assert.ok(first.nodes.every((node) => node.selected), '只选中粘贴后的节点');
const separated = (a, b) => {
  const sa = nodeLayoutSize(a), sb = nodeLayoutSize(b);
  return a.position.x + sa.width + CANVAS_SPACING.horizontal <= b.position.x
    || b.position.x + sb.width + CANVAS_SPACING.horizontal <= a.position.x
    || a.position.y + sa.height + CANVAS_SPACING.vertical <= b.position.y
    || b.position.y + sb.height + CANVAS_SPACING.vertical <= a.position.y;
};
assert.ok(first.nodes.every(node => nodes.every(old => separated(node, old))), 'first paste clears every existing full-size card');
assert.equal(first.nodes[0].position.y, 154, 'paste fills available space to the right before starting another row');
assert.equal(first.nodes[1].position.x - first.nodes[0].position.x, 500, '保持多选节点水平相对位置');
assert.equal(first.nodes[1].position.y - first.nodes[0].position.y, 200, '保持多选节点垂直相对位置');
assert.equal(first.nodes[0].data.mediaStorageId, 'shared-media', '素材继续引用原存储记录');
assert.equal(first.nodes[0].data.title, '角色 · 副本');
assert.equal(first.nodes[0].data.refTag, '<Picture 2>', '副本使用新的稳定引用标签');
assert.equal(first.nodes[1].data.prompt, '@角色 · 副本 换成白色夏装', '内部 @ 引用同步指向素材副本');
assert.equal(first.nodes[1].data.optimizedPrompt, 'Use <Picture 2> as identity.', '结构化引用同步指向素材副本');
assert.equal(first.nodes[1].data.seed, 123, '生成参数保留');
assert.equal(first.nodes[1].data.status, 'idle');
assert.equal(first.nodes[1].data.progress, 0);
assert.equal(first.nodes[1].data.stage, '');
assert.deepEqual(first.nodes[1].data.runs, []);
for (const key of ['promptId', 'resultUrl', 'error', 'hasMedia']) assert.equal(key in first.nodes[1].data, false, `清除旧任务字段 ${key}`);
assert.equal(first.edges[0].source, first.nodes[0].id);
assert.equal(first.edges[0].target, first.nodes[1].id);
assert.equal(first.edges[0].sourceHandle, 'ref');
assert.equal(first.edges[0].targetHandle, 'guide');
assert.equal(first.edges[0].type, 'default');
assert.ok(!first.edges.some((edge) => edge.id === 'inside'));

const second = pasteCanvasSelection(clipboard, [...nodes, ...first.nodes], idFactory);
assert.ok(second.nodes.every((node) => ![...nodes, ...first.nodes].some((old) => old.id === node.id)), '连续粘贴仍生成全新 ID');
assert.ok(second.nodes.every(node => [...nodes, ...first.nodes].every(old => separated(node, old))), '连续粘贴继续避让已有副本');
assert.equal(second.nodes[1].position.x - second.nodes[0].position.x, 500);
assert.equal(second.nodes[1].position.y - second.nodes[0].position.y, 200);

const empty = pasteCanvasSelection(copyCanvasSelection([{ ...nodes[0], selected: false }], []), nodes, idFactory);
assert.deepEqual(empty.nodes, []);
assert.deepEqual(empty.edges, []);
const landscape = { id: 'landscape', type: 'generator', position: { x: 0, y: 0 }, measured: { width: 440, height: 280 }, data: { status: 'done', resultUrl: 'local', metadata: { width: 1000, height: 100 }, inlineImageOutputId: 'old-result' } };
const obstruction = { id: 'obstruction', type: 'media', position: { x: 484, y: 400 }, data: {} };
const landscapePaste = pasteCanvasSelection({ nodes: [landscape], edges: [] }, [landscape, obstruction], idFactory);
assert.ok(landscapePaste.nodes.every(node => [landscape, obstruction].every(old => separated(node, old))), 'completed short result reserves the taller idle presentation when pasted');
assert.equal(landscapePaste.nodes[0].data.inlineImageOutputId, undefined);
const backing = { id: 'backing', type: 'media', position: { x: 600, y: 0 }, data: { output: true, kind: 'image', inlineImageOwnerId: 'landscape' } };
const inlinePaste = pasteCanvasSelection({ nodes: [landscape, backing], edges: [] }, [], idFactory);
assert.equal(inlinePaste.nodes[1].data.inlineImageOwnerId, inlinePaste.nodes[0].id, 'copied inline media points to the copied owner');
const backingPaste = pasteCanvasSelection({ nodes: [backing], edges: [] }, [], idFactory);
assert.equal(backingPaste.nodes[0].data.inlineImageOwnerId, undefined, 'copying media alone cannot hide it under an unrelated original owner');
console.log('画布复制粘贴测试通过：多选、内部连线、素材引用、任务状态清理、相对布局与连续避让。');
