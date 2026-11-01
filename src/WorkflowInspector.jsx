import React, { useEffect, useRef, useState } from 'react';
import { COMFY_INSPECTOR_ORIGIN, INSPECTOR_CHANNEL, INSPECTOR_VERSION, isInspectorMessage, stageDescription } from './workflow-inspector';

export default function WorkflowInspector({ request, onClose }) {
  const frame = useRef(null);
  const dialog = useRef(null);
  const [record, setRecord] = useState(null);
  const [stageId, setStageId] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在读取执行记录…');
  const [ready, setReady] = useState(false);
  const [ack, setAck] = useState(null);
  const stage = record?.stages.find((item) => item.id === stageId);
  const settle = useRef(false);
  const finish = (value, failure) => {
    if (settle.current) return;
    settle.current = true;
    if (failure) request.reject?.(new Error(failure)); else request.resolve?.(value);
  };

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    const escape = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('keydown', escape, true); previous?.focus?.(); finish(null, '已关闭工作流查看。'); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    (async () => {
      try {
        if (request.error) throw new Error(request.error);
        const response = await fetch(`/api/queue/inspect?${new URLSearchParams(request.query)}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || '无法读取执行记录。');
        if (!data.stages?.length) throw new Error('尚无执行记录。');
        const selected = request.stage || data.defaultStage;
        if (!data.stages.some((item) => item.id === selected)) throw new Error('指定的工作流阶段不存在。');
        setRecord(data); setStageId(selected); setStatus('正在连接 ComfyUI 查看器…');
      } catch (reason) {
        if (!controller.signal.aborted || !settle.current) {
          const message = reason.name === 'AbortError' ? '读取执行记录超时。' : reason.message;
          setError(message); finish(null, message);
        }
      } finally { clearTimeout(timer); }
    })();
    return () => { clearTimeout(timer); controller.abort(); };
  }, []);

  useEffect(() => {
    if (!record) return undefined;
    const sendHello = () => frame.current?.contentWindow?.postMessage({ channel: INSPECTOR_CHANNEL, version: INSPECTOR_VERSION, nonce: request.nonce, type: 'hello' }, COMFY_INSPECTOR_ORIGIN);
    let timer;
    const listener = (event) => {
      if (!isInspectorMessage(event, frame.current?.contentWindow, request.nonce)) return;
      if (event.data.type === 'close') { onClose(); return; }
      if (event.data.type === 'ready') { clearTimeout(timer); clearInterval(interval); setReady(true); }
      if (event.data.type === 'error' && !event.data.requestId) {
        clearTimeout(timer); clearInterval(interval); setError(event.data.error || 'ComfyUI 查看器启动失败。'); finish(null, event.data.error || '查看器启动失败。');
      }
    };
    window.addEventListener('message', listener);
    const interval = setInterval(sendHello, 350);
    timer = setTimeout(() => { clearInterval(interval); setError('ComfyUI 查看器连接超时。请确认扩展已加载；可下载当前阶段 JSON。'); finish(null, 'ComfyUI 查看器连接超时。'); }, 30000);
    sendHello();
    return () => { clearTimeout(timer); clearInterval(interval); window.removeEventListener('message', listener); };
  }, [record]);

  useEffect(() => {
    setAck(null);
    if (!stage?.graph) { if (stage) { setStatus(stageDescription(stage)); finish(null, stageDescription(stage)); } return undefined; }
    if (!ready) return undefined;
    setError(''); setStatus('正在载入节点图…');
    const requestId = crypto.randomUUID();
    const name = `${request.title || record.nodeId} · ${stage.label}`;
    const timer = setTimeout(() => { setError('ComfyUI 导入超时，未确认打开。可下载当前阶段 JSON。'); finish(null, 'ComfyUI 导入超时。'); }, 30000);
    const listener = (event) => {
      if (!isInspectorMessage(event, frame.current?.contentWindow, request.nonce) || event.data.requestId !== requestId) return;
      if (event.data.type === 'loaded') {
        clearTimeout(timer); setAck(event.data); setStatus(`已在 ComfyUI 打开 · ${event.data.nodeCount} 个节点`);
        finish({ nodeId: request.nodeId, jobId: record.jobId, stage: stage.id, name: event.data.name, nodeCount: event.data.nodeCount, linkCount: event.data.linkCount, opened: true });
      } else if (event.data.type === 'error') {
        clearTimeout(timer); setError(event.data.error || 'ComfyUI 导入失败。'); finish(null, event.data.error || 'ComfyUI 导入失败。');
      }
    };
    window.addEventListener('message', listener);
    frame.current.contentWindow.postMessage({ channel: INSPECTOR_CHANNEL, version: INSPECTOR_VERSION, nonce: request.nonce, type: 'load', requestId, name, graph: stage.graph }, COMFY_INSPECTOR_ORIGIN);
    return () => { clearTimeout(timer); window.removeEventListener('message', listener); };
  }, [ready, stageId, record]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(stage.graph, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `workflow-${stage.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="workflow-inspector-backdrop" onDoubleClick={(event) => event.stopPropagation()}>
    <section ref={dialog} className="workflow-inspector" role="dialog" aria-modal="true" aria-label="查看 ComfyUI 工作流" tabIndex={-1}>
      <header><div><strong>{request.title || '节点工作流'}</strong><p>ComfyUI 临时查看副本 · 修改不会自动写回画布 · 打开不会提交生成</p></div><button onClick={onClose} aria-label="关闭工作流查看">关闭 ×</button></header>
      {record && <nav aria-label="工作流阶段">{record.stages.map((item) => <button key={item.id} aria-pressed={item.id === stageId} onClick={() => setStageId(item.id)}>{item.label}</button>)}</nav>}
      <div className="workflow-inspector-state"><span>{stage ? stageDescription(stage) : '执行记录'}</span>{stage?.graph && <button onClick={download}>下载阶段 JSON</button>}</div>
      <p role={error ? 'alert' : 'status'} className={error ? 'workflow-inspector-error' : ''}>{error || status}</p>
      {record && <iframe ref={frame} title="ComfyUI 工作流查看副本" src={`${COMFY_INSPECTOR_ORIGIN}/#h3-inspector=${request.nonce}`} sandbox="allow-scripts allow-same-origin" className={stage?.graph && !error ? '' : 'workflow-inspector-hidden'} />}
      {ack && <span className="workflow-inspector-confirmation" data-node-count={ack.nodeCount}>{ack.name}</span>}
    </section>
  </div>;
}
