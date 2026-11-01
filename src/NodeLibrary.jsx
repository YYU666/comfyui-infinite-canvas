import React, { useEffect, useRef, useState } from 'react';
import { Blocks, RefreshCw, X } from 'lucide-react';
import './NodeLibrary.css';

const NODE_LIBRARY_ORIGIN = 'https://refmuse.cn';

export default function NodeLibrary({ open, onClose, onOpenLocal }) {
  const backdrop = useRef(null);
  const frame = useRef(null);
  const closeButton = useRef(null);
  const latest = useRef({ open, onClose });
  latest.current = { open, onClose };
  const [state, setState] = useState('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const init = () => frame.current?.contentWindow?.postMessage({ type: 'refmuse.nodes.init', version: 1 }, NODE_LIBRARY_ORIGIN);

  useEffect(() => {
    let ready = false;
    let failed = false;
    const currentFrame = frame.current;
    setState('loading');
    const receive = (event) => {
      if (event.origin !== NODE_LIBRARY_ORIGIN || event.source !== frame.current?.contentWindow || event.data?.version !== 1) return;
      if (event.data.type === 'refmuse.nodes.ready' && !failed) { ready = true; setState('connected'); }
      if (event.data.type === 'refmuse.nodes.close' && latest.current.open) latest.current.onClose();
    };
    window.addEventListener('message', receive);
    const loadError = () => { failed = true; setState('error'); };
    currentFrame?.addEventListener('error', loadError);
    init();
    const retry = setInterval(() => { if (!ready && latest.current.open) init(); }, 2000);
    const timeout = setTimeout(() => { if (!ready) setState((value) => value === 'error' ? value : 'waiting'); }, 12000);
    return () => { clearInterval(retry); clearTimeout(timeout); window.removeEventListener('message', receive); currentFrame?.removeEventListener('error', loadError); };
  }, [reloadKey, loadEpoch]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    // Include floating panels and other dialogs, not just the React Flow surface.
    const siblings = [...backdrop.current.parentElement.children].filter((element) => element !== backdrop.current && !element.matches('.neo-header,.neo-canvas-wrap,.reference-library-backdrop'));
    const inertBefore = siblings.map((element) => [element, element.inert]);
    siblings.forEach((element) => { element.inert = true; });
    closeButton.current?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); latest.current.onClose(); }
    };
    const containFocus = (event) => { if (!backdrop.current?.contains(event.target)) closeButton.current?.focus(); };
    window.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', containFocus);
      inertBefore.forEach(([element, inert]) => { element.inert = inert; });
      setTimeout(() => { if (previous?.isConnected && !previous.closest('[inert]')) previous.focus(); }, 0);
    };
  }, [open]);

  return <div ref={backdrop} className="node-library-backdrop" hidden={!open} inert={!open ? true : undefined} aria-hidden={!open}>
    <section className="node-library" role="dialog" aria-modal="true" aria-labelledby="node-library-title" aria-describedby="node-library-description">
      <span className="node-library-focus-boundary" tabIndex={0} onFocus={() => frame.current?.focus()} />
      <header>
        <div><Blocks size={19} /><h2 id="node-library-title">节点库</h2><span>Refmuse</span></div>
        <button ref={closeButton} onClick={onClose} aria-label="关闭节点库"><X size={18} /></button>
      </header>
      <div className="node-library-toolbar">
        <div><p id="node-library-description">搜索、上传和下载封装好的画布节点 · .h3pack</p><p className="node-library-note">节点包内含 ComfyUI 工作流；当前支持分享，下载后不会自动安装或运行。</p></div>
        <button onClick={onOpenLocal}>本地节点 / 导入工作流</button>
        <button onClick={() => setReloadKey((value) => value + 1)} title="重新加载节点库，会清空当前搜索"><RefreshCw size={14} />重新加载</button>
      </div>
      <p className={`node-library-status ${state}`} role={state === 'error' ? 'alert' : 'status'}>
        <i />{state === 'connected' ? '节点库已连接 · 上传需要登录 Refmuse。' : state === 'loading' ? '正在连接 Refmuse 节点库…' : state === 'error' ? '节点库加载失败，请检查网络后重新加载。' : '尚未收到节点库就绪确认；页面可能无法嵌入或连接超时，请重新加载。'}
      </p>
      <iframe ref={frame} key={reloadKey} title="Refmuse 节点库" src={`${NODE_LIBRARY_ORIGIN}/open?canvasEmbed=1&parentOrigin=${encodeURIComponent(window.location.origin)}`} sandbox="allow-scripts allow-same-origin allow-downloads allow-forms" referrerPolicy="no-referrer" onLoad={() => setLoadEpoch((value) => value + 1)} />
      <span className="node-library-focus-boundary" tabIndex={0} onFocus={() => closeButton.current?.focus()} />
    </section>
  </div>;
}
