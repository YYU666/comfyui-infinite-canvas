import assert from 'node:assert/strict';
import { generateNodeForMcp, waitForNodeForMcp } from './src/canvas-mcp.js';

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
  assert.equal(latest.current.submissions, 0, '只读等待不能重新提交');
}

console.log('CANVAS_MCP_QUEUE_OK paused=true gpuBusy=true promptless=true terminal=true noDuplicate=true');
