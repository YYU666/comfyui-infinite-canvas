import VideoJobStatus, { videoExportLabel } from './VideoJobStatus';
import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { defaultRepairSettings, videoRepairSummary } from './video-repair-document';
import './video-repair.css';

export default function VideoRepairNode({ id, data, actions, title, toolbar }) {
  const state = actions.getVideoRepairState(id);
  const [preview, setPreview] = useState(null), [previewing, setPreviewing] = useState(false), [error, setError] = useState('');
  const requestVersion = useRef(0);
  const settings = data.repairSettings || defaultRepairSettings().repairSettings;
  const busy = ['running', 'queued'].includes(data.status) || state.busy;
  const disabled = busy || actions.readOnly;
  const signature = JSON.stringify([settings, data.previewTime, state.sourceSignature]);
  const stale = videoRepairSummary(data, { sourceSignature: state.sourceSignature }).repairStale;
  useEffect(() => { if (!actions.readOnly) actions.resumeVideoRepair(id); }, [id, actions.readOnly]);
  useEffect(() => { requestVersion.current += 1; setPreview(null); setError(''); }, [signature]);
  useEffect(() => () => { requestVersion.current += 1; }, []);
  const patch = (value) => actions.updateNode(id, { repairSettings: { ...settings, ...value } });
  async function showPreview(mode) {
    const version = ++requestVersion.current;
    setPreviewing(true); setError('');
    try {
      const result = await actions.previewVideoRepair(id, { mode, time: data.previewTime ?? 0 });
      if (version !== requestVersion.current) return;
      if (!result?.ok) throw new Error(result?.error || '预览失败。');
      setPreview({ ...result, url: `data:image/png;base64,${result.pngBase64}` });
    } catch (failure) { if (version === requestVersion.current) setError(failure.message); }
    finally { setPreviewing(false); }
  }
  const rect = settings.rect;
  return <div className="video-repair-node" data-status={data.status || 'idle'}>
    {title}{toolbar}
    <Handle type="target" id="video" position={Position.Left} style={{ top: 75 }} isConnectable={!disabled} title="输入一个视频素材或已导出成片" />
    <Handle type="source" id="ref" position={Position.Right} style={{ top: 75 }} isConnectable={!disabled} title="已保存成片可连接视频处理节点" />
    <div className="video-repair-heading"><span>局部水印修补</span><b>CPU · 本地</b></div>
    <div className="video-repair-body nodrag nopan">
      <p>{state.sourceTitle || '请连接视频到左侧 video 端口。'}</p>
      <p>用周围像素填补小块区域，适合角落文字、简单背景。覆盖运动衣物会模糊；不重建 AI 或时序细节。不用模型权重、云服务或 GPU 生成。</p>
      <div className="video-repair-grid">
        {['x', 'y', 'width', 'height'].map((key, index) => <label key={key}>{['左侧 %', '顶部 %', '宽度 %', '高度 %'][index]}
          <input aria-label={['选区左侧百分比', '选区顶部百分比', '选区宽度百分比', '选区高度百分比'][index]} type="number" min="0" max={index > 1 ? 50 : 100} step="0.1" disabled={disabled} value={Number((rect[key] * 100).toFixed(4))} onChange={event => { if (event.target.value !== '') patch({ rect: { ...rect, [key]: Number(event.target.value) / 100 } }); }} />
        </label>)}
      </div>
      <p className="video-repair-note">矩形总面积 ≤ 15%，实际选区至少 4×4 px，距画面边缘至少 2 px。保持原分辨率、帧率、帧数与音频。支持最长 120 秒、恒定帧率视频。</p>
      <div className="video-repair-grid">
        <label>开始秒<input aria-label="修补开始秒" type="number" min="0" max="120" step="0.001" disabled={disabled} value={settings.start} onChange={event => patch({ start: Number(event.target.value) })} /></label>
        <label>结束秒<input aria-label="修补结束秒" type="number" min="0" max="120" step="0.001" placeholder="留空到片尾" disabled={disabled} value={settings.end ?? ''} onChange={event => patch({ end: event.target.value === '' ? null : Number(event.target.value) })} /></label>
        <label>预览秒<input aria-label="预览秒" type="number" min="0" max="120" step="0.001" disabled={disabled} value={data.previewTime ?? 0} onChange={event => actions.updateNode(id, { previewTime: Number(event.target.value) })} /></label>
      </div>
      <div className="video-repair-buttons">{[['original', '原片帧'], ['mask', '遮罩帧'], ['repaired', '修补帧']].map(([mode, label]) => <button key={mode} disabled={disabled || previewing || !state.sourceTitle} onClick={() => showPreview(mode)}>{label}</button>)}</div>
      <div className="video-repair-preview">
        {preview ? <div className="video-repair-frame"><img src={preview.url} alt={`${{ original: '原片', mask: '遮罩', repaired: '修补' }[preview.mode]}预览`} />
          {preview.mode === 'original' && <div className="video-repair-rect" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />}</div>
          : <span>先看原片帧定位矩形，再看遮罩和修补效果。</span>}
      </div>
      {preview && <p className="video-repair-note">第 {preview.frame} 帧 · {preview.time} 秒 · {preview.width}×{preview.height}</p>}
      {state.resultUrl && <div className="video-repair-result"><span>{stale ? '旧结果 · 参数或输入已变化' : '已保存成片'}</span><video src={state.resultUrl} controls playsInline preload="metadata" /></div>}
      {data.repairResult && <p className="video-repair-note">{data.repairResult.width}×{data.repairResult.height} · {data.repairResult.frames ?? data.repairResult.frameCount} 帧</p>}
      {(error || data.error) && <p role="alert" className="video-repair-error">{error || data.error}</p>}
    </div>
    <footer><VideoJobStatus data={data} running={busy} fallback={previewing ? '正在预览' : stale ? '输入或参数已变更 · 待修补' : data.stage || '未修补'} />
      {busy ? <button disabled={actions.readOnly} onClick={() => { if (!actions.readOnly) actions.cancelVideoRepair(id); }}>取消</button> : data.repairPendingResult ? <button disabled={disabled || !state.sourceTitle} onClick={() => actions.resumeVideoRepair(id)}>继续保存结果</button> : <button disabled={disabled || !state.sourceTitle} onClick={() => actions.generateNode(id)}>{videoExportLabel(id, data, '修补并保存')}</button>}
    </footer>
  </div>;
}
