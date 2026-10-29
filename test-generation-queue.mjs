import assert from 'node:assert/strict';
import { comfyExternalAsset, queueJobAction, queueOwnsCompletion, queueOwnsStage, takeOutputIdentity } from './src/generation-queue.js';

const node = (data = {}) => ({ id: 'generator-1', type: 'generator', data: { status: 'idle', progress: 0, ...data } });
const job = (data = {}) => ({ id: 'job-1', projectId: 'project-1', nodeId: 'generator-1', status: 'queued', progress: 0, comfyPromptId: null, ...data });

{
  assert.equal(queueOwnsCompletion(node({ promptId: 'prompt-direct' })), false);
  assert.equal(queueOwnsStage(node({ promptId: 'prompt-direct', mode: 'outfitEdit' })), false);
  assert.equal(queueOwnsCompletion(node({ queueJobId: 'job-video', promptId: 'prompt-video' })), true);
  assert.equal(queueOwnsStage(node({ queueJobId: 'job-video', mode: 'video' })), false);
  assert.equal(queueOwnsStage(node({ queueJobId: 'job-outfit', mode: 'outfitEdit', promptId: 'prompt-stage' })), true);
}

{
  const action = queueJobAction(node(), job());
  assert.equal(action.type, 'patch');
  assert.equal(action.patch.queueJobId, 'job-1');
  assert.equal(action.patch.status, 'queued');
}

{
  const action = queueJobAction(node({ queueJobId: 'job-1', status: 'queued' }), job({ status: 'running', comfyPromptId: 'prompt-1' }));
  assert.equal(action.patch.status, 'running');
  assert.equal(action.patch.promptId, 'prompt-1');
}

{
  const detailed = node({ queueJobId: 'job-1', promptId: 'prompt-1', status: 'running', progress: 63, stage: '基础采样 5/8 步' });
  assert.equal(queueJobAction(detailed, job({ status: 'running', comfyPromptId: 'prompt-1' })), null, 'empty polls preserve detailed progress');
  assert.equal(queueJobAction(detailed, job({ status: 'running', progress: 40, comfyPromptId: 'prompt-1' })), null, 'lower backend progress cannot move the node backwards');
  const progressed = queueJobAction(detailed, job({ status: 'running', progress: 70, comfyPromptId: 'prompt-1' }));
  assert.equal(progressed.patch.progress, 70, 'newer backend progress is applied');
}

{
  assert.equal(queueJobAction(node({ queueJobId: 'job-new', status: 'running' }), job({ status: 'done', comfyPromptId: 'prompt-old', history: {} })), null, 'older jobs cannot overwrite a newer run');
  assert.equal(queueJobAction(node(), job({ status: 'done', comfyPromptId: 'prompt-old', history: {} })), null, 'an unrelated terminal snapshot is not adopted');
  assert.equal(queueJobAction(node({ queueJobId: 'job-1', promptId: 'prompt-1', status: 'done' }), job({ status: 'running', comfyPromptId: 'prompt-1' })), null, 'late active events cannot resurrect a finished run');
}

{
  const history = { status: { completed: true }, outputs: {} };
  const action = queueJobAction(node({ queueJobId: 'job-1', status: 'finishing' }), job({ status: 'done', progress: 100, comfyPromptId: 'prompt-1', history }));
  assert.deepEqual(action, { type: 'complete', promptId: 'prompt-1', history });
}

{
  const failed = queueJobAction(node({ queueJobId: 'job-1', status: 'running' }), job({ status: 'error', error: { message: '显存不足' } }));
  assert.equal(failed.patch.status, 'error');
  assert.equal(failed.patch.error, '显存不足');
  const cancelled = queueJobAction(node({ queueJobId: 'job-1', status: 'running', progress: 50 }), job({ status: 'cancelled' }));
  assert.equal(cancelled.patch.status, 'cancelled');
  assert.equal(cancelled.patch.progress, 0);
}

{
  const output = { filename: '中文 结果.png', subfolder: 'shots/a', type: 'output' };
  const identity = takeOutputIdentity({ projectId: 'prj_1', shotId: 's1', jobId: 'job-1', attempt: 2, promptId: 'prompt-1', output });
  assert.equal(identity, '["prj_1","s1","job-1",2,"prompt-1","中文 结果.png","shots/a","output"]');
  assert.equal(comfyExternalAsset(output), 'comfy://view?filename=%E4%B8%AD%E6%96%87+%E7%BB%93%E6%9E%9C.png&subfolder=shots%2Fa&type=output');
}

console.log('GENERATION_QUEUE_STATE_OK stale=false progressRegression=false terminal=true outputIdentity=true');
