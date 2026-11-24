import assert from 'node:assert/strict';
import { test } from 'node:test';
import { h3CompareCandidate, h3FrameTarget, h3MediaUrl, presentH3Frame } from './src/h3-compare.js';

const clock = { count: 3, step: { num: 1, den: 24 }, end: { num: 1, den: 8 } };

test('last-frame seek lands within the last decoded frame; no synthetic frame beyond it', () => {
  const target = h3FrameTarget(clock, 2);
  assert.equal(target.pts, 2 / 24);
  assert.ok(target.seekTime > target.pts && target.seekTime < 1 / 8);
  assert.equal(h3FrameTarget(clock, 3), null);
  assert.equal(h3FrameTarget(clock, 1.5), null);
  assert.equal(h3FrameTarget({ count: 3, times: [0, .04, .1], end: { num: 1, den: 5 } }, 1).pts, .04);
});

test('ordinary videos and input assets do not offer the H3 compare action', () => {
  const item = { type: 'media', data: { kind: 'video', type: 'output', filename: 'H3_HD_Refine_1.mp4' } };
  assert.ok(h3CompareCandidate(item, 'prj_test'));
  assert.ok(!h3CompareCandidate({ ...item, data: { ...item.data, type: 'input' } }));
  assert.ok(!h3CompareCandidate({ ...item, data: { ...item.data, filename: 'generic.mp4' } }));
});

test('a legacy refine candidate always plays the hashed project asset instead of stale Comfy fields', () => {
  const filename = 'a'.repeat(64) + '.mp4';
  const assetPath = 'assets/' + filename;
  const projectId = 'prj_test';
  const kind = 'video';
  const name = 'H3_HD_Refine_00002_.mp4';
  for (const stale of [{}, { filename: 'upstream.mp4', type: 'input', subfolder: 'workbench' }]) {
    const node = { type: 'media', data: { kind, name, assetPath, ...stale } };
    const media = h3CompareCandidate(node, projectId);
    assert.deepEqual(media, { type: 'project', projectId, assetPath });
    assert.equal(h3MediaUrl(media), '/api/projects/prj_test/assets/' + filename);
    assert.equal(h3CompareCandidate({ ...node, data: { ...node.data, assetPath: '../bad.mp4' } }, projectId), null);
  }
});

class TestVideo extends EventTarget {
  pause() {}
  requestVideoFrameCallback(callback) { this.callback = callback; return 1; }
  cancelVideoFrameCallback() { this.callback = null; }
  present(pts) { this.callback(0, { mediaTime: pts }); }
}

test('seeking only completes on the requested presented PTS and can be cancelled', async () => {
  const video = new TestVideo();
  const target = h3FrameTarget(clock, 1);
  const controller = new AbortController();
  const result = presentH3Frame(video, target, controller.signal);
  video.present(0);
  assert.equal(video.currentTime, target.seekTime);
  video.present(target.pts);
  assert.equal(await result, target.pts);

  const next = new AbortController();
  const pending = presentH3Frame(video, h3FrameTarget(clock, 2), next.signal);
  next.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(video.callback, null);
});
