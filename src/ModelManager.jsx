import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, Check, ChevronDown, ChevronRight,
  HardDrive, Layers, LayoutGrid, List, LoaderCircle, Lock, LockOpen,
  RefreshCw, Search, ShieldCheck, Trash2, X,
} from 'lucide-react';
import ModelCardIllustration from './ModelCardIllustration';
import {
  CAPABILITY_CATEGORIES, buildCapabilityCards, canDeleteModel,
  canDownloadOrUpdateModel, filterAndSortCards, filterAndSortModels,
  formatModelBytes, recommendationMeta, summarizeModels, usageTierMeta,
} from './model-manager';
import {
  cancelModelDownload, deleteInstalledModel, downloadModelUpdate,
  getModelsSnapshot, lockAllInstalledModels, setModelLock, verifyInstalledModel,
} from './model-manager-client';
import './model-manager.css';

const STATUS_FILTERS = [
  ['all', '全部状态'],
  ['installed', '已安装可用'],
  ['idle', '闲置可清理'],
  ['locked', '已锁定保护'],
  ['updates', '有可用更新'],
  ['missing', '未下载'],
];

const formatShortDate = (value) => {
  if (!value) return '尚无使用记录';
  try {
    return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return '—';
  }
};

export default function ModelManager() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [viewMode, setViewMode] = useState('cards'); // 'cards' | 'files'
  const [category, setCategory] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState('size_desc');
  const [query, setQuery] = useState('');
  const [expandedCards, setExpandedCards] = useState(() => new Set());
  const [confirmKey, setConfirmKey] = useState('');

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) { setLoading(true); setError(''); }
    try {
      const data = await getModelsSnapshot();
      setSnapshot(data);
    } catch (err) {
      if (!silent) setError(err.message || '读取本地模型列表失败。');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setError('');
      setNotice('');
      setConfirmKey('');
      void refresh();
    };
    window.addEventListener('refmuse-open-models', onOpen);
    return () => window.removeEventListener('refmuse-open-models', onOpen);
  }, [refresh]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const activeDownloads = snapshot?.summary?.activeDownloadsCount || 0;
  useEffect(() => {
    if (!open || activeDownloads <= 0) return undefined;
    const timer = setInterval(() => { void refresh({ silent: true }); }, 1200);
    return () => clearInterval(timer);
  }, [open, activeDownloads, refresh]);

  const models = snapshot?.models || [];
  const summary = useMemo(() => snapshot?.summary || summarizeModels(models), [models, snapshot]);
  const allCards = useMemo(() => buildCapabilityCards(models), [models]);

  const categoryCounts = useMemo(() => {
    const counts = { all: allCards.length };
    for (const card of allCards) {
      counts[card.category] = (counts[card.category] || 0) + 1;
    }
    return counts;
  }, [allCards]);

  const visibleCards = useMemo(
    () => filterAndSortCards(allCards, { query, category, statusFilter, sort }),
    [allCards, query, category, statusFilter, sort],
  );

  const visibleRawFiles = useMemo(
    () => filterAndSortModels(models, { query, filter: statusFilter, sort }),
    [models, query, statusFilter, sort],
  );

  if (!open) return null;

  const toggleExpand = (cardId) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };

  const runAction = async (key, work, successText) => {
    setBusyKey(key);
    setError('');
    setNotice('');
    try {
      const res = await work();
      if (res?.snapshot) setSnapshot(res.snapshot);
      else await refresh({ silent: true });
      if (successText) {
        setNotice(typeof successText === 'function' ? successText(res) : successText);
      }
    } catch (err) {
      setError(err.message || '操作失败，请稍后重试。');
    } finally {
      setBusyKey('');
    }
  };

  const lockAll = async () => {
    setBulkBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await lockAllInstalledModels();
      setSnapshot(result);
      setNotice(`已锁定所有本地已安装模型（新增锁定 ${result.newlyLockedCount || 0} 项）。`);
    } catch (err) {
      setError(err.message || '批量锁定失败。');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleCardLockToggle = (card) => {
    const targetLock = !card.locked;
    const targets = card.files.filter((f) => f.installed && f.locked !== targetLock);
    if (!targets.length) return;
    void runAction(
      card.id,
      async () => {
        let last = null;
        for (const f of targets) {
          last = await setModelLock(f.path, targetLock);
        }
        return last;
      },
      targetLock
        ? `已锁定「${card.title}」（含 ${targets.length} 个已装文件），禁止误删与覆盖。`
        : `已解锁「${card.title}」。`,
    );
  };

  const handleCardDownload = (card) => {
    const targets = card.downloadableFiles;
    if (!targets.length) return;
    void runAction(
      card.id,
      async () => {
        let last = null;
        for (const f of targets) {
          last = await downloadModelUpdate(f.path);
        }
        return last;
      },
      `已开始下载「${card.title}」所需文件（共 ${targets.length} 项），完成后自动 SHA-256 校验。`,
    );
  };

  const handleCardDelete = (card) => {
    const targets = card.exclusiveDeletableFiles;
    if (!targets.length) return;
    setConfirmKey('');
    void runAction(
      card.id,
      async () => {
        let freed = 0;
        let last = null;
        for (const f of targets) {
          last = await deleteInstalledModel(f.path);
          freed += last?.freedBytes || 0;
        }
        return { ...last, totalFreed: freed };
      },
      (res) => `已清理「${card.title}」的 ${targets.length} 个独占文件，释放 ${formatModelBytes(res?.totalFreed)}；共享组件保持完整。`,
    );
  };

  const totalSpacePool = (summary.totalInstalledBytes || 0) + (summary.diskFreeBytes || 0);
  const usedRatio = totalSpacePool > 0 ? Math.min(100, Math.round((summary.totalInstalledBytes / totalSpacePool) * 100)) : 0;

  return (
    <div
      className="mm-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
    >
      <section className="mm-shell" role="dialog" aria-modal="true" aria-labelledby="mm-title">
        {/* Left Navigation Rail (ComfyUI Category Browser + Refmuse Industrial) */}
        <aside className="mm-rail">
          <div className="mm-brand">
            <img src="/favicon.svg?v=refmuse" alt="" width="30" height="30" />
            <div>
              <strong id="mm-title">模型仓库</strong>
              <small>MODEL VAULT</small>
            </div>
          </div>

          <div className="mm-rail-section">
            <span className="mm-rail-label">按用途分类</span>
            <nav className="mm-cat-nav" aria-label="模型用途分类">
              {CAPABILITY_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={category === cat.id ? 'active' : ''}
                  onClick={() => { setCategory(cat.id); setViewMode('cards'); }}
                >
                  <span className="mm-cat-code">{cat.code}</span>
                  <span className="mm-cat-name">{cat.label}</span>
                  <small>{categoryCounts[cat.id] || 0}</small>
                </button>
              ))}
            </nav>
          </div>

          <div className="mm-rail-section">
            <span className="mm-rail-label">按状态与使用率筛选</span>
            <div className="mm-status-nav">
              {STATUS_FILTERS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={statusFilter === key ? 'active' : ''}
                  onClick={() => setStatusFilter(key)}
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mm-rail-bottom">
            <div className="mm-disk-meter">
              <div className="mm-disk-head">
                <span><HardDrive size={12} /> 已装模型占用</span>
                <strong>{formatModelBytes(summary.totalInstalledBytes)}</strong>
              </div>
              <div className="mm-disk-bar"><i style={{ width: `${usedRatio}%` }} /></div>
              <div className="mm-disk-sub">
                <span>闲置可清 {formatModelBytes(summary.idleReclaimableBytes)}</span>
                <span>可用 {formatModelBytes(summary.diskFreeBytes)}</span>
              </div>
            </div>
            <button
              type="button"
              className="mm-lock-all-btn"
              onClick={lockAll}
              disabled={bulkBusy || loading || !summary.totalInstalledCount}
              title="一键锁定当前电脑已装的全部模型，防止误删或被自动覆盖"
            >
              {bulkBusy ? <LoaderCircle className="spin" size={13} /> : <Lock size={13} />}
              <span>锁定全部已装 ({summary.lockedCount}/{summary.totalInstalledCount})</span>
            </button>
          </div>
        </aside>

        {/* Right Main Workspace */}
        <main className="mm-main">
          <header className="mm-topbar">
            <div className="mm-search-box">
              <Search size={14} />
              <input
                type="search"
                placeholder={viewMode === 'cards' ? '搜索功能名称、用途或模型文件…' : '搜索底层文件名、目录路径或开源协议…'}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索模型"
              />
            </div>

            <div className="mm-topbar-controls">
              <select aria-label="排序方式" value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="size_desc">占用空间从大到小</option>
                <option value="usage_asc">最少使用优先（清理）</option>
                <option value="usage_desc">高频使用优先</option>
                <option value="name">按名称排序</option>
              </select>

              <div className="mm-view-switch" role="group" aria-label="视图切换">
                <button
                  type="button"
                  className={viewMode === 'cards' ? 'active' : ''}
                  onClick={() => setViewMode('cards')}
                  title="给普通用户看的清晰能力卡片（带示意图与用途说明）"
                >
                  <LayoutGrid size={13} />
                  <span>能力卡片</span>
                </button>
                <button
                  type="button"
                  className={viewMode === 'files' ? 'active' : ''}
                  onClick={() => setViewMode('files')}
                  title="查看所有原始权重文件名与校验哈希（高级）"
                >
                  <List size={13} />
                  <span>底层文件 ({models.length})</span>
                </button>
              </div>

              <button type="button" className="mm-icon-btn" onClick={() => void refresh()} disabled={loading} title="重新扫描硬盘目录">
                <RefreshCw size={14} className={loading ? 'spin' : ''} />
              </button>
              <button type="button" className="mm-icon-btn" onClick={() => setOpen(false)} aria-label="关闭模型管理">
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="mm-policy-strip">
            <ShieldCheck size={14} />
            <span>
              <strong>ComfyUI 本体采用官方版本锁定（当前画布 {snapshot?.runtimePolicy?.workbenchVersion || '1.1.0'}）</strong>
              {` — 不滚动拉取上游不兼容改动；删除模型仅移除权重文件，已生成的作品与画布节点安全保留。`}
            </span>
          </div>

          {error && <div className="mm-alert error" role="alert"><AlertCircle size={14} /><span>{error}</span></div>}
          {notice && <div className="mm-alert success" role="status"><Check size={14} /><span>{notice}</span></div>}

          <div className="mm-content">
            {loading && !snapshot ? (
              <div className="mm-empty"><LoaderCircle className="spin" size={18} /><span>正在扫描本机模型目录并计算使用率…</span></div>
            ) : viewMode === 'cards' ? (
              !visibleCards.length ? (
                <div className="mm-empty"><span>当前分类或筛选条件下没有匹配的模型能力。</span></div>
              ) : (
                <div className="mm-card-grid">
                  {visibleCards.map((card) => {
                    const tier = usageTierMeta(card.usageTier, card.usage30d, card.installed);
                    const isBusy = busyKey === card.id;
                    const expanded = expandedCards.has(card.id);
                    const isConfirming = confirmKey === card.id;
                    const sizeBytes = card.installed ? card.actualBytes : card.expectedBytes;
                    const statusLabel = card.downloading
                      ? '正在下载'
                      : card.updateAvailable
                        ? '有更新'
                        : card.fullyInstalled
                          ? '已就绪'
                          : card.installed
                            ? `部分已装 ${card.installedCount}/${card.totalCount}`
                            : '未安装';

                    return (
                      <article
                        key={card.id}
                        className={`mm-card ${card.installed ? 'is-installed' : 'is-missing'} ${card.locked ? 'is-locked' : ''}`}
                      >
                        <div className="mm-card-media">
                          <ModelCardIllustration kind={card.illustration} specTag={card.specTag} active={card.installed} />
                          <span className={`mm-stamp ${card.fullyInstalled ? 'ready' : card.installed ? 'partial' : 'missing'}`}>
                            {statusLabel}
                          </span>
                          {card.locked && (
                            <span className="mm-lock-stamp" title="已锁定保护"><Lock size={11} /> 已锁定</span>
                          )}
                        </div>

                        <div className="mm-card-body">
                          <div className="mm-card-kicker">
                            <span>{card.categoryLabel}</span>
                            <span>{card.totalCount > 1 ? `组合 ${card.installedCount}/${card.totalCount} 权重` : '单模型权重'}</span>
                          </div>
                          <h3>{card.title}</h3>
                          <p className="mm-card-desc">{card.subtitle}</p>

                          <div className="mm-card-metrics">
                            <div>
                              <small>占用空间</small>
                              <strong>{sizeBytes ? formatModelBytes(sizeBytes) : '未知'}</strong>
                            </div>
                            <div>
                              <small>使用频率</small>
                              <strong className={`tone-${tier.tone}`}>{tier.label}{card.usage30d > 0 ? ` · ${card.usage30d}次` : ''}</strong>
                            </div>
                            <div>
                              <small>上次使用</small>
                              <strong>{formatShortDate(card.lastUsedAt)}</strong>
                            </div>
                          </div>

                          <button
                            type="button"
                            className="mm-files-toggle"
                            onClick={() => toggleExpand(card.id)}
                          >
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <Layers size={12} />
                            <span>查看底层文件明细 ({card.totalCount})</span>
                          </button>

                          {expanded && (
                            <div className="mm-card-files">
                              {card.files.map((file) => (
                                <div className="mm-mini-file" key={file.path}>
                                  <span title={file.path}>{file.name}</span>
                                  <small>{file.installed ? formatModelBytes(file.actualBytes) : `未装 (${formatModelBytes(file.expectedBytes)})`}</small>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {isConfirming ? (
                          <div className="mm-card-confirm">
                            <p>
                              将删除 <strong>{card.exclusiveDeletableFiles.length}</strong> 个独占文件并释放{' '}
                              <strong>{formatModelBytes(card.reclaimableBytes)}</strong>。
                              {card.sharedInstalledCount > 0 ? `（另 ${card.sharedInstalledCount} 个共享编码器因其他已装功能仍在使用，将自动保留）` : ''}
                            </p>
                            <div>
                              <button type="button" className="danger" disabled={isBusy} onClick={() => handleCardDelete(card)}>确认删除</button>
                              <button type="button" onClick={() => setConfirmKey('')}>取消</button>
                            </div>
                          </div>
                        ) : (
                          <footer className="mm-card-actions">
                            {card.installed && (
                              <button
                                type="button"
                                className={card.locked ? 'is-locked-btn' : ''}
                                disabled={isBusy || card.downloading}
                                onClick={() => handleCardLockToggle(card)}
                                title={card.locked ? '解锁模型' : '锁定当前版本，禁止删除与覆盖更新'}
                              >
                                {card.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                                <span>{card.locked ? '已锁定' : '锁定'}</span>
                              </button>
                            )}

                            {card.downloadableFiles.length > 0 && (
                              <button
                                type="button"
                                className="primary"
                                disabled={isBusy || card.downloading}
                                onClick={() => handleCardDownload(card)}
                              >
                                <ArrowDownToLine size={12} />
                                <span>{card.updateAvailable ? '更新版本' : card.installed ? '补齐缺失' : '一键下载'}</span>
                              </button>
                            )}

                            <button
                              type="button"
                              className="danger-outline"
                              disabled={isBusy || card.downloading || !card.exclusiveDeletableFiles.length}
                              onClick={() => setConfirmKey(card.id)}
                              title={
                                card.locked
                                  ? '已锁定，请先解锁再删除'
                                  : card.installed && !card.exclusiveDeletableFiles.length
                                    ? '包含与其他在用功能共享的文件，请先解锁对应项或切到「底层文件」单独管理'
                                    : '删除独占权重释放硬盘空间'
                              }
                            >
                              <Trash2 size={12} />
                              <span>删除</span>
                            </button>
                          </footer>
                        )}
                      </article>
                    );
                  })}
                </div>
              )
            ) : (
              /* Expert View: Raw Files List */
              !visibleRawFiles.length ? (
                <div className="mm-empty"><span>没有匹配的底层权重文件。</span></div>
              ) : (
                <div className="mm-file-table">
                  {visibleRawFiles.map((item) => {
                    const tier = usageTierMeta(item.usageTier, item.usage30d, item.installed);
                    const rec = recommendationMeta(item.recommendation);
                    const rowBusy = busyKey === item.path;
                    const downloading = ['downloading', 'verifying'].includes(item.status);
                    const sizeBytes = item.installed ? item.actualBytes : item.expectedBytes;
                    const confirming = confirmKey === item.path;

                    return (
                      <div className={`mm-file-row ${item.locked ? 'is-locked' : ''}`} key={item.path}>
                        <div className="mm-file-info">
                          <div className="mm-file-title">
                            <strong>{item.title}</strong>
                            <span className={`mm-tag tone-${tier.tone}`}>{tier.label}</span>
                            <span className={`mm-tag tone-${rec.tone}`}>{rec.label}</span>
                          </div>
                          <div className="mm-file-meta">
                            <code>{item.path}</code>
                            <span>{sizeBytes ? formatModelBytes(sizeBytes) : '未知大小'}</span>
                            <span>{tier.detail}</span>
                            <span>上次：{formatShortDate(item.lastUsedAt)}</span>
                          </div>
                          {downloading && item.download && (
                            <div className="mm-dl-progress">
                              <div className="mm-dl-track"><i style={{ width: `${item.download.percent || 4}%` }} /></div>
                              <span>{item.download.phase === 'verifying' ? '校验 SHA-256…' : `${item.download.percent || 0}%`}</span>
                            </div>
                          )}
                        </div>
                        <div className="mm-file-actions">
                          {(item.installed || item.locked) && (
                            <button
                              type="button"
                              className={item.locked ? 'is-locked-btn' : ''}
                              disabled={rowBusy || downloading}
                              onClick={() => void runAction(item.path, () => setModelLock(item.path, !item.locked), !item.locked ? `已锁定 ${item.name}` : `已解锁 ${item.name}`)}
                            >
                              {item.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                              <span>{item.locked ? '已锁定' : '锁定'}</span>
                            </button>
                          )}
                          {downloading ? (
                            <button type="button" disabled={rowBusy} onClick={() => void runAction(item.path, () => cancelModelDownload(item.path), `已取消 ${item.name}`)}>
                              <X size={12} /><span>取消</span>
                            </button>
                          ) : canDownloadOrUpdateModel(item) ? (
                            <button type="button" className="primary" disabled={rowBusy} onClick={() => void runAction(item.path, () => downloadModelUpdate(item.path), `已开始下载 ${item.name}`)}>
                              <ArrowDownToLine size={12} /><span>{item.installed ? '更新' : '下载'}</span>
                            </button>
                          ) : null}
                          {item.installed && !downloading && (
                            <button type="button" disabled={rowBusy} onClick={() => void runAction(item.path, () => verifyInstalledModel(item.path), (r) => r?.matched ? `${item.name} 校验一致` : `${item.name} 哈希与清单不一致`)}>
                              <ShieldCheck size={12} /><span>校验</span>
                            </button>
                          )}
                          {confirming ? (
                            <>
                              <button type="button" className="danger" disabled={rowBusy} onClick={() => { setConfirmKey(''); void runAction(item.path, () => deleteInstalledModel(item.path), `已删除 ${item.name}`); }}>确认</button>
                              <button type="button" onClick={() => setConfirmKey('')}>取消</button>
                            </>
                          ) : (
                            <button type="button" className="danger-outline" disabled={rowBusy || !canDeleteModel(item)} onClick={() => setConfirmKey(item.path)}>
                              <Trash2 size={12} /><span>删除</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>

          <footer className="mm-footer">
            <span>目录：<code>{summary.modelsDir || 'ComfyUI/models'}</code></span>
            <span>{viewMode === 'cards' ? `显示 ${visibleCards.length} / ${allCards.length} 项能力` : `显示 ${visibleRawFiles.length} / ${models.length} 个文件`}</span>
          </footer>
        </main>
      </section>
    </div>
  );
}
