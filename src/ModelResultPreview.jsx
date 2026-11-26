import React, { useContext, useState } from 'react';
import { Native3DContext } from './Native3D.jsx';
import { nativeAssetUrl } from './native3d.js';
import { modelPreviewActions } from './model-result.js';

export function ModelResultPreview({ data, projectId, onPersist }) {
  const api = useContext(Native3DContext);
  const summary = modelPreviewActions(data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const download = summary.persisted ? nativeAssetUrl(projectId, data.assetPath) : data.url;
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
    <strong>{summary.name}</strong>
    <p>{summary.status}{summary.stats ? ` · ${summary.stats}` : ''}</p>
    {summary.persist && <button type="button" className="persist-model-preview nodrag" disabled={!onPersist || busy} onClick={persist}>{busy ? '写入中…' : summary.viewLabel}</button>}
    {!summary.persist && <button type="button" className="nodrag" disabled={!summary.view} onClick={open}>{summary.viewLabel}</button>}
    {download && <a href={download} download={summary.name}>下载 GLB</a>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
