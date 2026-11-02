import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, X } from 'lucide-react';
import './NodeLibrary.css';

const ORIGIN = 'https://refmuse.cn';

export default function NodeLibrary({ open, onClose, onOpenLocal, onImport, sharePacket, onShareSent }) {
  const frame = useRef(null);
  const latest = useRef(null);
  latest.current = { open, onClose, onImport, onShareSent };
  const [state, setState] = useState('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const [error, setError] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const pending = useRef(new Map());
  const shared = useRef(null);
  const init = () => frame.current?.contentWindow?.postMessage({ type: 'refmuse.nodes.init', version: 1 }, ORIGIN);
  useEffect(() => {
    let ready = false; let failed = false; let disposed = false;
    setState('loading');
    const currentFrame = frame.current;
    const receive = async (event) => {
      if (event.origin !== ORIGIN || event.source !== frame.current?.contentWindow || event.data?.version !== 1) return;
      const data = event.data;
      if (data.type === 'refmuse.nodes.ready' && !failed) { if (!ready) init(); ready = true; setState('connected'); }
      if (data.type === 'refmuse.nodes.close' && latest.current.open) latest.current.onClose();
      if (data.type === 'refmuse.nodes.share.result') {
        if (data.requestId === shared.current && typeof data.ok === 'boolean') {
          shared.current = null;
          const message = data.status === 'published' ? '上传成功，已发布到节点库。未经 GPU 实测。'
            : ['approved', 'publishing'].includes(data.status) ? '审核已通过，正在等待发布完成。'
              : '上传成功，已提交节点库审核。审核通过后将在公开列表显示。';
          setShareStatus(data.ok ? (typeof data.message === 'string' ? data.message.slice(0, 1000) : message) : '');
          setError(data.ok ? '' : data.error || '上传未完成。');
        }
        return;
      }
      if (data.type !== 'refmuse.nodes.add' || !latest.current.open) return;
      if (typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.requestId)) return;
      const key = `${data.packageId}:${data.packageVersion}:${data.digest}`;
      const previous = pending.current.get(data.requestId);
      if (previous && previous.key !== key) { event.source.postMessage({ type: 'refmuse.nodes.add.result', version: 1, requestId: data.requestId, ok: false, error: '导入请求标识被用于不同节点，请重试。' }, ORIGIN); return; }
      let operation = previous?.operation;
      if (!operation) {
        if (pending.current.size >= 100) { setError('本次会话已处理较多导入请求，请重新打开画布后继续。'); return; }
        operation = Promise.resolve().then(() => latest.current.onImport(data)).then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message || '添加节点失败。' }));
        pending.current.set(data.requestId, { key, operation });
      }
      const result = await operation;
      if (!disposed) { if (!result.ok) setError(result.error); event.source.postMessage({ type: 'refmuse.nodes.add.result', version: 1, requestId: data.requestId, ...result }, ORIGIN); }
    };
    const loadError = () => { failed = true; setState('error'); };
    currentFrame?.addEventListener('error', loadError); window.addEventListener('message', receive); init();
    const retry = setInterval(() => { if (!ready && latest.current.open) init(); }, 2000);
    const timeout = setTimeout(() => { if (!ready) setState((value) => value === 'error' ? value : 'waiting'); }, 12000);
    return () => { disposed = true; clearInterval(retry); clearTimeout(timeout); window.removeEventListener('message', receive); currentFrame?.removeEventListener('error', loadError); };
  }, [reloadKey, loadEpoch]);
  useEffect(() => {
    if (!open || state !== 'connected' || !sharePacket) return;
    if (shared.current === sharePacket.requestId) return;
    shared.current = sharePacket.requestId;
    setError('');
    setShareStatus('正在提交节点包；若提示登录，请先登录，完成后会继续上传。');
    frame.current?.contentWindow?.postMessage({ type: 'refmuse.nodes.share', version: 1, ...sharePacket }, ORIGIN);
    latest.current.onShareSent?.(sharePacket.requestId);
  }, [open, state, sharePacket]);
  useEffect(() => {
    if (!open) return;
    const keydown = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) latest.current.onClose(); };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [open]);
  return <aside className="node-library-backdrop" hidden={!open} inert={!open ? true : undefined} aria-hidden={!open}>
    <section className="node-library" role="complementary" aria-label="节点库">
      <div className="node-library-controls">
        <button onClick={onOpenLocal} aria-label="本地节点 / 导入工作流" title="本地节点 / 导入工作流"><FolderOpen size={15} /></button>
        <button onClick={() => { setError(''); setReloadKey((value) => value + 1); }} aria-label="重新加载" title="重新加载节点库"><RefreshCw size={15} /></button>
        <button onClick={onClose} aria-label="关闭节点库" title="关闭节点库"><X size={16} /></button>
      </div>
      {state !== 'connected' && <p className={`node-library-status ${state}`} role={state === 'error' ? 'alert' : 'status'}>{state === 'loading' ? '正在连接 Refmuse 节点库…' : state === 'error' ? '节点库加载失败，请重新加载。' : '尚未收到节点库就绪确认，请重新加载。'}</p>}
      {error && <p className="node-library-status error" role="alert">{error}</p>}
      {shareStatus && <p className="node-library-status" role="status">{shareStatus}</p>}
      <iframe ref={frame} key={reloadKey} title="Refmuse 节点库" src={`${ORIGIN}/open?canvasEmbed=1&parentOrigin=${encodeURIComponent(window.location.origin)}`} sandbox="allow-scripts allow-same-origin allow-downloads allow-forms" referrerPolicy="no-referrer" onLoad={() => setLoadEpoch((value) => value + 1)} />
    </section>
  </aside>;
}
