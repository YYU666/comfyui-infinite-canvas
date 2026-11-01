import React, { useEffect, useRef, useState } from 'react';
import './ReferenceLibrary.css';
import { createRefmuseCanvasBridge } from './refmuse-canvas-bridge';

export const REFERENCE_LIBRARIES = Object.freeze({
  refmuse: { label: 'Refmuse', url: 'https://refmuse.cn/' },
  costume: { label: '衣装库', url: 'https://ai-costume-gallery.pages.dev/' },
  pose: { label: '姿势库', url: 'https://ai-pose-gallery.pages.dev/' },
});

export default function ReferenceLibrary({ library, open, onLibraryChange, readOnly, onImport, onClose }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const fileInput = useRef(null);
  const frame = useRef(null);
  const bridge = useRef(null);
  const latest = useRef({ onImport, readOnly, open, busy: false });
  const [frameState, setFrameState] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const source = REFERENCE_LIBRARIES[library];
  latest.current = { onImport, readOnly, open, busy };
  const frameUrl = library === 'refmuse' ? `${source.url}?canvasEmbed=1&parentOrigin=${encodeURIComponent(window.location.origin)}` : source.url;
  useEffect(() => {
    if (library !== 'refmuse') return undefined;
    const connection = createRefmuseCanvasBridge({
      getFrame: () => frame.current?.contentWindow, channel: crypto.randomUUID(),
      onImport: (...args) => latest.current.onImport(...args),
      isActive: () => latest.current.open, isReadOnly: () => latest.current.readOnly, isBusy: () => latest.current.busy,
      onBusy: (value) => { latest.current.busy = value; setBusy(value); },
      onReady: () => setFrameState('connected'),
      onMessage: ({ ok, message: text }) => { setFailed(!ok); setMessage(text); },
    });
    bridge.current = connection;
    window.addEventListener('message', connection.receive);
    connection.init();
    const retry = setInterval(connection.init, 2000);
    return () => { clearInterval(retry); window.removeEventListener('message', connection.receive); connection.stop(); bridge.current = null; };
  }, [library, reloadKey]);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => { setTimeout(() => { if (previous?.isConnected) previous.focus(); }, 0); };
  }, [open]);
  useEffect(() => {
    setFrameState('loading');
    const timer = setTimeout(() => setFrameState((state) => state === 'loading' ? 'waiting' : state), 12000);
    return () => clearTimeout(timer);
  }, [library, reloadKey]);
  useEffect(() => {
    if (!open) return undefined;
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busy) onClose(); }
      if (event.key === 'Tab') {
        const controls = [...dialog.current.querySelectorAll('button:not(:disabled),a[href],iframe,input:not(:disabled):not([hidden])')];
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [busy, onClose, open]);
  const importFile = async (event) => {
    const files = [...(event.target.files || [])]; event.target.value = '';
    if (!files.length) return;
    setFailed(false); setMessage('');
    if (files.length !== 1 || !['image/png', 'image/jpeg', 'image/webp'].includes(files[0].type)) {
      setFailed(true); setMessage('请选择单张 PNG、JPEG 或 WebP 图片。'); return;
    }
    setBusy(true);
    try { await onImport(files[0], library); setMessage('图片和画布已保存。关闭参考库后可查看新节点。'); }
    catch (error) { setFailed(true); setMessage(`导入未完成：${error.message || '保存失败，请重试。'}`); }
    finally { setBusy(false); }
  };
  return <div className="reference-library-backdrop" style={open ? undefined : { display: 'none' }} inert={!open ? true : undefined} aria-hidden={!open}>
    <section className="reference-library" role="dialog" aria-modal="true" aria-labelledby="reference-library-title" ref={dialog}>
      <header><h2 id="reference-library-title">Refmuse参考库</h2><button ref={closeButton} disabled={busy} onClick={onClose} aria-label="关闭参考库">关闭</button></header>
      <nav aria-label="参考库分类">{Object.entries(REFERENCE_LIBRARIES).map(([key, value]) => <button key={key} disabled={busy} aria-pressed={library === key} onClick={() => { onLibraryChange(key); setMessage(''); }}>{value.label}</button>)}
        <button disabled={busy} title="清空当前搜索并重新加载，仅在连接异常或会话额度用尽时使用" onClick={() => { setReloadKey((value) => value + 1); setMessage(''); }}>重新加载</button>
        <a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开原站 ↗</a>
      </nav>
      <p>{library === 'refmuse' ? '搜索场景参考，点击图片的“导入当前画布”。需要搜索时，请在下方登录 Refmuse。' : '从原站下载单张图片后导入当前画布，使用前请查看原站说明。'}</p>
      <p className="reference-library-load" role="status">{frameState === 'connected' ? 'Refmuse 已连接当前画布，可以一键导入。' : frameState === 'loading' ? '正在打开原站页面…' : library === 'refmuse' ? '等待 Refmuse 连接；未连接时无法一键导入。' : frameState === 'loaded' ? '若页面空白或无法下载，可点击“打开原站”。' : '暂时无法确认原站是否可用，可点击“打开原站”。'}</p>
      <iframe ref={frame} key={`${library}:${reloadKey}`} title={source.label} src={frameUrl} sandbox={library === 'refmuse' ? 'allow-scripts allow-same-origin allow-downloads allow-forms' : 'allow-scripts allow-same-origin allow-downloads'} referrerPolicy="no-referrer" onLoad={() => { setFrameState((value) => value === 'connected' ? value : 'loaded'); bridge.current?.init(); }} onError={() => setFrameState('error')} />
      <footer><button disabled={readOnly || busy} onClick={() => fileInput.current?.click()}>{busy ? '正在导入并保存…' : '导入已下载的图片'}</button>
        <input ref={fileInput} aria-label="选择单张参考图" type="file" accept="image/png,image/jpeg,image/webp" disabled={readOnly || busy} onChange={importFile} hidden />
        {readOnly && <span>只读画布可浏览，无法导入。</span>}
        {message && <span role={failed ? 'alert' : 'status'}>{message}</span>}
      </footer>
    </section>
  </div>;
}
