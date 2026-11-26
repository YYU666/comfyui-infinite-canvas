
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureVisibleExecution, stageVisibleExecutionPreview, getVisibleExecutionPreview, releaseVisibleExecutionPreview } from './src/visible-generation.js';

const workflow = {
  '12': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'fixture-lora', strength_model: 0.7 } },
  '17': { class_type: 'FixtureSecondSampler', inputs: { seed: 45, steps: 8, default_schedule: '二采' } },
};
for (const [direct, plan] of [[workflow, null], [null, { kind: 'test-stage', stages: [{ workflow }] }]]) {
  const execution = await captureVisibleExecution(direct, plan);
  stageVisibleExecutionPreview('fixture', execution);
  assert.deepEqual(JSON.parse(getVisibleExecutionPreview('fixture')), { workflow: direct, plan });
  releaseVisibleExecutionPreview('fixture');
  assert.equal(getVisibleExecutionPreview('fixture'), undefined);
  assert.equal(execution.record.digest, createHash('sha256').update(execution.json).digest('hex'));
  assert.equal(execution.record.bytes, Buffer.byteLength(execution.json));
}
const larger = await captureVisibleExecution({ blob: 'q'.repeat(70000) }, null);
assert.ok(larger.record.bytes > 64 * 1024);
stageVisibleExecutionPreview('large', larger);
assert.equal(getVisibleExecutionPreview('large'), undefined);
const secret = await captureVisibleExecution({ job: { inputs: { api_key: 'fixture-redacted', steps: 8 } } }, null);
stageVisibleExecutionPreview('secret', secret);
assert.match(getVisibleExecutionPreview('secret'), /隐藏/);
assert.doesNotMatch(getVisibleExecutionPreview('secret'), /fixture-redacted/);
releaseVisibleExecutionPreview('secret');
assert.equal(larger.record.digest, createHash('sha256').update(larger.json).digest('hex'));
