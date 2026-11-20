import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ExternalLink, RefreshCw } from 'lucide-react';
import { assetUrl } from './project-store-http.js';

const ACTIVE = ['pending', 'running', 'cancelling'];
const exportLabel = ({ id, createdAt, current }) => {
  const when = Number.isFinite(createdAt) ? new Date(createdAt).toLocaleString() : id.slice(0, 8);
  return `${when} · ${current ? '当前版本' : '历史版本'}`;
};

export default function OpenMotionPanel({ id, data, actions, locked }) {
  const binding = data.openMotion;
  const hasProject = Boolean(binding?.remoteProjectId);
  const [summary, setSummary] = useState(null);
  const [existing, setExisting] = useState('');
  const [selected, setSelected] = useState('');
  const [audio, setAudio] = useState('optional');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(null);
  const call = actions.openMotion;
  const current = summary?.remoteProjectId === binding?.remoteProjectId ? summary : null;
  const rendering = ACTIVE.includes(current?.active?.state);

  // Only the linked project is checked. Keep polling while a render is active
  // and keep the last good local result visible even when Studio is stopped.
  useEffect(() => {
    if (!hasProject || busy) return undefined;
    let closed = false;
    let timer;
    const refresh = async () => {
      try {
        const value = await call(id, 'inspect');
        if (closed) return;
        setSummary(value);
        if (ACTIVE.includes(value.active?.state)) timer = setTimeout(refresh, 2500);
      } catch (failure) {
        if (!closed) setError(failure.message);
      }
    };
    refresh();
    return () => { closed = true; clearTimeout(timer); };
  }, [call, id, binding?.remoteProjectId, hasProject, busy]);

  const run = async (action, options) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const value = await call(id, action, options);
      if (action === 'import') setMessage('成片已存入当前画布项目。');
      else setSummary(value);
      if (action === 'create' || action === 'link') {
        setSelected('');
        setExisting('');
        request.current = null;
      }
      if (action === 'render') request.current = null;
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const render = () => {
    request.current ||= { requestId: crypto.randomUUID(), audio };
    run('render', request.current);
  };
  const resultUrl = binding?.resultAssetPath ? assetUrl(actions.projectId, binding.resultAssetPath) : null;
  const exports = current?.exports || [];
  const exportId = exports.some((item) => item.id === selected) ? selected : exports[0]?.id;
  const disabled = locked || busy;

  return <main className="video-openmotion">
    <section>
      <h3>OpenMotion 工程</h3>
      {hasProject ? <p>{current?.title || binding.title} <small>{binding.remoteProjectId}</small></p> : <p>把画布成片送去加字幕和动效，或关联已在本机制作的工程。</p>}
      <div className="video-openmotion-actions">
        <button onClick={() => run('create')} disabled={disabled || !data.editResultAssetPath}>从画布成片创建工程</button>
        {current?.studioUrl && <a href={current.studioUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />打开 OpenMotion Studio</a>}
        {hasProject && <button onClick={() => run('inspect')} disabled={busy}><RefreshCw size={13} />刷新工程</button>}
      </div>
      {binding?.sourceAssetPath && binding.sourceAssetPath !== data.editResultAssetPath && <p>画布成片已更新，OpenMotion 工程基于上一次导出的版本。</p>}
      <div className="video-openmotion-actions">
        <input aria-label="OpenMotion 工程 ID" maxLength={36} value={existing} placeholder="OpenMotion 工程 ID" onChange={(event) => setExisting(event.target.value)} disabled={disabled} />
        <button onClick={() => run('link', { remoteProjectId: existing.trim() })} disabled={disabled || existing.trim().length !== 36}>关联已有本地工程</button>
      </div>
    </section>
    {hasProject && <section>
      <h3>渲染与回传</h3>
      <p>在 Studio 保存后，渲染当前版本。技术校验通过的 MP4 会出现在下方。</p>
      <div className="video-openmotion-actions">
        <select aria-label="OpenMotion 音轨" value={audio} onChange={(event) => { request.current = null; setAudio(event.target.value); }} disabled={disabled || rendering}>
          <option value="optional">按工程保留音轨</option><option value="required">必须包含声音</option><option value="silent">无音轨</option>
        </select>
        <button onClick={render} disabled={disabled || rendering || !current}>渲染 OpenMotion MP4</button>
      </div>
      {rendering && <p role="status">OpenMotion 正在渲染或校验…</p>}
      {current?.failed && !rendering && <p role="status">最近一次渲染未完成，可以重试或在 Studio 查看详情。</p>}
      {exportId && <div className="video-openmotion-actions">
        <select aria-label="OpenMotion 成片" value={exportId} onChange={(event) => setSelected(event.target.value)} disabled={disabled}>
          {exports.map((item) => <option key={item.id} value={item.id}>{exportLabel(item)}</option>)}
        </select>
        <button onClick={() => run('import', { exportId })} disabled={disabled || binding.exportId === exportId}>回传所选成片</button>
      </div>}
    </section>}
    {busy && <p role="status">正在与本机 OpenMotion 交换数据…</p>}
    {error && <p className="video-edit-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {resultUrl && <section>
      <h3>OpenMotion 回传成片</h3>
      <video controls playsInline preload="metadata" src={resultUrl} />
      <a href={resultUrl} download={`${binding.title || 'OpenMotion'}.mp4`}><ArrowDownToLine size={13} />下载回传成片</a>
    </section>}
  </main>;
}
