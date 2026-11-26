import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canDeleteModel,
  canDownloadOrUpdateModel,
  filterAndSortModels,
  formatModelBytes,
  recommendationMeta,
  summarizeModels,
  usageTierMeta,
} from './src/model-manager.js';

const SAMPLE = [
  {
    path: 'diffusion_models/h3_video.safetensors',
    name: 'h3_video.safetensors',
    title: 'MiniMax H3 视频主模型',
    group: '扩散主模型',
    installed: true,
    actualBytes: 20 * 1024 ** 3,
    expectedBytes: 20 * 1024 ** 3,
    locked: true,
    usageTier: 'high',
    usage30d: 18,
    updateAvailable: true,
    hasDownloadUrl: true,
    status: 'update_available',
    recommendation: 'locked_update_held',
    license: 'MiniMax H3 Community License',
  },
  {
    path: 'diffusion_models/old_unused.safetensors',
    name: 'old_unused.safetensors',
    title: '闲置旧模型',
    group: '扩散主模型',
    installed: true,
    actualBytes: 8 * 1024 ** 3,
    expectedBytes: 8 * 1024 ** 3,
    locked: false,
    usageTier: 'idle',
    usage30d: 0,
    updateAvailable: false,
    hasDownloadUrl: false,
    status: 'installed',
    recommendation: 'recommend_cleanup',
    license: 'Apache-2.0',
  },
  {
    path: 'diffusion_models/seedvr2_3b.safetensors',
    name: 'seedvr2_3b.safetensors',
    title: 'SeedVR2 3B',
    group: '高清与放大模型',
    installed: false,
    actualBytes: 0,
    expectedBytes: 3 * 1024 ** 3,
    locked: false,
    usageTier: 'idle',
    usage30d: 0,
    updateAvailable: false,
    hasDownloadUrl: true,
    status: 'not_installed',
    recommendation: 'available',
    license: 'Apache-2.0',
  },
];

test('formatModelBytes and labels follow user-facing usage and lock rules', () => {
  assert.equal(formatModelBytes(0), '0 B');
  assert.equal(formatModelBytes(512 * 1024 ** 2), '512.0 MB');
  assert.equal(formatModelBytes(2 * 1024 ** 3), '2.00 GB');
  assert.equal(usageTierMeta('high', 18, true).label, '高频使用');
  assert.equal(usageTierMeta('normal', 3, true).label, '正常使用');
  assert.equal(usageTierMeta('idle', 0, true).label, '长期闲置');
  assert.equal(usageTierMeta('idle', 0, false).label, '未下载');
  assert.match(recommendationMeta('locked_update_held').label, /已锁定/);
});

test('lock prevents both delete and update actions', () => {
  const lockedHot = SAMPLE[0];
  const unlockedIdle = SAMPLE[1];
  const missingDownloadable = SAMPLE[2];

  assert.equal(canDeleteModel(lockedHot), false);
  assert.equal(canDownloadOrUpdateModel(lockedHot), false);

  assert.equal(canDeleteModel(unlockedIdle), true);
  assert.equal(canDownloadOrUpdateModel(unlockedIdle), false);

  assert.equal(canDeleteModel(missingDownloadable), false);
  assert.equal(canDownloadOrUpdateModel(missingDownloadable), true);
});

test('summarizeModels and filterAndSortModels handle idle cleanup and search', () => {
  const summary = summarizeModels(SAMPLE);
  assert.equal(summary.totalInstalledCount, 2);
  assert.equal(summary.lockedCount, 1);
  assert.equal(summary.idleReclaimableCount, 1);
  assert.equal(summary.idleReclaimableBytes, 8 * 1024 ** 3);

  const idleOnly = filterAndSortModels(SAMPLE, { filter: 'idle' });
  assert.deepEqual(idleOnly.map((m) => m.name), ['old_unused.safetensors']);

  const byUsageAsc = filterAndSortModels(SAMPLE, { sort: 'usage_asc' });
  assert.equal(byUsageAsc[0].name, 'old_unused.safetensors');
  assert.equal(byUsageAsc[2].name, 'seedvr2_3b.safetensors');

  const queryHit = filterAndSortModels(SAMPLE, { query: 'SeedVR2' });
  assert.deepEqual(queryHit.map((m) => m.name), ['seedvr2_3b.safetensors']);
});
