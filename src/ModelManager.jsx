import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, Check, ChevronDown, ChevronRight,
  Copy, Cpu, HardDrive, ImagePlus, Layers, LayoutGrid, List,
  LoaderCircle, Lock, LockOpen, RefreshCw, Search, ShieldCheck, Trash2, X,
} from 'lucide-react';
import ModelCardIllustration, { ModelBrandBadge } from './ModelCardIllustration';
import {
  CAPABILITY_CATEGORIES, buildAuxiliaryComponents, buildCapabilityCards,
  canDeleteModel, canDownloadOrUpdateModel, filterAndSortCards, filterAndSortModels,
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
  ['needs_cover', '待生图封面'],
];

const formatShortDate = (value) => {
  if (!value) return '尚无使用记录';
  try {
    return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return '—';
  }
};

function CardCover({ card, statusLabel }) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [card.coverUrl]);

  const showImg = Boolean(card.coverUrl) && !imgFailed;

  return (
    <div className={`mm-card-cover ${showImg ? 'has-photo' : 'has-fallback'}`}>
      {showImg ? (
        <img
          src={card.coverUrl}
          alt={card.title}
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <ModelCardIllustration
          kind={card.illustration}
          title={card.title}
          specTag={card.specTag}
          needsCover={card.needsCover}
          active={card.installed}
        />
      )}
      <div className="mm-cover-scrim" />

      <div className="mm-cover-top">
        <ModelBrandBadge brand={card.brand} label={card.brandLabel || card.specTag} />
        <div className="mm-cover-badges">
          {card.locked && (
            <span className="mm-lock-stamp" title="已锁定保护">
              <Lock size={10} />
              <span>已锁</span>
            </span>
          )}
          <span className={`mm-stamp ${card.fullyInstalled ? 'ready' : card.installed ? 'partial' : 'missing'}`}>
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="mm-cover-bottom">
        <div className="mm-cover-kicker">
          <span>{card.categoryLabel}</span>
          {card.specTag && card.specTag !== card.categoryLabel && <span>{card.specTag}</span>}
        </div>
        <h3 title={card.title}>{card.title}</h3>
      </div>
    </div>
  );
}

export default function ModelManager() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [viewMode, setViewMode] = useState('cards'); // 'cards' | 'aux' | 'files'
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
  const auxComponents = useMemo(() => buildAuxiliaryComponents(models), [models]);

  const categoryCounts = useMemo(() => {
    const counts = { all: allCards.length };
    for (const card of allCards) {
      counts[card.category] = (counts[card.category] || 0) + 1;
    }
    return counts;
  }, [allCards]);

  const visibleCategories = useMemo(
    () => CAPABILITY_CATEGORIES.filter((cat) => cat.id !== 'other' || (categoryCounts.other || 0) > 0),
    [categoryCounts],
  );

  const loraStats = useMemo(() => {
    const loraCards = allCards.filter((c) => c.category === 'lora');
    const missing = loraCards.filter((c) => c.needsCover);
    return {
      total: loraCards.length,
      withCover: loraCards.length - missing.length,
      missingCount: missing.length,
      missingCards: missing,
    };
  }, [allCards]);

  const visibleCards = useMemo(
    () => filterAndSortCards(allCards, { query, category, statusFilter, sort }),
    [allCards, query, category, statusFilter, sort],
  );

  const visibleAux = useMemo(() => {
    const needle = String(query || '').trim().toLowerCase();
    return auxComponents.filter((item) => {
      if (statusFilter === 'installed' && !item.installed) return false;
      if (statusFilter === 'idle' && !(item.installed && item.usageTier === 'idle')) return false;
      if (statusFilter === 'locked' && !item.locked) return false;
      if (statusFilter === 'updates' && !item.updateAvailable) return false;
      if (statusFilter === 'missing' && item.installed) return false;
      if (!needle) return true;
      return [item.title, item.name, item.path, item.roleLabel, ...item.usedByWorkflows]
        .some((t) => String(t || '').toLowerCase().includes(needle));
    });
  }, [auxComponents, query, statusFilter]);

  const visibleRawFiles = useMemo(
    () => filterAndSortModels(models, { query, filter: statusFilter === 'needs_cover' ? 'all' : statusFilter, sort }),
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

  const copyMissingLoraCovers = async () => {
    if (!loraStats.missingCards.length) return;
    const lines = loraStats.missingCards.map((c) => {
      const target = c.primaryPath.replace(/\.[^.]+$/, '.jpg');
      return `${c.title}  ->  ${target}`;
    });
    const text = `待夜间本地生图补封面清单（共 ${lines.length} 个 LoRA，生成同名 .jpg/.png 放到同目录即可自动显示）：\n${lines.join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`已复制 ${lines.length} 条待生图 LoRA 清单到剪贴板，生成后放回同目录即自动显示。`);
    } catch {
      setError('未能写入剪贴板，请手动筛出「待生图封面」查看路径。');
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
        {/* Left Navigation Rail */}
        <aside className="mm-rail">
          <div className="mm-brand">
            <img src="/favicon.svg?v=refmuse" alt="Refmuse" width="32" height="32" />
            <div>
              <strong id="mm-title">模型仓库</strong>
              <small>REFMUSE VAULT</small>
            </div>
          </div>

          <div className="mm-rail-section">
            <span className="mm-rail-label">核心能力与风格</span>
            <nav className="mm-cat-nav" aria-label="模型用途分类">
              {visibleCategories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={viewMode === 'cards' && category === cat.id ? 'active' : ''}
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
            <span className="mm-rail-label">工作流底座与文件</span>
            <div className="mm-cat-nav">
              <button
                type="button"
                className={viewMode === 'aux' ? 'active' : ''}
                onClick={() => setViewMode('aux')}
                title="查看 VAE、文本编码器、视觉编码器及其对应的工作流"
              >
                <Cpu size={12} className="mm-cat-icon" />
                <span className="mm-cat-name">辅助组件 (VAE/编码)</span>
                <small>{auxComponents.length}</small>
              </button>
              <button
                type="button"
                className={viewMode === 'files' ? 'active' : ''}
                onClick={() => setViewMode('files')}
                title="查看全部原始权重文件名与校验哈希（高级）"
              >
                <List size={12} className="mm-cat-icon" />
                <span className="mm-cat-name">全部底层文件</span>
                <small>{models.length}</small>
              </button>
            </div>
          </div>

          <div className="mm-rail-section">
            <span className="mm-rail-label">状态筛选</span>
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
                placeholder={
                  viewMode === 'aux'
                    ? '搜索 VAE、编码器名称或所属工作流…'
                    : viewMode === 'cards'
                      ? '搜索模型名称、品牌、风格 LoRA 或用途…'
                      : '搜索底层文件名、目录路径或开源协议…'
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索模型"
              />
            </div>

            <div className="mm-topbar-controls">
              {viewMode !== 'aux' && (
                <select aria-label="排序方式" value={sort} onChange={(event) => setSort(event.target.value)}>
                  <option value="size_desc">占用空间从大到小</option>
                  <option value="usage_asc">最少使用优先（清理）</option>
                  <option value="usage_desc">高频使用优先</option>
                  <option value="name">按名称排序</option>
                </select>
              )}

              <div className="mm-view-switch" role="group" aria-label="视图切换">
                <button
                  type="button"
                  className={viewMode === 'cards' ? 'active' : ''}
                  onClick={() => setViewMode('cards')}
                >
                  <LayoutGrid size={13} />
                  <span>模型卡片</span>
                </button>
                <button
                  type="button"
                  className={viewMode === 'aux' ? 'active' : ''}
                  onClick={() => setViewMode('aux')}
                >
                  <Cpu size={13} />
                  <span>辅助组件 ({auxComponents.length})</span>
                </button>
                <button
                  type="button"
                  className={viewMode === 'files' ? 'active' : ''}
                  onClick={() => setViewMode('files')}
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
              {` — 不自动覆盖兼容环境；删除模型仅清理权重文件，作品与画布连线不受影响。`}
            </span>
          </div>

          {viewMode === 'cards' && category === 'lora' && loraStats.total > 0 && (
            <div className="mm-lora-banner">
              <div className="mm-lora-banner-info">
                <ImagePlus size={14} />
                <span>
                  风格/功能 LoRA 封面情况：已自动接入本机配图 <strong>{loraStats.withCover}</strong> 张
                  {loraStats.missingCount > 0 && (
                    <> · 尚缺封面 <strong>{loraStats.missingCount}</strong> 张（可夜间批量生图放到同目录自动识别）</>
                  )}
                </span>
              </div>
              {loraStats.missingCount > 0 && (
                <div className="mm-lora-banner-actions">
                  <button
                    type="button"
                    className={statusFilter === 'needs_cover' ? 'active' : ''}
                    onClick={() => setStatusFilter((prev) => (prev === 'needs_cover' ? 'all' : 'needs_cover'))}
                  >
                    {statusFilter === 'needs_cover' ? '显示全部 LoRA' : `仅看待补封面 (${loraStats.missingCount})`}
                  </button>
                  <button type="button" onClick={() => void copyMissingLoraCovers()}>
                    <Copy size={12} />
                    <span>复制待生图名单</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {error && <div className="mm-alert error" role="alert"><AlertCircle size={14} /><span>{error}</span></div>}
          {notice && <div className="mm-alert success" role="status"><Check size={14} /><span>{notice}</span></div>}

          <div className="mm-content">
            {loading && !snapshot ? (
              <div className="mm-empty"><LoaderCircle className="spin" size={18} /><span>正在扫描本机模型目录并加载封面预览…</span></div>
            ) : viewMode === 'cards' ? (
              !visibleCards.length ? (
                <div className="mm-empty"><span>当前分类或筛选条件下没有匹配的模型。</span></div>
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
                            ? `部分 ${card.installedCount}/${card.totalCount}`
                            : '未安装';

                    return (
                      <article
                        key={card.id}
                        className={`mm-card ${card.installed ? 'is-installed' : 'is-missing'} ${card.locked ? 'is-locked' : ''}`}
                      >
                        <CardCover card={card} statusLabel={statusLabel} />

                        <div className="mm-card-body">
                          <p className="mm-card-desc">{card.subtitle}</p>

                          <div className="mm-card-specbar">
                            <span className="mm-spec-size">{sizeBytes ? formatModelBytes(sizeBytes) : '未知体积'}</span>
                            <span className={`mm-spec-usage tone-${tier.tone}`}>
                              {tier.label}{card.usage30d > 0 ? ` · ${card.usage30d}次` : ''}
                            </span>
                            <button
                              type="button"
                              className="mm-files-toggle"
                              onClick={() => toggleExpand(card.id)}
                              title="展开查看底层权重路径"
                            >
                              <Layers size={11} />
                              <span>{card.totalCount} 文件</span>
                              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                          </div>

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
                              {card.sharedInstalledCount > 0 ? `（另 ${card.sharedInstalledCount} 个共享编码器因其他在用功能仍需依赖，将保留）` : ''}
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
                                title={card.locked ? '解锁模型' : '锁定当前版本，禁止误删与覆盖更新'}
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
                              className="danger-outline mm-del-btn"
                              disabled={isBusy || card.downloading || !card.exclusiveDeletableFiles.length}
                              onClick={() => setConfirmKey(card.id)}
                              title={
                                card.locked
                                  ? '已锁定，请先解锁再删除'
                                  : card.installed && !card.exclusiveDeletableFiles.length
                                    ? '与其它已装功能共享组件，请切到「辅助组件」单独管理'
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
            ) : viewMode === 'aux' ? (
              /* Dedicated Auxiliary Components Workflow-Dependency List */
              <div className="mm-aux-wrap">
                <div className="mm-aux-intro">
                  <strong>辅助组件工作流对照表（VAE 解码器 / 文本与视觉编码器）</strong>
                  <span>这些底层组件不单独作为生成模型出现，只为特定画布工作流服务。确认某个工作流不再使用后再解锁删除即可。</span>
                </div>
                {!visibleAux.length ? (
                  <div className="mm-empty"><span>没有匹配的 VAE 或编码器辅助文件。</span></div>
                ) : (
                  <div className="mm-aux-table">
                    <div className="mm-aux-thead">
                      <span>组件名称与目录</span>
                      <span>所属工作流 / 使用引擎</span>
                      <span>占用与使用率</span>
                      <span>操作</span>
                    </div>
                    {visibleAux.map((item) => {
                      const tier = usageTierMeta(item.usageTier, item.usage30d, item.installed);
                      const rowBusy = busyKey === item.path;
                      const sizeBytes = item.installed ? item.actualBytes : item.expectedBytes;
                      const confirming = confirmKey === item.path;

                      return (
                        <div className={`mm-aux-row ${item.locked ? 'is-locked' : ''} ${item.installed ? '' : 'is-missing'}`} key={item.path}>
                          <div className="mm-aux-col-name">
                            <div className="mm-aux-title-line">
                              <strong>{item.title}</strong>
                              <span className="mm-tag">{item.roleLabel}</span>
                              {item.locked && <span className="mm-tag tone-locked">已锁定</span>}
                              {!item.installed && <span className="mm-tag">未安装</span>}
                            </div>
                            <code>{item.path}</code>
                          </div>

                          <div className="mm-aux-col-workflows">
                            {item.usedByWorkflows.map((wf) => (
                              <span className="mm-wf-pill" key={wf}>{wf}</span>
                            ))}
                          </div>

                          <div className="mm-aux-col-meta">
                            <strong>{sizeBytes ? formatModelBytes(sizeBytes) : '未知大小'}</strong>
                            <span className={`mm-aux-usage tone-${tier.tone}`}>
                              {tier.label}{item.usage30d > 0 ? ` · ${item.usage30d}次` : ''}
                            </span>
                          </div>

                          <div className="mm-file-actions">
                            {(item.installed || item.locked) && (
                              <button
                                type="button"
                                className={item.locked ? 'is-locked-btn' : ''}
                                disabled={rowBusy}
                                onClick={() => void runAction(item.path, () => setModelLock(item.path, !item.locked), !item.locked ? `已锁定 ${item.name}` : `已解锁 ${item.name}`)}
                              >
                                {item.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                                <span>{item.locked ? '已锁' : '锁定'}</span>
                              </button>
                            )}
                            {item.installed && (
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={() => void runAction(item.path, () => verifyInstalledModel(item.path), (r) => r?.matched ? `${item.name} 校验一致` : `${item.name} 哈希与清单不一致`)}
                              >
                                <ShieldCheck size={12} />
                                <span>校验</span>
                              </button>
                            )}
                            {confirming ? (
                              <>
                                <button type="button" className="danger" disabled={rowBusy} onClick={() => { setConfirmKey(''); void runAction(item.path, () => deleteInstalledModel(item.path), `已删除 ${item.name}`); }}>确认</button>
                                <button type="button" onClick={() => setConfirmKey('')}>取消</button>
                              </>
                            ) : (
                              <button type="button" className="danger-outline" disabled={rowBusy || !canDeleteModel(item)} onClick={() => setConfirmKey(item.path)}>
                                <Trash2 size={12} />
                                <span>删除</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
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
            <span>
              {viewMode === 'cards'
                ? `显示 ${visibleCards.length} / ${allCards.length} 项模型（VAE/编码器已归入辅助组件表）`
                : viewMode === 'aux'
                  ? `显示 ${visibleAux.length} / ${auxComponents.length} 个辅助组件`
                  : `显示 ${visibleRawFiles.length} / ${models.length} 个底层文件`}
            </span>
          </footer>
        </main>
      </section>
    </div>
  );
}
