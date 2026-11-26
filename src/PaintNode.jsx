import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { OUTPUT_MODE_LABELS } from './paint-document.js';
import './paint.css';

export default function PaintNode({ id, data, actions, title, toolbar }) {
  const layers = Array.isArray(data.layers) ? data.layers.length : 1;
  const mode = OUTPUT_MODE_LABELS[data.outputMode] || OUTPUT_MODE_LABELS.transparent;
  const width = data.paper?.width || 1280;
  const height = data.paper?.height || 720;
  return <div className="paint-node" data-testid="paint-node" data-output-mode={data.outputMode || 'transparent'}>
    {title}{toolbar}
    <Handle type="target" id="base" position={Position.Left} style={{ top: 92 }} isConnectable={!actions.readOnly} />
    <span className="paint-port paint-port-in">参考底图</span>
    <Handle type="source" id="ref" position={Position.Right} style={{ top: 92 }} isConnectable={!actions.readOnly} />
    <div className="paint-heading"><span>手绘工作台</span><b>{data.touched ? '已绘制' : '空白纸张'}</b></div>
    <button type="button" className={`paint-thumb nodrag nopan${data.outputMode === 'transparent' ? ' is-transparent' : ''}${data.outputMode === 'mask' ? ' is-mask' : ''}`} data-testid="paint-thumb" onDoubleClick={(event) => { event.stopPropagation(); actions.openPaintEditor(id); }}>
      {data.url ? <img src={data.url} alt={data.title || '绘画预览'} /> : <span>双击进入画板</span>}
    </button>
    <p className="paint-summary" data-testid="paint-summary">{width}×{height} · {layers}/12 · {mode}</p>
    <div className="paint-actions nodrag nopan">
      <button type="button" data-testid="paint-open" onClick={() => actions.openPaintEditor(id)}>进入画板</button>
      <button type="button" data-testid="paint-push" disabled title="局域网伴侣功能待 M3 接入">推到平板</button>
    </div>
  </div>;
}
