import React, { useEffect, useRef, useState } from 'react';
import { downloadExtensionModels, extensionDependencies, extensionDownloadJob } from './workflow-extensions';
import './WorkflowExchange.css';

export function ExchangeDialog({ title, onClose, busy, children }) {
  const panel = useRef(null);
  const latest = useRef({ onClose, busy }); latest.current = { onClose, busy };
  useEffect(() => {
    const previous = document.activeElement;
    const container = panel.current.parentElement;
    // These two surfaces are controlled by CanvasWorkbench's modal state;
    // restoring their snapshot after React clears it would leave the canvas inert.
    const siblings = [...container.parentElement.children].filter((element) => element !== container && !element.matches('.neo-header,.neo-canvas-wrap'));
    const inertBefore = siblings.map((element) => [element, element.inert]);
    siblings.forEach((element) => { element.inert = true; });
    panel.current.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!latest.current.busy) latest.current.onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')];
      const first = controls[0]; const last = controls.at(-1);
      if (!first) { event.preventDefault(); panel.current.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      inertBefore.forEach(([element, inert]) => {
        // Sharing may open a previously hidden sidebar in the same React commit.
        // Restore its current visibility state instead of making the new panel inert.
        element.inert = element.matches('.node-library-backdrop,.reference-library-backdrop') ? element.getAttribute('aria-hidden') === 'true' : inert;
      });
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
    };
  }, []);
  return <div className="workflow-exchange-backdrop"><section className="workflow-exchange" ref={panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header><h2>{title}</h2><button disabled={busy} onClick={onClose} aria-label={`关闭${title}`}>关闭</button></header>{children}</section></div>;
}

export function DependencyList({ report }) {
  if (!report) return null;
  return <><h3>模型与 LoRA</h3>{!report.models?.length && <p>没有识别到模型依赖。</p>}{report.models?.map((model) => <div className="workflow-dependency" key={model.id}><strong>{model.name}</strong><small>{model.category} · {model.status === 'installed' ? '本机已安装' : model.status === 'missing' ? '缺少模型' : '状态待确认'}</small></div>)}<h3>ComfyUI 节点</h3><p className="workflow-node-types">{report.comfyNodes?.map((node) => `${node.classType}${node.installed ? '' : '（未安装）'}`).join(' · ') || '未识别到节点'}</p></>;
}

export default function WorkflowDependencies({ request, onClose, onAdd }) {
  const bundle = request.bundle;
  const [definitionId, setDefinitionId] = useState(bundle.nodes[0].definition.nodeDefinitionId);
  const [parameters, setParameters] = useState(request.parameters || {});
  const [report, setReport] = useState(request.report || null);
  const [choices, setChoices] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [downloadJob, setDownloadJob] = useState(null);
  const mounted = useRef(true); const busyRef = useRef(false); const epoch = useRef(0);
  useEffect(() => () => { mounted.current = false; epoch.current++; }, []);
  const run = async (action) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); try { await action(); } catch (err) { if (mounted.current) { setError(err.message); setProgress(''); } } finally { busyRef.current = false; if (mounted.current) setBusy(false); } };
  const load = async (id = definitionId, params = parameters) => { const current = ++epoch.current; const result = await extensionDependencies(bundle.digest, id, params); if (mounted.current && current === epoch.current) setReport(result); return result; };
  const jobKey = (id = definitionId) => `h3-extension-download:${bundle.digest}:${id}`;
  const storedJob = () => { try { return sessionStorage.getItem(jobKey()); } catch { return null; } };
  const saveJob = (id) => { try { if (id) sessionStorage.setItem(jobKey(), id); else sessionStorage.removeItem(jobKey()); } catch { /* Storage can be disabled; monitoring still works in this panel. */ } };
  useEffect(() => {
    const jobId = storedJob();
    if (jobId) void run(async () => { setDownloadJob(jobId); try { await monitorDownload(await extensionDownloadJob(jobId)); } catch (err) { saveJob(null); setDownloadJob(null); throw err; } });
    else if (!request.report) void run(() => load());
  }, []);
  const changeDefinition = (id) => { setDefinitionId(id); setParameters({}); setChoices({}); setReport(null); void run(() => load(id, {})); };
  const applyReplacement = (model) => run(async () => {
    const name = choices[model.id];
    if (!model.parameterId || !model.candidates?.some((candidate) => candidate.name === name)) throw new Error('请先选择本机候选模型。');
    const next = { ...parameters, [model.parameterId]: name };
    await load(definitionId, next); if (mounted.current) setParameters(next);
  });
  const monitorDownload = async (initialJob) => {
    let job = initialJob;
    while (mounted.current && !['done', 'completed', 'failed', 'error', 'cancelled'].includes(job.status)) {
      const percent = job.totalBytes > 0 ? Math.min(100, Math.round(job.downloadedBytes / job.totalBytes * 100)) : null;
      setProgress(`正在下载 ${job.currentModel || '所需模型'}${percent !== null ? ` · ${percent}%` : ''}（${job.completed || 0}/${job.total || '?'}）…`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (mounted.current) job = await extensionDownloadJob(job.jobId || job.id);
    }
    if (!mounted.current) return;
    saveJob(null); setDownloadJob(null);
    if (['failed', 'error', 'cancelled'].includes(job.status)) throw new Error(job.error || job.message || '模型下载未完成，请重试。');
    setProgress('下载完成，正在重新检查。'); await load(); setProgress('');
  };
  const download = () => run(async () => {
    const saved = storedJob();
    const modelIds = report.models.filter((model) => model.status !== 'installed' && model.download).map((model) => model.id);
    const job = saved ? await extensionDownloadJob(saved) : await downloadExtensionModels(bundle.digest, definitionId, parameters, modelIds);
    const id = job.jobId || job.id;
    saveJob(id); setDownloadJob(id);
    await monitorDownload(job);
  });
  const downloadable = report?.models?.filter((model) => model.status !== 'installed' && model.download) || [];
  return <ExchangeDialog title="添加工作流到画布" onClose={onClose} busy={busy && !downloadJob}>
    <p>{bundle.manifest.name} · {bundle.manifest.version}</p>
    {bundle.nodes.length > 1 && <label>选择节点<select value={definitionId} disabled={busy} onChange={(event) => changeDefinition(event.target.value)}>{bundle.nodes.map(({ definition }) => <option key={definition.nodeDefinitionId} value={definition.nodeDefinitionId}>{definition.name}</option>)}</select></label>}
    {error && <p role="alert">{error}</p>}{busy && <p role="status">{progress || '正在检查…'}</p>}
    {downloadJob && <p>模型正在后台下载，可关闭此窗口继续使用画布。再次检查此节点时会恢复下载进度。</p>}
    <DependencyList report={report} />
    {report?.models?.filter((model) => model.status !== 'installed').map((model) => <div className="workflow-dependency-resolution" key={model.id}><strong>{model.name}</strong>
      {model.download ? <p>可从已核实来源下载 · {(model.download.bytes / 1024 ** 3).toFixed(2)} GiB{model.download.sha256 ? ' · SHA256 校验' : ' · 仅校验大小，内容哈希待核实'}</p> : <p>暂无已核实的直接下载来源，请按作者说明安装此模型。</p>}
      {model.parameterId && model.candidates?.length > 0 && <><label>本地候选<select aria-label={`替换 ${model.name}`} disabled={busy} value={choices[model.id] || ''} onChange={(event) => setChoices((previous) => ({ ...previous, [model.id]: event.target.value }))}><option value="">选择本地模型</option>{model.candidates.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}</select></label><p>候选来自同一加载器，不保证架构或生成效果兼容，请核对模型系列后确认。</p><button disabled={busy || !choices[model.id]} onClick={() => applyReplacement(model)}>确认使用此替换</button></>}
    </div>)}
    {downloadable.length > 0 && <button disabled={busy} onClick={download}>一键补齐可下载模型（{downloadable.length} 项 · {(downloadable.reduce((total, model) => total + model.download.bytes, 0) / 1024 ** 3).toFixed(2)} GiB）</button>}
    {report && !report.ready && <p className="workflow-warning">仍有依赖未就绪，可以先添加节点；运行前需要补齐。缺少的 ComfyUI 节点需按作者说明安装。</p>}
    <footer><button disabled={busy} onClick={() => run(() => load())}>重新检查</button><button disabled={busy || !report} onClick={() => run(async () => { await onAdd(bundle, definitionId, parameters, report); })}>{report?.ready ? '添加到当前画布' : '先添加节点，稍后补齐'}</button></footer>
  </ExchangeDialog>;
}
