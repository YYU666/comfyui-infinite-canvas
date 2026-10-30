import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowUpCircle, Check, ExternalLink, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { applyUpdate, checkForUpdates, getUpdateStatus, getWorkbenchHealth } from './update-client';
import { getSettings } from './settings-client';
import './updates.css';

const NOTIFIED_KEY = 'refmuse-update-completed';

export default function UpdateCenter({ projectOpen }) {
  const [dialog, setDialog] = useState(null);
  const [release, setRelease] = useState(null);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const checking = useRef(false);
  const applying = useRef(false);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    const check = async (manual = false) => {
      if (checking.current || applying.current) return;
      checking.current = true;
      if (manual) { setMessage(''); setDialog('checking'); }
      try {
        const initial = await getUpdateStatus();
        if (initial.lastResult?.phase === 'success' && initial.lastResult.version?.replace(/^v/, '') === initial.currentVersion) {
          const version = initial.lastResult.version;
          if (localStorage.getItem(NOTIFIED_KEY) !== version) {
            localStorage.setItem(NOTIFIED_KEY, version);
            setNotice(`已安全更新至 ${version}。`);
          }
        } else if (!manual && initial.lastResult?.phase === 'error' && initial.lastResult.message?.includes('已恢复')) {
          setMessage(initial.lastResult.message);
          setDialog('error');
          return;
        }
        const result = await checkForUpdates();
        if (disposed.current) return;
        if (result.updateAvailable) {
          setRelease(result);
          setMessage(result.message || '');
          setDialog('available');
        } else if (manual) {
          setMessage(result.status === 'unavailable' ? result.message : `当前 ${result.currentVersion} 已是最新版本。`);
          setDialog(result.status === 'unavailable' ? 'error' : 'latest');
        }
      } catch (error) {
        if (manual && !disposed.current) { setMessage(error.message); setDialog('error'); }
      } finally { checking.current = false; }
    };
    let timer;
    getSettings().then((settings) => {
      if (!disposed.current && settings.updates?.autoCheck !== false) timer = setTimeout(() => check(false), 1200);
    }).catch(() => {});
    const manual = () => check(true);
    window.addEventListener('refmuse-check-updates', manual);
    return () => {
      disposed.current = true;
      clearTimeout(timer);
      window.removeEventListener('refmuse-check-updates', manual);
    };
  }, []);

  useEffect(() => {
    if (dialog !== 'updating') return undefined;
    const poll = async () => {
      try {
        const status = await getUpdateStatus();
        if (status.message) setMessage(status.message);
        if (status.phase === 'error') {
          applying.current = false;
          setMessage(status.message || '升级失败，旧版未被替换。');
          setDialog('error');
        }
      } catch { /* The old server goes offline while the standalone helper runs. */ }
    };
    const interval = setInterval(poll, 1800);
    poll();
    return () => clearInterval(interval);
  }, [dialog]);

  const waitForRestart = async (version) => {
    const target = version.replace(/^v/, '');
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !disposed.current) {
      try {
        const health = await getWorkbenchHealth();
        if (health.version === target) {
          window.location.reload();
          return;
        }
        const status = await getUpdateStatus();
        const failure = status.phase === 'error' ? status : status.lastResult?.phase === 'error' ? status.lastResult : null;
        if (failure) throw new Error(failure.message || '新版启动失败，已恢复旧版。');
      } catch (error) {
        if (error?.name !== 'TypeError' && error.message !== '工作台尚未就绪。') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!disposed.current) {
      applying.current = false;
      setMessage('等待重启超时。工作台可能已恢复原版本，请查看当前页面或运行日志。');
      setDialog('error');
    }
  };

  const upgrade = async () => {
    if (applying.current || projectOpen || !release?.canApply) return;
    applying.current = true;
    setDialog('updating');
    setMessage('正在确认项目与队列状态…');
    try {
      await applyUpdate(release.version);
      await waitForRestart(release.version);
    } catch (error) {
      applying.current = false;
      setMessage(error.message);
      setDialog('error');
    }
  };

  const close = () => { if (!applying.current) setDialog(null); };
  return <>
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
        {(dialog === 'latest' || dialog === 'error') && <p className="update-message">{message}</p>}
        {dialog === 'updating' && <p className="update-help">下载和构建可能需要几分钟。重启期间页面会暂时断开，完成后自动刷新；请勿关闭电脑。</p>}
        <div className="update-actions">
          {dialog === 'available' && <>
            <a className="update-link" href={release?.url} target="_blank" rel="noreferrer">查看 Release<ExternalLink size={14} /></a>
            <button onClick={close}>稍后</button>
            <button className="primary" disabled={projectOpen || !release?.canApply} onClick={upgrade}><ArrowUpCircle size={15} />立即升级</button>
          </>}
          {(dialog === 'latest' || dialog === 'error') && <button className="primary" onClick={close}>知道了</button>}
        </div>
      </section>
    </div>}
  </>;
}
