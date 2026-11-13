import React, { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { ArrowDownToLine, Box, LoaderCircle, Square } from 'lucide-react';
import { normalizePlateDocument, videoPlateSummary } from './video-plate-document';
import './video-plate.css';

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export default function VideoPlateNode({ id, data, actions, title, toolbar }) {
  const state = actions.getVideoPlateState(id);
  const running = ['running', 'queued'].includes(data.status) || state.busy;
  const disabled = running || actions.readOnly;
  const stale = videoPlateSummary(data).plateStale;
  const [promptDraft, setPromptDraft] = useState((data.keepPrompts || ['person', 'pole']).join(', '));
  const [hexDraft, setHexDraft] = useState(data.greenColor || '#00FF00');
  useEffect(() => { actions.resumeVideoPlate?.(id); }, [id]);
  useEffect(() => { setPromptDraft((data.keepPrompts || ['person', 'pole']).join(', ')); }, [data.keepPrompts]);
  useEffect(() => { setHexDraft(data.greenColor || '#00FF00'); }, [data.greenColor]);
  const patch = (values) => actions.updateNode(id, values);
  const colorValue = /^#[0-9A-Fa-f]{6}$/.test(data.greenColor || '') ? data.greenColor : '#00FF00';
  const commitPrompts = () => {
    try {
      const next = normalizePlateDocument({ keepPrompts: promptDraft });
      patch({ keepPrompts: next.keepPrompts, error: null });
    } catch (error) {
      patch({ error: error.message });
      setPromptDraft((data.keepPrompts || ['person', 'pole']).join(', '));
    }
  };

  return <div className="video-plate-node" data-status={data.status || 'idle'}>
    {title}{toolbar}
    <Handle type="target" id="v1" position={Position.Left} style={{ top: 78 }} isConnectable={!disabled} title="输入视频" />
    <span className={`video-plate-ports${state.input ? ' connected' : ''}`}>{state.input ? state.input.title : 'v1 视频'}</span>
    <Handle type="source" id="ref" position={Position.Right} style={{ top: 78 }} isConnectable={!actions.readOnly} title="导出后登记为「绿幕白模成片」，可连到角色替换的源视频" />
    <div className="video-plate-heading"><span><Box size={12} /> 绿幕白模</span><b>SAM3</b></div>
    <div className="video-plate-controls nodrag nopan">
      <p>人物和提示词里的物体留成白模，其余（含白地板）变成纯绿幕。分割走本机官方 SAM3，不下载新模型。</p>
      <label>留下<input aria-label="留下的物体" value={promptDraft} disabled={disabled} spellCheck={false} onChange={(event) => setPromptDraft(event.target.value)} onBlur={commitPrompts} /></label>
      <div className="video-plate-grid">
        <label>扩张<input aria-label="遮罩扩张" type="number" min="0" max="64" step="1" value={data.maskGrow ?? 8} disabled={disabled} onChange={(event) => patch({ maskGrow: numberOr(event.target.value, 8) })} /></label>
        <label>羽化<input aria-label="遮罩羽化" type="number" min="0" max="32" step="1" value={data.maskFeather ?? 2} disabled={disabled} onChange={(event) => patch({ maskFeather: numberOr(event.target.value, 2) })} /></label>
        <label>白模<select aria-label="白模着色" value={data.shadeMode || 'flat'} disabled={disabled} onChange={(event) => patch({ shadeMode: event.target.value })}>
          <option value="flat">平涂白</option>
          <option value="shaded">明暗白</option>
        </select></label>
        <label>绿幕<div className="video-plate-color">
          <input aria-label="绿幕颜色" type="color" value={colorValue} disabled={disabled} onChange={(event) => patch({ greenColor: event.target.value.toUpperCase() })} />
          <input aria-label="绿幕十六进制" value={hexDraft} disabled={disabled} spellCheck={false} onChange={(event) => setHexDraft(event.target.value)} onBlur={() => { if (/^#[0-9A-Fa-f]{6}$/.test(hexDraft)) patch({ greenColor: hexDraft.toUpperCase() }); else setHexDraft(data.greenColor || '#00FF00'); }} />
        </div></label>
      </div>
      <p className="video-plate-note">默认留下 person 和 pole，杆子会跟人物一起留下来。当前这条 SAM3 只吃文字提示，没有点或框。导出后旁边出现「绿幕白模成片」。把该视频连到角色替换上方的源视频，身份图连到下方。从本节点输出口连出时，也会改接到那条成片。</p>
    </div>
    <div className="video-plate-stage nodrag nopan">
      {state.resultUrl ? <video src={state.resultUrl} controls preload="metadata" playsInline /> : <span>连接视频后导出。成片宽高、帧数和帧率跟输入一致。</span>}
    </div>
    {data.plateResult && <div className="video-plate-meta"><span>{data.plateResult.width}×{data.plateResult.height}</span><span>{data.plateResult.frames} 帧</span><span>{data.plateResult.shadeMode === 'shaded' ? '明暗白' : '平涂白'}</span></div>}
    {data.error && <p className="video-plate-error" role="alert">{data.error}</p>}
    <footer>
      <span>{running ? `${data.stage || '导出中'} ${Math.round((data.progress || 0) * 100)}%` : stale ? '参数已更新 · 待导出' : data.plateResultAssetPath ? '成片已登记' : '未导出'}</span>
      {running
        ? <button type="button" onClick={() => actions.cancelVideoPlate(id)}><Square size={12} />取消</button>
        : <button type="button" className="video-plate-export" disabled={disabled} onClick={() => actions.generateNode(id)}><ArrowDownToLine size={14} />导出</button>}
      {running && <LoaderCircle className="video-plate-spin" size={14} />}
    </footer>
  </div>;
}
