import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowUpCircle, Check, ExternalLink, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { applyUpdate, checkForUpdates, getUpdateStatus, getWorkbenchHealth } from './update-client';
import { getSettings } from './settings-client';
import { createUpdateCheckScheduler } from './update-check-scheduler';
import './updates.css';

const NOTIFIED_KEY = 'refmuse-update-completed';
const DISMISSED_KEY = 'refmuse-update-dismissed-versions';
const readStored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStored = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Private browsing may disable storage. */ } };
const dismissedVersions = () => { try { const value = JSON.parse(readStored(DISMISSED_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } };


export default function UpdateCenter({ projectOpen }) {
  const [dialog, setDialog] = useState(null);
  const [release, setRelease] = useState(null);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [availableNotice, setAvailableNotice] = useState(null);
  const pending = useRef(null);
  const dialogRef = useRef(null);
  const showDialog = (value) => { dialogRef.current = value; setDialog(value); };
  const applying = useRef(false);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    let active = true;
    let automatic = false;
    let settingsRevision = 0;
    let autoEpoch = 0;
    const check = async (manual = false) => {
      if (applying.current) return;
      if (manual) { setMessage(''); showDialog('checking'); }
      if (pending.current) {
        if (manual) { pending.current.manual = true; pending.current.dismissed = false; }
        return pending.current.promise;
      }
      const run = { manual, dismissed: false, epoch: autoEpoch };
      pending.current = run;
      run.promise = (async () => {
        try {
          const initial = await getUpdateStatus();
          const result = await checkForUpdates();
          if (!active || applying.current) return;
          const manualResult = run.manual && !run.dismissed;
          const autoResult = !run.manual && automatic && run.epoch === autoEpoch;
          if (!manualResult && !autoResult) return;
          if (initial.lastResult?.phase === 'success' && initial.lastResult.version?.replace(/^v/, '') === initial.currentVersion) {
            const version = initial.lastResult.version;
            if (readStored(NOTIFIED_KEY) !== version) {
              writeStored(NOTIFIED_KEY, version);
              setNotice(`已安全更新至 ${version}。`);
            }
          } else if (initial.lastResult?.phase === 'error' && initial.lastResult.message?.includes('已恢复')) {
            setNotice(initial.lastResult.message);
          }
          if (result.updateAvailable) {
            if (manualResult) {
              setRelease(result);
              setMessage(result.message || '');
              showDialog('available');
            } else if (!dismissedVersions().includes(result.version)) {
              setAvailableNotice(result);
            }
          } else {
            setAvailableNotice(null);
            if (manualResult) {
              const informative = result.status === 'no_release' || result.status === 'unavailable';
              setMessage(informative ? result.message || '尚无可用的公开 Release，请稍后再检查。' : `当前 ${result.currentVersion} 已是最新版本。`);
              showDialog(result.status === 'unavailable' ? 'error' : result.status === 'no_release' ? 'info' : 'latest');
            }
          }
        } catch (error) {
          if (active && run.manual && !run.dismissed && !applying.current) { setMessage(error.message); showDialog('error'); }
        } finally { if (pending.current === run) pending.current = null; }
      })();
      return run.promise;
    };
    const scheduler = createUpdateCheckScheduler({ check: () => check(false), isBusy: () => Boolean(pending.current || applying.current || dialogRef.current) });
    const configure = (settings) => {
      automatic = settings.updates?.autoCheck !== false;
      if (!automatic) { autoEpoch += 1; setAvailableNotice(null); setNotice(''); }
      scheduler.setEnabled(automatic);
    };
    const settingsChanged = (event) => { settingsRevision += 1; configure(event.detail || {}); };
    getSettings().then((settings) => { if (active && settingsRevision === 0) configure(settings); }).catch(() => {});
    const manual = () => check(true);
    window.addEventListener('refmuse-check-updates', manual);
    window.addEventListener('h3-settings-changed', settingsChanged);
    return () => {
      active = false;
      disposed.current = true;
      pending.current = null;
      scheduler.stop();
      window.removeEventListener('refmuse-check-updates', manual);
      window.removeEventListener('h3-settings-changed', settingsChanged);
    };
  }, []);

  const watchUpgrade = async (version, request) => {
    const target = version.replace(/^v/, '');
    while (!disposed.current && applying.current) {
      try {
        const status = await getUpdateStatus();
        if (disposed.current || !applying.current) return;
        if (status.message) setMessage(status.message);
        // A pending POST owns the outcome; a stale status must not unlock a second apply.
        if (!request.pending) {
          const failure = status.phase === 'error' ? status : status.lastResult?.phase === 'error' ? status.lastResult : null;
          const recentFailure = failure && (!failure.version || failure.version.replace(/^v/, '') === target)
            && (!failure.updatedAt || Date.parse(failure.updatedAt) >= request.startedAt - 1000);
          if (recentFailure) {
            applying.current = false;
            setMessage(failure.message || '升级失败，请查看工作台状态和运行日志。');
            showDialog('error');
            return;
          }
          if (request.uncertain && !['preparing', 'restarting'].includes(status.phase)) {
            setMessage('升级请求的响应已断开，正在核实实际状态。不会重复提交升级；请保持页面打开，必要时检查运行日志。');
          }
        }
      } catch {
        if (!disposed.current && applying.current && !request.pending) {
          setMessage('正在等待工作台恢复连接并核实升级结果，请保持页面打开。');
        }
      }
      if (!request.pending && !disposed.current && applying.current) {
        try {
          const health = await getWorkbenchHealth();
          if (!disposed.current && applying.current && health.version === target) {
            window.location.reload();
            return;
          }
        } catch { /* Restart or an ambiguous response is not proof that the mutation failed. */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };

  const upgrade = async () => {
    if (applying.current || projectOpen || !release?.canApply) return;
    applying.current = true;
    showDialog('updating');
    setMessage('正在确认项目与队列状态…');
    const request = { pending: true, uncertain: false, startedAt: Date.now() };
    // Poll progress throughout the long synchronous preparation POST as well as restart.
    void watchUpgrade(release.version, request);
    try {
      await applyUpdate(release.version);
    } catch (error) {
      if (disposed.current) return;
      if (error.status && error.code && error.code !== 'UPDATE_BUSY') {
        // A structured backend rejection is definitive; transport failure is not.
        applying.current = false;
        setMessage(error.message);
        showDialog('error');
      } else {
        request.uncertain = true;
        setMessage('升级请求的响应已断开，正在核实实际状态。不会重复提交升级；请保持页面打开。');
      }
    } finally { request.pending = false; }
  };

  const dismissVersion = (version) => {
    if (version) writeStored(DISMISSED_KEY, JSON.stringify([...new Set([...dismissedVersions(), version])]));
    setAvailableNotice(null);
  };
  const close = () => {
    if (applying.current) return;
    if (pending.current) pending.current.dismissed = true;
    if (dialogRef.current === 'available') dismissVersion(release?.version);
    showDialog(null);
  };
  return <>
    {availableNotice && !dialog && <div className="update-available-banner" role="status">
      <ArrowUpCircle size={18} /><span>发现新版本 {availableNotice.version}</span>
      <button onClick={() => { setRelease(availableNotice); setMessage(availableNotice.message || ''); showDialog('available'); }}>查看更新</button>
      <button aria-label="忽略此版本更新提示" onClick={() => dismissVersion(availableNotice.version)}><X size={15} /></button>
    </div>}
    {notice && <div className="update-success-toast" role="status"><Check size={16} /><span>{notice}</span><button aria-label="关闭更新提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {dialog && <div className="update-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-busy={dialog === 'checking' || dialog === 'updating'}>
        {!applying.current && <button className="update-close" aria-label="关闭更新窗口" onClick={close}><X size={17} /></button>}
        <span className={`update-icon ${dialog === 'error' ? 'error' : ''}`}>{dialog === 'error' ? <AlertCircle size={24} /> : dialog === 'latest' ? <Check size={24} /> : <ArrowUpCircle size={24} />}</span>
        <p className="update-eyebrow">REFMUSE · 本地安全升级</p>
        <h2 id="update-title">{dialog === 'available' ? `发现新版本 ${release?.version}` : dialog === 'checking' ? '正在检查更新' : dialog === 'updating' ? '正在安全升级' : dialog === 'latest' ? '已是最新版本' : '更新提示'}</h2>
        {(dialog === 'checking' || dialog === 'updating') && <div className="update-progress"><LoaderCircle className="spin" size={20} /><span>{message || '正在连接 GitHub Release…'}</span></div>}
        {dialog === 'available' && <>
          <p className="update-version">当前版本 {release?.currentVersion} <span>→</span> {release?.version}</p>
          {release?.notes && <pre className="update-notes">{release.notes}</pre>}
          <div className="update-safety"><ShieldCheck size={17} /><span>校验更新包后备份并重启。项目、素材、生成结果、模型和设置不会被替换；启动失败会恢复旧版。</span></div>
          {projectOpen && <p className="update-warning" role="alert">请先保存当前项目并返回项目启动页，再点击升级。后端也会再次检查未关闭项目和活动任务。</p>}
          {message && <p className="update-warning">{message}</p>}
        </>}
        {(dialog === 'latest' || dialog === 'error' || dialog === 'info') && <p className="update-message">{message}</p>}
        {dialog === 'updating' && <p className="update-help">下载和构建可能需要几分钟。重启期间页面会暂时断开，完成后自动刷新；请勿关闭电脑。</p>}
        <div className="update-actions">
          {dialog === 'available' && <>
            <a className="update-link" href={release?.url} target="_blank" rel="noreferrer">查看 Release<ExternalLink size={14} /></a>
            <button onClick={close}>稍后</button>
            <button className="primary" disabled={projectOpen || !release?.canApply} onClick={upgrade}><ArrowUpCircle size={15} />立即升级</button>
          </>}
          {(dialog === 'latest' || dialog === 'error' || dialog === 'info') && <button className="primary" onClick={close}>知道了</button>}
        </div>
      </section>
    </div>}
  </>;
}
