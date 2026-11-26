import React, { useContext } from 'react';
import { Native3DContext } from './Native3D.jsx';
import { nativeAssetUrl } from './native3d.js';
import { modelResultSummary } from './model-result.js';
import { WHITE_MESH_STEP_LABEL } from './white-mesh-step.js';

export function ModelResultPreview({ data, projectId }) {
  const api = useContext(Native3DContext);
  const summary = modelResultSummary(data || {});
  const download = summary.persisted && projectId ? nativeAssetUrl(projectId, data.assetPath) : data?.url;
  const openViewer = () => {
    if (!summary.persisted) return;
    api?.view?.({
      path: data.assetPath,
      title: data.title || summary.name,
      materialPreview: !summary.whiteMesh,
    });
  };
  return <div className="model-result-preview">
    <strong>{summary.whiteMesh ? WHITE_MESH_STEP_LABEL : '3D 模型'}</strong>
    <p>{summary.status}{summary.name ? ` · ${summary.name}` : ''}</p>
    {summary.stats && <p>{summary.stats}</p>}
    {!summary.persisted && <p>尚未写入项目素材，清理临时输出后无法预览。</p>}
    <div className="model-result-actions">
      <button type="button" className="nodrag" disabled={!summary.persisted} onClick={openViewer}>查看 3D 模型</button>
      {download && <a className="nodrag" href={download} download={summary.name || 'model.glb'}>下载 GLB</a>}
    </div>
  </div>;
}
