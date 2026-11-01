import React, { useEffect, useRef, useState } from 'react';
import { getExtension, importExtension, listExtensions } from './workflow-extensions';
import './WorkflowLibrary.css';

export default function WorkflowLibrary({ onClose, onAdd }) {
  const [items, setItems] = useState([]);
  const [bundle, setBundle] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const panel = useRef(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const run = async (action) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); try { await action(); } catch (err) { if (mounted.current) setError(err.message); } finally { busyRef.current = false; if (mounted.current) setBusy(false); } };
  const refresh = async () => { const result = await listExtensions(); if (mounted.current) setItems(result.items || []); };
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    const siblings = [...panel.current.parentElement.parentElement.children].filter((element) => element !== panel.current.parentElement && !element.matches('.neo-header,.neo-canvas-wrap,.reference-library-backdrop'));
    const inertBefore = siblings.map((element) => [element, element.inert]);
    siblings.forEach((element) => { element.inert = true; });
    const containFocus = (event) => { if (!panel.current?.contains(event.target)) panel.current?.focus(); };
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busyRef.current) closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...panel.current.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter((element) => element.getClientRects().length);
      const first = controls[0]; const last = controls.at(-1);
      if (!first) { event.preventDefault(); panel.current.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown, true); document.addEventListener('focusin', containFocus);
    void run(refresh); panel.current.focus();
    return () => { mounted.current = false; window.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', containFocus); inertBefore.forEach(([element, inert]) => { element.inert = inert; }); if (previous?.isConnected && !previous.closest('[inert]')) previous.focus(); };
  }, []);
  return <div className="workflow-library-backdrop">
    <section className="workflow-library" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="本地工作流节点">
      <header><h2>本地工作流节点</h2><button disabled={busy} onClick={onClose} aria-label="关闭本地工作流">关闭</button></header>
      <p>导入 .h3pack 或 ComfyUI「导出 API」JSON。普通界面工作流 JSON 暂不支持。</p>
      <p>包保存在本机扩展库，画布绑定固定摘要；应用更新不会替换它。请确认来源可信；导入不会安装节点、模型或自动运行。</p>
      <label className="workflow-import">导入工作流<input aria-label="选择工作流文件" type="file" accept=".h3pack,.json" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { setBundle(await importExtension(file)); await refresh(); }); }} /></label>
      {error && <p role="alert">{error}</p>}{busy && <p role="status">正在处理…</p>}
      <div className="workflow-library-columns"><nav aria-label="已安装工作流">{items.map((item) => <button key={item.digest} disabled={busy} onClick={() => run(async () => setBundle(await getExtension(item.digest)))}><strong>{item.name || item.packageId}</strong><small>{item.version} · {item.digest.slice(0, 12)}</small></button>)}{!items.length && <p>尚无本地工作流。</p>}</nav>
        <article>{bundle ? <><h3>{bundle.manifest.name || bundle.manifest.packageId}</h3><p>{bundle.manifest.packageId} · {bundle.manifest.version}</p><code>{bundle.digest}</code>
          {bundle.nodes.map(({ definition }) => <section key={definition.nodeDefinitionId}><h3>{definition.name}</h3><p>{definition.description}</p><h4>图片输入</h4><ul>{definition.inputs.map((port) => <li key={port.id}>{port.label || port.name || port.id} · {port.required ? '必填' : '可选'}{port.description ? ` · ${port.description}` : ''}</li>)}</ul><h4>可调参数</h4><ul>{Object.entries(definition.parameters?.properties || {}).map(([id, field]) => <li key={id}>{field.title || id} · {field.type} {field.default !== undefined ? `· 默认 ${String(field.default)}` : ''}</li>)}</ul><h4>输出</h4><p>{definition.outputs?.map((output) => `${output.id} (${output.type})`).join('、')}</p><button disabled={busy} onClick={() => run(async () => { await onAdd(bundle, definition.nodeDefinitionId); onClose(); })}>确认添加到当前画布</button></section>)}
          <a href={`/api/extensions/${bundle.digest}/download`} download>导出固定版本 .h3pack</a></> : <p>选择工作流，预览身份、输入和参数后添加。</p>}</article>
      </div>
    </section>
  </div>;
}
