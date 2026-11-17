import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { pcgPreview } from './pcg-registry.js';

// A report preview only. No viewport, mesh, export or parameter editor is implied.
export default function PcgNode({ data, state = {} }) {
  const preview = pcgPreview(data, state.task, state.error);
  return <section className="neo-node pcg-node" data-pcg-version="1" style={{ width: 360, padding: 16 }} aria-label={`PCG ${preview.label}`}>
    <header><strong>PCG · {preview.label}</strong><small style={{ display: 'block' }}>{data.descriptorId} · v{data.operationVersion}</small></header>
    <p role={preview.status === 'failed' || preview.status === 'invalid' ? 'alert' : 'status'}>{preview.message}</p>
    <p>{preview.status}{preview.stale ? ' · 过期任务，仅供查看' : ''}</p>
    {preview.progress !== null && <progress aria-label="PCG 实际任务进度" max="1" value={preview.progress} style={{ width: '100%' }} />}
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <div>{preview.inputs.map(port => <div key={port.name} style={{ position: 'relative', padding: '8px 0' }}><Handle type="target" id={port.name} position={Position.Left} style={{ left: -20 }} /><small>{port.name}<br />{port.type}{port.required ? '' : ' · 可选'}</small></div>)}</div>
      <div>{preview.outputs.map(port => <div key={port.name} style={{ position: 'relative', padding: '8px 0', textAlign: 'right' }}><small>{port.name}<br />{port.type}</small><Handle type="source" id={port.name} position={Position.Right} style={{ right: -20 }} /></div>)}</div>
    </div>
    <details className="nodrag nopan nowheel"><summary>参数与任务身份</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ parameters: data.parameters, ...(preview.task ? { jobId: preview.task.jobId, runId: preview.task.runId, revision: preview.task.revision, inputHash: preview.task.inputHash, resultHash: preview.task.resultHash } : {}) }, null, 2)}</pre></details>
    {preview.report && <details className="nodrag nopan nowheel" open><summary>实际诊断报告{preview.stale ? ' · 过期' : ''}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(preview.report, null, 2)}</pre></details>}
    <footer><small>只读预览 · M1 合同诊断；几何执行器尚未提供</small></footer>
  </section>;
}
