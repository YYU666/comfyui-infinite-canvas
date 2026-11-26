import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, Check, Flame, HardDrive, LoaderCircle,
  Lock, LockOpen, RefreshCw, ShieldCheck, Trash2, X,
} from 'lucide-react';
import {
  canDeleteModel, canDownloadOrUpdateModel, filterAndSortModels,
  formatModelBytes, recommendationMeta, summarizeModels, usageTierMeta,
} from './model-manager';
import {
  cancelModelDownload, deleteInstalledModel, downloadModelUpdate,
  getModelsSnapshot, lockAllInstalledModels, setModelLock, verifyInstalledModel,
} from './model-manager-client';
import './model-manager.css';

const FILTERS = [
  ['all', '全部'],
  ['installed', '已下载'],
  ['idle', '长期闲置'],
  ['locked', '已锁定'],
  ['updates', '有更新'],
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
  const [busyPath, setBusyPath] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('all');
  const [group, setGroup] = useState('all');
  const [sort, setSort] = useState('size_desc');
  const [query, setQuery] = useState('');
  const [confirmDeletePath, setConfirmDeletePath] = useState('');

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
      setNotice('');
      setError('');
      setConfirmDeletePath('');
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
  const groups = useMemo(() => ['all', ...new Set(models.map((item) => item.group).filter(Boolean))], [models]);
  const visibleModels = useMemo(
    () => filterAndSortModels(models, { query, filter, group, sort }),
    [models, query, filter, group, sort],
  );

  if (!open) return null;

  const runRowAction = async (path, action, successText) => {
    setBusyPath(path);
    setError('');
    setNotice('');
    try {
      const result = await action();
      if (result?.snapshot) setSnapshot(result.snapshot);
      else await refresh({ silent: true });
      if (successText) {
        const text = typeof successText === 'function' ? successText(result) : successText;
        setNotice(text);
      }
    } catch (err) {
      setError(err.message || '操作失败，请稍后重试。');
    } finally {
      setBusyPath('');
    }
  };

  const lockAll = async () => {
    setBulkBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await lockAllInstalledModels();
      setSnapshot(result);
      setNotice(`已锁定所有本地已安装模型（本次新增锁定 ${result.newlyLockedCount || 0} 项）。`);
    } catch (err) {
      setError(err.message || '批量锁定失败。');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div
      className="model-manager-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
    >
      <section className="model-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="model-manager-title">
        <header className="model-manager-header">
          <div>
            <p className="model-manager-eyebrow">MODEL REGISTRY · USAGE & LOCK</p>
            <h2 id="model-manager-title">模型管理与使用率更新</h2>
          </div>
          <div className="model-manager-head-actions">
            <button type="button" onClick={lockAll} disabled={bulkBusy || loading || !summary.totalInstalledCount} title="一键保护所有已下载的旧模型，不被删除或自动覆盖">
              {bulkBusy ? <LoaderCircle className="spin" size={14} /> : <Lock size={14} />}
              <span>锁定全部已装模型</span>
            </button>
            <button type="button" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
              <span>刷新</span>
            </button>
            <button type="button" className="model-manager-close" aria-label="关闭模型管理" onClick={() => setOpen(false)}>
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="model-policy-banner">
          <ShieldCheck size={16} />
          <div>
            <strong>ComfyUI 本体采用官方认证版本锁定（当前画布 {snapshot?.runtimePolicy?.workbenchVersion || '1.1.0'}）</strong>
            <p>{snapshot?.runtimePolicy?.comfyPolicySummary || 'ComfyUI 本体与节点随已验证的画布版本统一发布，不在此处滚动升上游最新版。这里可放心按使用率锁定、更新或删除单个模型权重；删除权重不会影响已生成的图片、视频或 3D 成品。'}</p>
          </div>
        </div>

        <div className="model-stats-grid">
          <div className="model-stat-card">
            <span>已装模型总占用</span>
            <strong>{formatModelBytes(summary.totalInstalledBytes)}</strong>
            <small>{summary.totalInstalledCount} 个本地文件 · 磁盘可用 {formatModelBytes(summary.diskFreeBytes)}</small>
          </div>
          <div className="model-stat-card">
            <span><Flame size={13} /> 高频在用模型</span>
            <strong>{summary.highCount} 个</strong>
            <small>近 30 天使用 10 次以上 · 普通使用 {summary.normalCount} 个</small>
          </div>
          <div className="model-stat-card">
            <span><Lock size={13} /> 已锁定受保护</span>
            <strong>{summary.lockedCount} 个</strong>
            <small>禁止删除，且更新时不会静默覆盖</small>
          </div>
          <button
            type="button"
            className={`model-stat-card actionable${filter === 'idle' ? ' active' : ''}`}
            onClick={() => { setFilter('idle'); setSort('size_desc'); }}
            title="点击查看长期闲置且未锁定的可清理模型"
          >
            <span><HardDrive size={13} /> 闲置可释放空间</span>
            <strong>{formatModelBytes(summary.idleReclaimableBytes)}</strong>
            <small>{summary.idleReclaimableCount} 个未锁定闲置模型（共 {summary.idleCount} 个闲置）</small>
          </button>
        </div>

        <div className="model-toolbar">
          <div className="model-filter-pills" role="tablist" aria-label="模型筛选">
            {FILTERS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={filter === key ? 'active' : ''}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="model-toolbar-controls">
            <input
              type="search"
              placeholder="搜索模型名称、文件名或目录…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索模型"
            />
            <select aria-label="按分类筛选" value={group} onChange={(event) => setGroup(event.target.value)}>
              {groups.map((item) => <option key={item} value={item}>{item === 'all' ? '全部分类' : item}</option>)}
            </select>
            <select aria-label="排序方式" value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="size_desc">按占用空间从大到小</option>
              <option value="usage_asc">按使用率从低到高（清理优先）</option>
              <option value="usage_desc">按使用率从高到低</option>
              <option value="recommendation">按清理与更新建议</option>
            </select>
          </div>
        </div>

        {error && <div className="model-banner error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
        {notice && <div className="model-banner success" role="status"><Check size={15} /><span>{notice}</span></div>}

        <div className="model-list">
          {loading && !snapshot ? (
            <div className="model-empty"><LoaderCircle className="spin" size={20} /><span>正在扫描本地模型目录与使用率…</span></div>
          ) : !visibleModels.length ? (
            <div className="model-empty"><span>当前筛选条件下没有匹配的模型。</span></div>
          ) : visibleModels.map((item) => {
            const tier = usageTierMeta(item.usageTier, item.usage30d, item.installed);
            const rec = recommendationMeta(item.recommendation);
            const rowBusy = busyPath === item.path;
            const downloading = ['downloading', 'verifying'].includes(item.status);
            const confirmingDelete = confirmDeletePath === item.path;
            const sizeBytes = item.installed ? item.actualBytes : item.expectedBytes;

            return (
              <article className={`model-row ${item.locked ? 'is-locked' : ''} ${!item.installed ? 'is-missing' : ''}`} key={item.path}>
                <div className="model-row-main">
                  <div className="model-row-title">
                    <strong>{item.title}</strong>
                    <span className={`model-badge tone-${tier.tone}`}>{tier.label}</span>
                    <span className={`model-badge tone-${rec.tone}`}>{rec.label}</span>
                    {item.locked && <span className="model-badge tone-locked"><Lock size={11} /> 已锁定</span>}
                  </div>
                  <div className="model-row-meta">
                    <code>{item.path}</code>
                    <span>分类：{item.group}</span>
                    <span>体积：{sizeBytes ? formatModelBytes(sizeBytes) : '未知大小'}</span>
                    <span>{tier.detail}</span>
                    <span>上次使用：{formatShortDate(item.lastUsedAt)}</span>
                    <span>许可：{item.license || '待核实'}</span>
                  </div>
                  {downloading && item.download && (
                    <div className="model-download-bar" role="status">
                      <div className="model-download-track"><i style={{ width: `${item.download.percent || 4}%` }} /></div>
                      <span>
                        {item.download.phase === 'verifying'
                          ? '正在校验 SHA-256 完整性…'
                          : `下载中 ${item.download.percent || 0}% · ${formatModelBytes(item.download.bytesDownloaded)} / ${formatModelBytes(item.download.totalBytes)}`}
                      </span>
                    </div>
                  )}
                  {item.download?.phase === 'error' && item.download?.error && (
                    <p className="model-row-error">{item.download.error}</p>
                  )}
                </div>

                <div className="model-row-actions">
                  {(item.installed || item.locked) && (
                    <button
                      type="button"
                      className={item.locked ? 'btn-locked' : ''}
                      disabled={rowBusy || downloading}
                      onClick={() => void runRowAction(
                        item.path,
                        () => setModelLock(item.path, !item.locked),
                        !item.locked ? `已锁定 ${item.name}，删除与自动覆盖已禁用。` : `已解锁 ${item.name}。`,
                      )}
                      title={item.locked ? '点击解锁模型' : '锁定当前模型，防止误删或被新版覆盖'}
                    >
                      {item.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                      <span>{item.locked ? '已锁定' : '锁定'}</span>
                    </button>
                  )}

                  {downloading ? (
                    <button type="button" disabled={rowBusy} onClick={() => void runRowAction(item.path, () => cancelModelDownload(item.path), `已取消下载 ${item.name}。`)}>
                      <X size={13} /><span>取消下载</span>
                    </button>
                  ) : canDownloadOrUpdateModel(item) ? (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={rowBusy}
                      onClick={() => void runRowAction(item.path, () => downloadModelUpdate(item.path), `已开始下载 ${item.name}，完成后自动 SHA-256 校验。`)}
                    >
                      <ArrowDownToLine size={13} />
                      <span>{item.installed ? '更新版本' : '下载安装'}</span>
                    </button>
                  ) : null}

                  {item.installed && !downloading && (
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void runRowAction(
                        item.path,
                        () => verifyInstalledModel(item.path),
                        (res) => res?.matched ? `校验通过：${item.name} SHA-256 与官方锁定来源完全一致。` : `提示：${item.name} 校验哈希与当前官方清单版本不一致，可解锁后更新。`,
                      )}
                      title="计算本地 SHA-256 并比对官方清单"
                    >
                      <ShieldCheck size={13} /><span>校验</span>
                    </button>
                  )}

                  {confirmingDelete ? (
                    <div className="model-delete-confirm">
                      <span>仅删权重文件（不删作品），确认？</span>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={rowBusy}
                        onClick={() => {
                          setConfirmDeletePath('');
                          void runRowAction(
                            item.path,
                            () => deleteInstalledModel(item.path),
                            (res) => `已删除 ${item.name}，释放 ${formatModelBytes(res?.freedBytes || sizeBytes)} 空间。`,
                          );
                        }}
                      >确认删除</button>
                      <button type="button" onClick={() => setConfirmDeletePath('')}>取消</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn-danger-outline"
                      disabled={rowBusy || !canDeleteModel(item)}
                      onClick={() => setConfirmDeletePath(item.path)}
                      title={item.locked ? '模型已锁定，请先解锁再删除' : !item.installed ? '尚未安装' : '删除本地模型文件释放磁盘空间（不影响已生成作品）'}
                    >
                      <Trash2 size={13} /><span>删除</span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <footer className="model-manager-footer">
          <span>目录：<code>{summary.modelsDir || 'ComfyUI/models'}</code></span>
          <span>共 {visibleModels.length} / {models.length} 项模型</span>
        </footer>
      </section>
    </div>
  );
}
