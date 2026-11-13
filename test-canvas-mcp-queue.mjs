import assert from 'node:assert/strict';
import { generateNodeForMcp, nodeSummary, registerCanvasMcp, waitForNodeForMcp } from './src/canvas-mcp.js';

const fastWait = async (read, timeoutMs = 1000, intervalMs = 1) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('test wait timeout');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

function fixture({ paused = false, terminal = null, delay = 5 } = {}) {
  const node = { id: 'g1', type: 'generator', position: { x: 0, y: 0 }, data: { title: '测试', status: 'idle', progress: 0, promptId: null, queueJobId: null } };
  const result = { id: 'm1', type: 'media', position: { x: 400, y: 0 }, data: { title: '结果', status: 'done', kind: 'video', sourcePromptId: 'prompt-1' } };
  const latest = { current: {
    nodesRef: { current: [node, result] },
    edgesRef: { current: [] },
    submissions: 0,
    actions: { generateNode: async () => {
      latest.current.submissions += 1;
      Object.assign(node.data, { status: 'queued', queueJobId: 'job-1', stage: paused ? '队列已暂停' : 'GPU 忙，等待调度' });
      if (terminal) setTimeout(() => {
        Object.assign(node.data, terminal === 'done'
          ? { status: 'done', progress: 100, promptId: 'prompt-1', stage: '完成' }
          : { status: terminal, error: terminal === 'error' ? '注入失败' : null });
        if (terminal === 'done') latest.current.edgesRef.current.push({ source: 'g1', target: 'm1', targetHandle: 'preview' });
      }, delay);
    } },
  } };
  return { latest, node };
}

for (const paused of [true, false]) {
  const { latest } = fixture({ paused, delay: 35000 });
  const submitted = await generateNodeForMcp(latest, { nodeId: 'g1', wait: false }, fastWait);
  assert.equal(submitted.node.queueJobId, 'job-1');
  assert.equal(submitted.node.status, 'queued');
  assert.equal(submitted.node.promptId, null, '排队成功不依赖 GPU 已分配 promptId');
}

{
  const { latest } = fixture({ terminal: 'done' });
  const completed = await generateNodeForMcp(latest, { nodeId: 'g1', wait: true, timeoutMs: 1000 }, fastWait);
  assert.equal(completed.node.status, 'done');
  assert.equal(completed.resultNode.id, 'm1');
  assert.equal(latest.current.submissions, 1);
}

{
  const { latest } = fixture({ terminal: 'error' });
  await assert.rejects(generateNodeForMcp(latest, { nodeId: 'g1', wait: true, timeoutMs: 1000 }, fastWait), /注入失败/);
  assert.equal(latest.current.submissions, 1, '失败返回不能触发重复提交');
}

{
  const { latest, node } = fixture();
  Object.assign(node.data, { status: 'queued', queueJobId: 'job-existing', promptId: null });
  setTimeout(() => Object.assign(node.data, { status: 'cancelled', stage: '已取消' }), 5);
  const waited = await waitForNodeForMcp(latest, { nodeId: 'g1', timeoutMs: 1000 }, fastWait);
  assert.equal(waited.node.status, 'cancelled');
  assert.equal(waited.pending, false);
  assert.equal(latest.current.submissions, 0, '只读等待不能重新提交');
}

{
  const { latest, node } = fixture();
  Object.assign(node.data, { status: 'running', queueJobId: 'job-existing', promptId: 'prompt-1', progress: 40 });
  const pending = await waitForNodeForMcp(latest, { nodeId: 'g1', timeoutMs: 20 }, fastWait);
  assert.equal(pending.pending, true);
  assert.equal(pending.node.status, 'running');
  assert.equal(latest.current.submissions, 0, '超时等待不能重新提交');
}

{
  const summary = nodeSummary({
    id: 'image-1', type: 'media', position: { x: 1, y: 2 },
    data: { title: '成品', kind: 'image', name: 'H3_Image_0001.png', filename: 'H3_Image_0001.png', subfolder: 'image', type: 'output', url: '/api/comfy/view?filename=H3_Image_0001.png&subfolder=image&type=output', output: true, prompt: '不要放进默认摘要的长提示词' },
  }, false);
  assert.equal(summary.media.filename, 'H3_Image_0001.png');
  assert.equal(summary.media.subfolder, 'image');
  assert.equal(summary.media.type, 'output');
  assert.match(summary.media.url, /filename=H3_Image_0001\.png/);
  assert.equal(summary.prompt, undefined);
  assert.equal(summary.hasMedia, true);
  const asset = nodeSummary({ id: 'asset-1', type: 'media', position: { x: 0, y: 0 }, data: { title: '素材', kind: 'image', assetPath: 'assets/' + 'a'.repeat(64) + '.png', url: 'blob:local' } });
  assert.equal(asset.media.assetPath, 'assets/' + 'a'.repeat(64) + '.png');
  assert.equal(asset.media.url, undefined);
}

{
  const node = { id: 'g1', type: 'generator', position: { x: 0, y: 0 }, data: { title: '生成', status: 'running', queueJobId: 'job-1' } };
  let cancelled = 0;
  const latest = { current: { nodesRef: { current: [node] }, edgesRef: { current: [] }, readOnly: false, actions: {
    cancelNode: async (id) => { cancelled += 1; assert.equal(id, 'g1'); node.data.status = 'cancelled'; },
    persistProject: async () => {},
  } } };
  const registered = [];
  const stop = registerCanvasMcp(latest, { context: { registerTool(tool) { registered.push(tool); } }, startPage: () => () => {} });
  try {
    const tool = registered.find((item) => item.name === 'canvas_cancel_node');
    const result = JSON.parse(await tool.execute({ nodeId: 'g1' }));
    assert.equal(result.ok, true);
    assert.equal(result.cancelled, true);
    assert.equal(result.node.status, 'cancelled');
    assert.equal(cancelled, 1);
    latest.current.readOnly = true;
    const denied = JSON.parse(await tool.execute({ nodeId: 'g1' }));
    assert.equal(denied.ok, false);
    assert.equal(cancelled, 1, '只读页面不能取消');
  } finally { stop(); }
}

console.log('CANVAS_MCP_QUEUE_OK paused=true gpuBusy=true promptless=true terminal=true noDuplicate=true');
