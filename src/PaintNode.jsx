import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { OUTPUT_MODE_LABELS } from './paint-document.js';
import './paint.css';

export default function PaintNode({ id, data, actions, title, toolbar }) {
  const layers = Array.isArray(data.layers) ? data.layers.length : 1;
  const modeKey = data.outputMode || 'transparent';
  const mode = OUTPUT_MODE_LABELS[modeKey] || OUTPUT_MODE_LABELS.transparent;
  const badge = modeKey === 'mask' ? 'MASK' : modeKey === 'composite' ? 'MERGE' : 'ALPHA';
  const width = data.paper?.width || 1280;
  const height = data.paper?.height || 720;
  return <div className="paint-node" data-testid="paint-node" data-output-mode={modeKey}>
    {title}{toolbar}
    <Handle type="target" id="base" position={Position.Left} style={{ top: 118 }} isConnectable={!actions.readOnly} />
    <span className="paint-port paint-port-in">参考底图</span>
    <Handle type="source" id="ref" position={Position.Right} style={{ top: 118 }} isConnectable={!actions.readOnly} />
    <div className="paint-heading"><i /><span>PAINT · {badge}</span><b>{layers}/12 LAYERS</b></div>
    <button type="button" className={`paint-thumb nodrag nopan${modeKey === 'transparent' ? ' is-transparent' : ''}${modeKey === 'mask' ? ' is-mask' : ''}`} data-testid="paint-thumb" onDoubleClick={(event) => { event.stopPropagation(); actions.openPaintEditor(id); }}>
      {data.url ? <img src={data.url} alt={data.title || '绘画预览'} /> : <span>双击进入画板</span>}
    </button>
    <p className="paint-summary" data-testid="paint-summary">{width}×{height} · {mode} · {data.assetPath ? '已同步' : '未同步'}</p>
    <div className="paint-actions nodrag nopan">
      <button type="button" className="paint-primary" data-testid="paint-open" onClick={() => actions.openPaintEditor(id)}>进入画板</button>
      <button type="button" data-testid="paint-push" onClick={() => actions.openPaintLan?.(id)} title="连接平板（局域网）"><i />推到平板</button>
    </div>
  </div>;
}
