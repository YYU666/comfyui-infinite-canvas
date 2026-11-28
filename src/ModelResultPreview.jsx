import React, { useContext, useEffect, useState } from 'react';
import { Native3DContext } from './Native3D.jsx';
import { nativeAssetUrl } from './native3d.js';
import { modelPreviewActions } from './model-result.js';
import { captureModelPoster } from './model-poster.js';

export function ModelResultPreview({ data, projectId, onPersist }) {
  const api = useContext(Native3DContext);
  const summary = modelPreviewActions(data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState('');
  const download = summary.persisted ? nativeAssetUrl(projectId, data.assetPath) : data.url;
  const poster = data.posterAssetPath ? nativeAssetUrl(projectId, data.posterAssetPath) : '';
  const source = poster || (summary.persisted ? nativeAssetUrl(projectId, data.assetPath) : (typeof data.url === 'string' && data.url.startsWith('/') ? data.url : ''));
  useEffect(() => {
    if (!source || poster) return undefined;
    let live = true;
    captureModelPoster(source).then((image) => { if (live && image) setSnapshot(image); }).catch(() => {});
    return () => { live = false; };
  }, [source, poster]);
  const picture = poster || snapshot;
  const open = () => api?.view?.({ path: data.assetPath, title: data.title || summary.name, materialPreview: !summary.whiteMesh });
  const persist = async () => {
    if (!onPersist) return;
    setBusy(true);
    setError('');
    try {
      const saved = await onPersist(data);
      api?.view?.({ path: saved.assetPath, title: data.title || summary.name, materialPreview: !summary.whiteMesh });
    } catch (err) {
      setError(err.message || '写入项目失败。');
    } finally {
      setBusy(false);
    }
  };
  return <div className="model-result-preview">
    {picture ? <img className="model-result-shot" src={picture} alt={summary.name} draggable={false} /> : null}
    <div className="model-result-caption">
      <strong>{summary.name}</strong>
      <p>{summary.status}{summary.stats ? ` · ${summary.stats}` : ''}</p>
      <div className="model-result-actions nodrag">
        {summary.persist && <button type="button" className="persist-model-preview nodrag" disabled={!onPersist || busy} onClick={persist}>{busy ? '写入中…' : summary.viewLabel}</button>}
        {!summary.persist && <button type="button" className="nodrag" disabled={!summary.view} onClick={open}>{summary.viewLabel}</button>}
        {download && <a href={download} download={summary.name}>下载 GLB</a>}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  </div>;
}
