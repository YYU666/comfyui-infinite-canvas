import React, { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Clapperboard, ArrowDownToLine, LoaderCircle, Square, SlidersHorizontal } from 'lucide-react';
import VideoEditorPanel from './VideoEditorPanel';
import { VIDEO_EDIT_PORTS, framesOf, timecode } from './video-edit-document';
import './video-edit.css';

const PORT_TOP = 70, PORT_GAP = 22;

export default function VideoEditorNode({ id, data, actions, title, toolbar }) {
  const [open, setOpen] = useState(false);
  const state = actions.getVideoEditState(id);
  const running = ['running', 'queued'].includes(data.status) || state.busy;
  const disabled = running || actions.readOnly;
  useEffect(() => { actions.resumeVideoEdit?.(id); }, [id]);
  const document = data.editDocument;
  const fps = document?.outputProfile?.fps || { num: 24, den: 1 };
  const totalFrames = (document?.clips || []).reduce((sum, clip) => sum + (framesOf(clip, fps) ?? NaN), 0);
  const stale = Boolean(data.editResultAssetPath && data.editResultDocument !== JSON.stringify(document ?? null));
  return <div className="video-edit-node" data-status={data.status || 'idle'} onDoubleClick={(event) => { if (!event.target.closest('video, button, input, select')) setOpen(true); }}>
    {title}{toolbar}
    {VIDEO_EDIT_PORTS.map((port, index) => <React.Fragment key={port}>
      <Handle type="target" id={port} position={Position.Left} style={{ top: PORT_TOP + index * PORT_GAP }} isConnectable={!disabled} />
      <span className={`video-edit-port ${state.inputs[port] ? 'connected' : ''}`} style={{ top: PORT_TOP + index * PORT_GAP - 7 }}>{port}{state.inputs[port] ? ` · ${state.inputs[port].title}` : ''}</span>
    </React.Fragment>)}
    <Handle type="source" id="ref" position={Position.Right} style={{ top: 88 }} isConnectable={!actions.readOnly} title="成片视频，可连接下一个视频编辑节点" />
    <div className="video-edit-heading"><span><Clapperboard size={12} /> 帧精确剪辑 · 后端 FFmpeg</span><b>CPU</b></div>
    <div className="video-edit-body">
      <div className="video-edit-result nodrag nopan">
        {state.resultUrl ? <video src={state.resultUrl} controls preload="metadata" playsInline /> : <span>{state.error || '连接视频后双击或点「编辑视频」，导出结果显示在这里'}</span>}
      </div>
      <div className="video-edit-meta">
        <span>{(document?.clips || []).length} 个镜头</span>
        <span>{Number.isFinite(totalFrames) ? `${totalFrames} 帧 · ${timecode(totalFrames, fps)}` : '帧数在导出时按源时基计算'}</span>
        <span>{fps.den === 1 ? fps.num : (fps.num / fps.den).toFixed(3)} fps</span>
      </div>
      {data.editResult && <div className="video-edit-meta"><span>成片 {data.editResult.frames} 帧</span><span>{data.editResult.width}×{data.editResult.height}</span><span>{data.editResult.audio === 'none' ? '无声' : data.editResult.audio === 'external' ? '外挂原声' : '片段原声'}</span></div>}
      {data.error && <p className="video-edit-error" role="alert">{data.error}</p>}
    </div>
    <footer className="video-edit-footer nodrag">
      <button disabled={actions.readOnly} onClick={() => setOpen(true)}><SlidersHorizontal size={13} />编辑视频</button>
      <span>{running ? `${data.stage || '导出中'} ${Math.round((data.progress || 0) * 100)}%` : stale ? '参数已更新 · 待导出' : data.editResultAssetPath ? '结果已导出' : '未导出'}</span>
      {running
        ? <button className="video-edit-cancel" onClick={() => actions.cancelVideoEdit(id)}><Square size={12} />取消</button>
        : <button className="video-edit-export" disabled={disabled} onClick={() => actions.generateNode(id)}><ArrowDownToLine size={14} />导出</button>}
      {running && <LoaderCircle className="video-edit-spin" size={14} />}
    </footer>
    {open && <VideoEditorPanel id={id} data={data} state={state} actions={actions} onClose={() => setOpen(false)} />}
  </div>;
}
