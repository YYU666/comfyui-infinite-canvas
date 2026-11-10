import React, { useEffect, useRef, useState } from 'react';
import { createPureRefImporter, pureRefPreview } from './pureref-import.js';
import './pureref-import.css';

function Preview({ image, session }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const controller = new AbortController(); let local;
    pureRefPreview(session, image, controller.signal).then(value => { local = value; if (controller.signal.aborted) URL.revokeObjectURL(value); else setUrl(value); }).catch(() => {});
    return () => { controller.abort(); if (local) URL.revokeObjectURL(local); };
  }, [session, image]);
  return <figure>{url && <img src={url} alt={image.name}/>}<figcaption>{image.name} · {image.width} × {image.height}</figcaption></figure>;
}

export default function PureRefImport({ file, getContext, upload, beginBatch, publish, persist, onClose }) {
  const [state, setState] = useState({ phase: 'idle' });
  const importer = useRef(null), close = useRef(null);
  useEffect(() => {
    let alive = true;
    const workflow = createPureRefImporter({ getContext, upload, beginBatch, publish, persist, onState: next => { if (alive) setState(next); } });
    importer.current = workflow;
    workflow.inspect(file).catch(error => { if (alive) setState({ phase: 'error', message: error.message }); });
    close.current?.focus();
    return () => { alive = false; workflow.cancel(); };
  }, []);
  const busy = ['idle', 'inspecting', 'uploading', 'cancelling', 'saving'].includes(state.phase);
  const result = state.result;
  return <div className="pureref-overlay" role="presentation" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <section className="pureref-dialog" role="dialog" aria-modal="true" aria-labelledby="pureref-title">
      <header><h2 id="pureref-title">导入 PureRef 图片</h2><button ref={close} disabled={busy} onClick={onClose}>关闭</button></header>
      <p>导入 PureRef .pur 中的内嵌 PNG、JPEG、WebP（文件上限 8 GiB，单图 128 MiB / 64 MP）。图片将成为普通图片节点并网格排列；不恢复原布局、分组、裁剪、绘画或文字。</p>
      {state.phase === 'inspecting' && <p role="status">{state.progress?.phase === 'uploading' ? `正在暂存文件 ${((state.progress.bytes || 0) / 1024**3).toFixed(2)} / ${(file.size / 1024**3).toFixed(2)} GiB…` : state.progress?.phase === 'extracting' ? `正在验证图片 ${state.progress.completed} / ${state.progress.total}…` : '正在本机校验容器与图片；大文件可能需要数分钟…'}</p>}
      {result && <>
        <p role="status">可导入 {result.images.length} 张独立图片 · 合并 {result.duplicates} 次重复 · 跳过 {result.skippedExternal} 个外链 / 非内嵌实例 · {(result.totalBytes / 1024 / 1024).toFixed(2)} MiB</p>
        <div className="pureref-previews">{result.images.slice(0, 12).map(image => <Preview key={image.sha256} image={image} session={result.session}/>)}</div>
        {result.images.length > 12 && <p>仅预览前 12 张；确认后导入全部 {result.images.length} 张。</p>}
        <p>外链路径与网址不会访问。原文件不会修改；点击下方按钮后才会向当前项目保存图片。</p>
        <button className="pureref-confirm" onClick={() => importer.current.commit().catch(error => setState({ phase: 'error', message: error.message }))}>导入 {result.images.length} 张图片</button>
      </>}
      {state.phase === 'uploading' && <><p role="status">正在保存图片 {state.completed} / {state.total}；完成全部上传后统一加入画布…</p><progress value={state.completed} max={state.total}/></>}
      {state.phase === 'cancelling' && <p role="status">正在取消；等待当前本地请求结束，不会添加图片节点…</p>}
      {state.phase === 'saving' && <p role="status">正在确认画布保存，请保留本页…</p>}
      {state.phase === 'done' && <p role="status">已导入并保存 {state.total} 张图片。可从普通图片节点连接到电子主美；合并 {state.duplicates} 次重复，跳过 {state.skippedExternal} 个外链 / 非内嵌实例。</p>}
      {state.phase === 'cancelled' && <p role="status">已取消；没有添加新图片节点。已上传的不可变素材不会删除。</p>}
      {['error', 'unconfirmed'].includes(state.phase) && <p role="alert">{state.message}</p>}
      {['inspecting', 'uploading'].includes(state.phase) && <button onClick={() => importer.current.cancel()}>取消导入</button>}
    </section>
  </div>;
}
