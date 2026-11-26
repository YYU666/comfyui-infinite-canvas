import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCapabilityCards,
  canDeleteModel,
  canDownloadOrUpdateModel,
  filterAndSortCards,
  filterAndSortModels,
  formatModelBytes,
  recommendationMeta,
  summarizeModels,
  usageTierMeta,
} from './src/model-manager.js';

const SAMPLE = [
  {
    path: 'diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    title: 'MiniMax H3 全能参考视频主模型 (INT8)',
    category: 'diffusion_models',
    group: '扩散主模型',
    installed: true,
    actualBytes: 20 * 1024 ** 3,
    expectedBytes: 20 * 1024 ** 3,
    locked: false,
    usageTier: 'high',
    usage30d: 18,
    updateAvailable: false,
    hasDownloadUrl: true,
    status: 'installed',
    recommendation: 'keep',
    license: 'MiniMax H3 Community License',
  },
  {
    path: 'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
    name: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
    title: 'Qwen3-VL 32B 多模态编码器 (INT8)',
    category: 'text_encoders',
    group: '文本与多模态编码器',
    installed: true,
    actualBytes: 25 * 1024 ** 3,
    expectedBytes: 25 * 1024 ** 3,
    locked: false,
    usageTier: 'idle',
    usage30d: 0,
    updateAvailable: false,
    hasDownloadUrl: true,
    status: 'installed',
    recommendation: 'recommend_cleanup',
    license: 'MiniMax H3 Community License',
  },
  {
    path: 'diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors',
    name: 'minimax_h3_image_pruned_int8_convrot.safetensors',
    title: 'MiniMax H3-Image 文生图与编辑 (INT8)',
    category: 'diffusion_models',
    group: '扩散主模型',
    installed: true,
    actualBytes: 19 * 1024 ** 3,
    expectedBytes: 19 * 1024 ** 3,
    locked: false,
    usageTier: 'idle',
    usage30d: 0,
    updateAvailable: false,
    hasDownloadUrl: true,
    status: 'installed',
    recommendation: 'recommend_cleanup',
    license: 'MiniMax-H3-Image Community License',
  },
  {
    path: 'diffusion_models/seedvr2_3b_int8_convrot.safetensors',
    name: 'seedvr2_3b_int8_convrot.safetensors',
    title: 'SeedVR2 3B',
    category: 'diffusion_models',
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

test('capability cards aggregate models and protect shared encoders when deleting one capability', () => {
  const cards = buildCapabilityCards(SAMPLE);
  const h3Video = cards.find((c) => c.id === 'h3_video');
  const h3Image = cards.find((c) => c.id === 'h3_image');
  const seedvr = cards.find((c) => c.id === 'seedvr2_upscale');

  assert.ok(h3Video && h3Image && seedvr);
  assert.equal(h3Video.category, 'video');
  assert.equal(h3Video.usageTier, 'high');
  assert.equal(h3Image.category, 'image');
  assert.equal(seedvr.installed, false);

  // qwen3vl_32b_minimax_h3_int8_convrot is shared between h3_video and h3_image,
  // so deleting h3_image must preserve the shared encoder and only delete the exclusive unet.
  assert.equal(h3Image.sharedInstalledCount, 1);
  assert.deepEqual(
    h3Image.exclusiveDeletableFiles.map((f) => f.path),
    ['diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors'],
  );

  const onlyVideo = filterAndSortCards(cards, { category: 'video' });
  assert.deepEqual(onlyVideo.map((c) => c.id), ['h3_video']);
});

test('summarizeModels and raw file filters behave cleanly', () => {
  const lockedSample = SAMPLE.map((m, i) => (i === 0 ? { ...m, locked: true, updateAvailable: true } : m));
  assert.equal(canDeleteModel(lockedSample[0]), false);
  assert.equal(canDownloadOrUpdateModel(lockedSample[0]), false);
  assert.equal(canDeleteModel(lockedSample[2]), true);
  assert.equal(canDownloadOrUpdateModel(lockedSample[3]), true);

  const summary = summarizeModels(lockedSample);
  assert.equal(summary.totalInstalledCount, 3);
  assert.equal(summary.lockedCount, 1);

  const byUsageAsc = filterAndSortModels(lockedSample, { sort: 'usage_asc' });
  assert.equal(byUsageAsc.at(-1).name, 'seedvr2_3b_int8_convrot.safetensors');
});
