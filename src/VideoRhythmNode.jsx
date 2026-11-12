import React, { useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import { ArrowDownToLine, Gauge, LoaderCircle, Plus, Square, Spline, Trash2 } from 'lucide-react';
import { RHYTHM_INTERPOLATION, defaultRemapKeyframes, freezeAt, sampleSourceTime, videoRhythmSummary } from './video-rhythm-document';
import './video-rhythm.css';

const INTERPOLATION_LABEL = { linear: '线性', easeIn: '缓入', easeOut: '缓出', easeInOut: '缓入缓出' };

function slopeLabel(rows, index) {
  const next = rows[index + 1];
  if (!next) return '';
  const dx = next.output - rows[index].output;
  const dy = next.source - rows[index].source;
  if (!dx) return '';
  if (dy === 0) return '定格';
  const slope = dy / dx;
  if (Math.abs(slope - 1) < 0.001) return '原速';
  return slope < 1 ? '慢放' : '快放';
}

export default function VideoRhythmNode({ id, type, data, actions, title, toolbar }) {
  const state = actions.getVideoRhythmState(id);
  const running = ['running', 'queued'].includes(data.status) || state.busy;
  const disabled = running || actions.readOnly;
  const isSpeed = type === 'videoSpeed';
  const remap = data.remapKeyframes || defaultRemapKeyframes();
  const stale = videoRhythmSummary(data, type).rhythmStale;
  useEffect(() => { actions.resumeVideoRhythm?.(id); }, [id]);
  const patchKeys = (keyframes) => actions.updateNode(id, { remapKeyframes: keyframes });
  let curvePreview = '—';
  try { curvePreview = `${sampleSourceTime(remap, 1).toFixed(3)} 秒`; } catch { curvePreview = '曲线还未通过校验'; }
  return <div className={`video-rhythm-node ${isSpeed ? 'is-speed' : 'is-remap'}`} data-status={data.status || 'idle'}>
    {title}{toolbar}
    <Handle type="target" id="v1" position={Position.Left} style={{ top: 78 }} isConnectable={!disabled} />
    <span className={`video-rhythm-port ${state.input ? 'connected' : ''}`}>{state.input ? state.input.title : 'v1 视频'}</span>
    <Handle type="source" id="ref" position={Position.Right} style={{ top: 78 }} isConnectable={!actions.readOnly} title="成片可连接到其他视频节奏节点或视频编辑" />
    <div className="video-rhythm-heading"><span>{isSpeed ? <><Gauge size={12} /> 恒定速度</> : <><Spline size={12} /> 时间重映射</>}</span><b>CPU</b></div>
    <div className="video-rhythm-controls nodrag nopan">
      {isSpeed ? <>
        <label>倍率<input aria-label="播放速度" type="number" min="0.25" max="4" step="0.05" value={data.speed ?? 0.5} disabled={disabled} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) actions.updateNode(id, { speed: value }); }} /></label>
        <div className="video-rhythm-presets">
          <button type="button" disabled={disabled} onClick={() => actions.updateNode(id, { speed: 0.5 })}>0.5× 升格</button>
          <button type="button" disabled={disabled} onClick={() => actions.updateNode(id, { speed: 1 })}>1×</button>
          <button type="button" disabled={disabled} onClick={() => actions.updateNode(id, { speed: 2 })}>2× 快放</button>
        </div>
        <label>声音<select aria-label="声音处理" value={data.rhythmAudio || 'preserve'} disabled={disabled} onChange={(event) => actions.updateNode(id, { rhythmAudio: event.target.value })}>
          <option value="preserve">保持音高</option>
          <option value="stretch">拉长变调</option>
          <option value="mute">静音</option>
        </select></label>
      </> : <>
        <p>横轴是成片时间，纵轴是源时间。水平段是定格。插值只作用于这一关键帧到下一帧。</p>
        {remap.map((key, index) => <div className="video-rhythm-key" key={`${index}-${key.output}`}>
          <label>成片<input aria-label={`关键帧 ${index + 1} 成片时间`} type="number" min="0" step="0.001" value={key.output} disabled={disabled} onChange={(event) => patchKeys(remap.map((item, itemIndex) => itemIndex === index ? { ...item, output: Number(event.target.value) } : item))} /></label>
          <label>源<input aria-label={`关键帧 ${index + 1} 源时间`} type="number" min="0" step="0.001" value={key.source} disabled={disabled} onChange={(event) => patchKeys(remap.map((item, itemIndex) => itemIndex === index ? { ...item, source: Number(event.target.value) } : item))} /></label>
          <label>插值<select aria-label={`关键帧 ${index + 1} 插值`} value={key.interpolation || 'linear'} disabled={disabled || index === remap.length - 1} onChange={(event) => patchKeys(remap.map((item, itemIndex) => itemIndex === index ? { ...item, interpolation: event.target.value } : item))}>
            {RHYTHM_INTERPOLATION.map((value) => <option key={value} value={value}>{INTERPOLATION_LABEL[value]}</option>)}
          </select></label>
          <em>{slopeLabel(remap, index)}</em>
          <button type="button" aria-label={`删除关键帧 ${index + 1}`} disabled={disabled || remap.length <= 2} onClick={() => patchKeys(remap.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={12} /></button>
        </div>)}
        <div className="video-rhythm-presets">
          <button type="button" disabled={disabled || remap.length >= 64} onClick={() => { const last = remap.at(-1); patchKeys([...remap, { output: Math.round((last.output + 1) * 1000) / 1000, source: Math.round((last.source + 1) * 1000) / 1000, interpolation: 'linear' }]); }}><Plus size={12} />关键帧</button>
          <button type="button" disabled={disabled} onClick={() => patchKeys(freezeAt(2, 1))}>在 2 秒定格 1 秒</button>
        </div>
        <small>成片 1 秒处的源时间：{curvePreview}</small>
      </>}
    </div>
    <div className="video-rhythm-result nodrag nopan">
      {state.resultUrl ? <video src={state.resultUrl} controls preload="metadata" playsInline /> : <span>连接一段视频后导出。成片留在这个节点里，并可再连到剪辑或其他节奏节点。</span>}
    </div>
    {data.rhythmResult && <div className="video-rhythm-meta"><span>{data.rhythmResult.frames} 帧</span><span>{data.rhythmResult.audio === 'mute' ? '无声' : data.rhythmResult.audio === 'stretch' ? '拉长变调' : '保持音高'}</span></div>}
    {data.error && <p className="video-rhythm-error" role="alert">{data.error}</p>}
    <footer>
      <span>{running ? `${data.stage || '导出中'} ${Math.round((data.progress || 0) * 100)}%` : stale ? '参数已更新 · 待导出' : data.rhythmResultAssetPath ? '结果已导出' : '未导出'}</span>
      {running
        ? <button type="button" className="video-rhythm-cancel" onClick={() => actions.cancelVideoRhythm(id)}><Square size={12} />取消</button>
        : <button type="button" className="video-rhythm-export" disabled={disabled} onClick={() => actions.generateNode(id)}><ArrowDownToLine size={14} />导出</button>}
      {running && <LoaderCircle className="video-rhythm-spin" size={14} />}
    </footer>
  </div>;
}
