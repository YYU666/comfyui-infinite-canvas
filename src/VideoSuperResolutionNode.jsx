import React, { useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Film, LoaderCircle } from 'lucide-react';
import { RTX_SUPER_RESOLUTION_QUALITIES } from './video-super-resolution.js';
import './video-super-resolution.css';

export default function VideoSuperResolutionNode({ id, data, selected, actions, title, nodeActions }) {
  const upload = useRef(null);
  const { updateNode, generateNode, cancelNode, getReferences, attachFilesToGenerator, readOnly, serverOnline } = actions;
  const busy = ['uploading', 'queued', 'running', 'finishing'].includes(data.status);
  const locked = busy || readOnly;
  const source = getReferences(id).find(node => node.data.slot === 'guide');
  const model = data.videoUpscaleModel || 'rtx';
  return <div className={`generator-shell h3-node video-super-resolution-node ${selected ? 'selected' : ''} ${busy ? 'running' : ''}`}>
    {title}{nodeActions}
    <div className="generator-preview">
      {data.resultUrl ? <video className="nodrag" src={data.resultUrl} controls preload="metadata" playsInline /> : <div className="generator-placeholder">
        {busy ? <LoaderCircle className="spin" size={29} /> : <Film size={29} />}
        <strong>{busy ? data.stage || '处理中' : '连接视频，按原片比例超分'}</strong>
        <span>{busy ? `${data.progress || 0}%` : '本地处理 · 保留完整时长、帧率与原声'}</span>
      </div>}
      {busy && <div className="generation-overlay"><div><i style={{ width: `${data.progress || 3}%` }} /></div><span>{data.stage} · {data.progress || 0}%</span></div>}
    </div>
    <Handle type="target" position={Position.Left} id="guide" className="neo-handle target" title="连接源视频" />
    <Handle type="source" position={Position.Right} id="video" className="neo-handle source" title="连接已保存的超分成品" />
    <div className="video-super-resolution-controls nodrag nowheel">
      <span className="video-super-resolution-source">源视频：{source?.data.title || '尚未连接'}</span>
      <label>处理模型<select aria-label="视频超分模型" value={model} disabled={locked} onChange={e => updateNode(id, { videoUpscaleModel: e.target.value, error: null })}>
        <option value="rtx">RTX VFX · 视频超分</option><option value="seedvr2_3b">SeedVR2 3B · 视频超分（实验）</option><option value="seedvr2_7b">SeedVR2 7B · 视频超分（实验）</option>
      </select></label>
      <label>放大倍率<select aria-label="视频超分倍率" value={data.videoUpscaleScale ?? 2} disabled={locked} onChange={e => updateNode(id, { videoUpscaleScale: Number(e.target.value), error: null })}>
        {[1, 1.5, 2, 3, 4].map(scale => <option key={scale} value={scale}>{scale}×</option>)}
      </select></label>
      {model === 'rtx' ? <>
        <label>质量<select aria-label="RTX 超分质量" value={data.rtxQuality || 'ULTRA'} disabled={locked} onChange={e => updateNode(id, { rtxQuality: e.target.value, error: null })}>{RTX_SUPER_RESOLUTION_QUALITIES.map(quality => <option key={quality}>{quality}</option>)}</select></label>
        <label>强度<input aria-label="RTX 超分强度" type="number" min="0" max="1" step="0.05" value={data.rtxStrength ?? 1} disabled={locked} onChange={e => updateNode(id, { rtxStrength: Number(e.target.value), error: null })} /></label>
      </> : <p>时间分块采样；视频帧仍占用主内存。建议先用短片确认显存、速度与效果。</p>}
      <p>音频沿用原片内容，保存时重新编码；不生成新声音。</p>
      {data.error && <div className="generator-error" role="alert">{data.error}</div>}
      <div className="video-super-resolution-buttons">
        <input ref={upload} type="file" accept="video/*" hidden onChange={e => { if (e.target.files?.length) attachFilesToGenerator(id, [...e.target.files], 'guide'); e.target.value = ''; }} />
        <button disabled={locked} onClick={() => upload.current?.click()}>上传视频</button>
        {busy ? <button disabled={readOnly} onClick={() => { if (!readOnly) cancelNode(id); }}>取消</button> : <button disabled={readOnly || !serverOnline || !source} onClick={() => generateNode(id)}>开始超分</button>}
      </div>
    </div>
  </div>;
}
