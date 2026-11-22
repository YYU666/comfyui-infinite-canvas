import React from 'react';
import { Handle, Position } from '@xyflow/react';
import ModelLicenseNotice from './ModelLicenseNotice.jsx';
import { MOSS_POSE_DEFAULTS } from './moss-pose.js';

export default function MossPoseNode({ id, data, selected, actions, title, nodeActions }) {
  const { updateNode, generateNode, cancelNode, getReferences, openImagePreview, serverOnline, readOnly } = actions;
  const busy = ['uploading', 'queued', 'running', 'finishing'].includes(data.status);
  const settings = { ...MOSS_POSE_DEFAULTS, ...data };
  const refs = getReferences(id);
  const hasIdentity = refs.some(ref => ref.data.slot === 'identity');
  const change = patch => updateNode(id, { ...patch, error: null });
  const locked = busy || readOnly;
  return <div className={`h3-node generator-shell moss-pose-node ${selected ? 'selected' : ''} ${busy ? 'running' : ''}`}>
    {title}{nodeActions}
    <div className="generator-preview" onDoubleClick={() => data.resultUrl && openImagePreview({ url: data.resultUrl, title: data.title })}>
      {data.resultUrl ? <img src={data.resultUrl} alt="姿势生成结果" /> : <strong>{busy ? data.stage : '姿势参考 → MOSS → 可选 Qwen 角色对齐'}</strong>}
    </div>
    <p className="media-quality-note">本地组合工作流 · 待实测。骨架控制姿势；连接角色四视图后，额外使用 Qwen 对齐身份与穿搭，耗时会增加。</p>
    {settings.poseInput === 'photo' && <p className="media-quality-note">照片预处理另需手工安装 comfyui_controlnet_aux 及两份 DWPose ONNX 辅助文件，并通过本地 SHA-256 校验；不会自动下载。已有 OpenPose 骨架不需要这些辅助文件。</p>}
    <div className="media-quality-ports"><span>姿势参考 {refs.some(ref => ref.data.slot === 'guide') ? '✓' : '未连接'}</span><span>角色四视图（可选）{hasIdentity ? '✓' : ''}</span></div>
    <Handle type="target" position={Position.Left} id="guide" style={{ top: 110 }} className="neo-handle" />
    <Handle type="target" position={Position.Left} id="identity" style={{ top: 165 }} className="neo-handle" />
    <div className="media-quality-settings nodrag nowheel">
      <label>姿势输入<select aria-label="姿势输入" value={settings.poseInput} disabled={locked} onChange={e => change({ poseInput: e.target.value })}><option value="photo">照片 → DWPose 骨架</option><option value="skeleton">已有彩色 OpenPose 骨架</option></select></label>
      {[['poseResolution', '骨架分辨率', 256, 1536, 64], ['poseSteps', 'MOSS 步数', 1, 60, 1], ['poseCfg', '提示词强度', 1, 10, 0.1], ['poseLoraStrength', '姿势 LoRA 强度', 0, 2, 0.05], ['seed', '种子', 0, 2147483647, 1]].map(([key, label, min, max, step]) => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} disabled={locked} value={settings[key]} onChange={e => change({ [key]: Number(e.target.value) })} /></label>)}
      <label><input type="checkbox" checked={Boolean(settings.randomSeed)} disabled={locked} onChange={e => change({ randomSeed: e.target.checked })} />每次随机种子</label>
      <label>生成要求<textarea aria-label="姿势生成要求" rows={4} disabled={locked} value={data.prompt || ''} placeholder="描述单人角色、服装、写实风格及场景" onChange={e => change({ prompt: e.target.value })} /></label>
    </div>
    <ModelLicenseNotice data={{ ...data, poseHasIdentity: hasIdentity }} />
    {data.error && <p className="custom-workflow-error" role="alert">{data.error}</p>}
    <div className="custom-workflow-footer"><span role="status">{data.stage || '尚未运行'}{busy ? ` ${data.progress || 0}%` : ''}</span><button className="node-share-button nodrag" disabled={readOnly || (!busy && !serverOnline)} onClick={() => busy ? cancelNode(id) : generateNode(id)}>{busy ? '取消' : hasIdentity ? '生成姿势并对齐角色' : '生成姿势'}</button></div>
    <Handle type="source" position={Position.Right} id="image" className="neo-handle source" />
  </div>;
}
