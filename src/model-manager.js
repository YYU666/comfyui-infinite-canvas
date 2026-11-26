export function formatModelBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

export function usageTierMeta(tier, usage30d = 0, installed = true) {
  if (!installed) {
    return { label: '未下载', tone: 'neutral', detail: '尚未下载到本机模型目录' };
  }
  if (tier === 'high') {
    return { label: '高频使用', tone: 'high', detail: `近 30 天使用 ${usage30d} 次` };
  }
  if (tier === 'normal') {
    return { label: '正常使用', tone: 'normal', detail: `近 30 天使用 ${usage30d} 次` };
  }
  return { label: '长期闲置', tone: 'idle', detail: '近 30 天未使用' };
}

export function recommendationMeta(recommendation) {
  return ({
    keep_locked: { label: '已锁定 · 保留当前版本', tone: 'locked' },
    locked_update_held: { label: '有新版本 · 已锁定暂不覆盖', tone: 'locked-warn' },
    recommend_update: { label: '高频/在用 · 建议更新', tone: 'update' },
    recommend_cleanup: { label: '长期闲置 · 可删除腾出空间', tone: 'cleanup' },
    keep: { label: '在用 · 保留', tone: 'normal' },
    available: { label: '可一键下载', tone: 'neutral' },
    manual: { label: '需作者页手动下载', tone: 'neutral' },
  })[recommendation] || { label: '保留', tone: 'neutral' };
}

export function canDeleteModel(item) {
  if (!item?.installed || item.locked) return false;
  return !['downloading', 'verifying'].includes(item.status);
}

export function canDownloadOrUpdateModel(item) {
  if (!item?.hasDownloadUrl || item.locked) return false;
  if (['downloading', 'verifying'].includes(item.status)) return false;
  return !item.installed || Boolean(item.updateAvailable);
}

export function summarizeModels(models = []) {
  const installed = models.filter((item) => item.installed);
  const idleUnlocked = installed.filter((item) => item.usageTier === 'idle' && !item.locked);
  return {
    totalInstalledCount: installed.length,
    totalInstalledBytes: installed.reduce((sum, item) => sum + (item.actualBytes || 0), 0),
    lockedCount: installed.filter((item) => item.locked).length,
    highCount: installed.filter((item) => item.usageTier === 'high').length,
    normalCount: installed.filter((item) => item.usageTier === 'normal').length,
    idleCount: installed.filter((item) => item.usageTier === 'idle').length,
    idleReclaimableCount: idleUnlocked.length,
    idleReclaimableBytes: idleUnlocked.reduce((sum, item) => sum + (item.actualBytes || 0), 0),
    updateAvailableCount: installed.filter((item) => item.updateAvailable).length,
    activeDownloadsCount: models.filter((item) => ['downloading', 'verifying'].includes(item.status)).length,
  };
}

const REC_WEIGHT = {
  recommend_cleanup: 0,
  recommend_update: 1,
  locked_update_held: 2,
  keep_locked: 3,
  keep: 4,
  available: 5,
  manual: 6,
};

export function filterAndSortModels(models = [], { query = '', filter = 'all', group = 'all', sort = 'size_desc' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const filtered = models.filter((item) => {
    if (filter === 'installed' && !item.installed) return false;
    if (filter === 'idle' && !(item.installed && item.usageTier === 'idle')) return false;
    if (filter === 'locked' && !item.locked) return false;
    if (filter === 'updates' && !item.updateAvailable) return false;
    if (filter === 'missing' && item.installed) return false;
    if (group !== 'all' && item.group !== group) return false;
    if (!needle) return true;
    return [item.title, item.name, item.path, item.group, item.license]
      .some((text) => String(text || '').toLowerCase().includes(needle));
  });

  const bytesOf = (item) => (item.installed ? item.actualBytes : item.expectedBytes) || 0;
  return [...filtered].sort((a, b) => {
    if (sort === 'size_desc') {
      const diff = bytesOf(b) - bytesOf(a);
      return diff || a.name.localeCompare(b.name);
    }
    if (sort === 'usage_asc') {
      if (Boolean(a.installed) !== Boolean(b.installed)) return a.installed ? -1 : 1;
      const diff = (a.usage30d || 0) - (b.usage30d || 0);
      return diff || bytesOf(b) - bytesOf(a) || a.name.localeCompare(b.name);
    }
    if (sort === 'usage_desc') {
      const diff = (b.usage30d || 0) - (a.usage30d || 0);
      return diff || bytesOf(b) - bytesOf(a) || a.name.localeCompare(b.name);
    }
    if (sort === 'recommendation') {
      const wa = REC_WEIGHT[a.recommendation] ?? 99;
      const wb = REC_WEIGHT[b.recommendation] ?? 99;
      return wa - wb || bytesOf(b) - bytesOf(a) || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });
}
