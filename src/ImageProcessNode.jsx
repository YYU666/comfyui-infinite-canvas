import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { RotateCcw, ArrowDownToLine, LoaderCircle } from 'lucide-react';
import { BLEND_MODES, DEFAULT_ADJUSTMENTS, DEFAULT_HSL_SETTINGS, DEFAULT_LEVELS_SETTINGS } from './image-compositing';
import PhotoAdjustmentControls from './PhotoAdjustmentControls';
import { PHOTO_ADJUSTMENTS, DEFAULT_PHOTO_SETTINGS } from './photo-adjustments';
import ChannelPackControls from './ChannelPackControls';
import { DEFAULT_CHANNEL_PACK } from './channel-packing';
import { renderImageProcess } from './image-process-runtime';
import './image-process.css';

const CONTROLS = [
  ['brightness', '亮度', -100, 100, 1], ['contrast', '对比度', -100, 100, 1],
  ['saturation', '饱和度', -100, 100, 1], ['hue', '色相', -180, 180, 1],
  ['gamma', 'Gamma', 0.1, 3, 0.05], ['temperature', '色温', -100, 100, 1],
];
const ADJUSTMENT_GROUPS = [...new Set(PHOTO_ADJUSTMENTS.map((item) => item.group))].map((label) => ({
  label, items: PHOTO_ADJUSTMENTS.filter((item) => item.group === label),
}));

export default function ImageProcessNode({ id, data, actions, title, toolbar }) {
  const blend = data.mode === 'imageBlend';
  const pack = data.mode === 'channelPack';
  const adjustmentType = data.adjustmentType || 'basic';
  const maskInput = useRef(null);
  const [maskBusy, setMaskBusy] = useState(false);
  const state = actions.getImageProcessState(id);
  const running = ['running', 'uploading', 'finishing'].includes(data.status);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [before, setBefore] = useState(false);
  const signature = state.signature;
  useEffect(() => {
    const controller = new AbortController();
    let previewUrl;
    setPreview(null); setPreviewError('');
    if (state.error) { setPreviewBusy(false); return; }
    setPreviewBusy(true);
    const timer = setTimeout(async () => {
      try {
        const result = await renderImageProcess(data.mode, state.refs, state.settings, { maxEdge: 512, signal: controller.signal, previewChannel: data.packPreview || 'rgb' });
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(result.blob); previewUrl = url;
        setPreview({ ...result, blob: undefined, url }); setPreviewBusy(false);
      } catch (error) { if (error.name !== 'AbortError') { setPreviewError(error.message); setPreviewBusy(false); } }
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [signature, state.error, data.packPreview]);
  const patch = (settings) => actions.updateNode(id, { ...settings, error: null });
  const disabled = running || maskBusy || actions.readOnly;
  const mask = blend ? actions.getImageProcessMask(id) : null;
  const base = state.refs?.find((ref) => ref.data.slot === (blend ? 'base' : 'guide'));
  const current = !state.error && data.processedSignature === signature && data.processedAssetPath;
  return <div className="image-process-node" data-process-mode={data.mode}>
    {title}{toolbar}
    {(pack ? [['red', 'R · 红色通道', 85], ['green', 'G · 绿色通道', 113], ['blue', 'B · 蓝色通道', 141], ['alpha', 'A · 透明通道', 169]] : blend ? [['base', '底图', 85], ['overlay', '叠加图', 118], ['mask', '混合遮罩（可选）', 151]] : [['guide', '原图', 88]]).map(([port, label, top]) => <React.Fragment key={port}>
      <Handle type="target" id={port} position={Position.Left} style={{ top }} isConnectable={!disabled} />
      <span className="image-process-port" style={{ top: top - 7 }}>{label}</span>
    </React.Fragment>)}
    <Handle type="source" id="ref" position={Position.Right} style={{ top: 88 }} isConnectable={!disabled} />
    <div className="image-process-heading"><span>{pack ? 'RGBA 贴图通道打包' : blend ? '图层与材质混合' : '非破坏式颜色调整'}</span><b>本地处理</b></div>
    <div className="image-process-preview nodrag nopan" style={{ marginTop: pack ? 108 : blend ? 82 : 30 }}>
      {preview ? <img src={before ? base?.data.url : preview.url} alt={before ? '原图' : '处理预览'} /> : <span>{state.error || previewError || '正在准备预览…'}</span>}
      {previewBusy && <div className="image-process-preview-busy"><LoaderCircle size={15} />更新预览</div>}
      {preview && !pack && <button className="image-process-compare" aria-pressed={before} onClick={() => setBefore(!before)}>{before ? '查看效果' : '查看原图'}</button>}
    </div>
    <div className="image-process-controls nodrag nopan">
      {pack ? <ChannelPackControls id={id} data={data} refs={state.refs} patch={patch} disabled={disabled} actions={actions} onBusy={setMaskBusy} /> : blend ? <>
        <label className="image-process-select">混合模式<select aria-label="混合模式" value={data.blendMode || 'normal'} disabled={disabled} onChange={(e) => patch({ blendMode: e.target.value })}>{BLEND_MODES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="image-process-range"><span>混合强度<output>{data.opacity ?? 100}%</output></span><input aria-label="混合强度" type="range" min="0" max="100" value={data.opacity ?? 100} disabled={disabled} onChange={(e) => patch({ opacity: Number(e.target.value) })} /></label>
        <label className="image-process-select">叠加图适配<select aria-label="叠加图适配" value={data.fit || 'cover'} disabled={disabled} onChange={(e) => patch({ fit: e.target.value })}><option value="cover">等比填满（裁切）</option><option value="contain">完整居中（保留比例）</option><option value="stretch">拉伸至底图尺寸</option></select></label>
        <div className="image-process-mask">
          <div className="image-process-mask-source">{mask?.data.url && <img src={mask.data.url} alt="混合遮罩缩略图" />}<span>{mask ? mask.data.title || '已连接混合遮罩' : '混合遮罩 · 可选'}</span></div>
          <div className="image-process-mask-buttons"><button disabled={disabled} onClick={() => maskInput.current?.click()}>{maskBusy ? '正在添加…' : mask ? '更换遮罩' : '+ 添加混合遮罩'}</button>{mask && <button disabled={disabled} onClick={() => actions.disconnectImageProcessMask(id)}>断开遮罩</button>}</div>
          <input ref={maskInput} hidden type="file" aria-label="上传混合遮罩" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={async (event) => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            setMaskBusy(true);
            try { await actions.attachImageProcessMask(id, file); } catch (error) { actions.updateNode(id, { error: error.message }); } finally { setMaskBusy(false); }
          }} />
          <label className="image-process-select">遮罩通道<select aria-label="遮罩通道" value={data.maskChannel || 'luminance'} disabled={disabled} onChange={(e) => patch({ maskChannel: e.target.value })}>{[['luminance', '亮度（灰度）'], ['red', '红色 R'], ['green', '绿色 G'], ['blue', '蓝色 B'], ['alpha', '透明度 Alpha']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="image-process-mask-invert"><input type="checkbox" aria-label="反相遮罩" checked={data.maskInvert === true} disabled={disabled} onChange={(e) => patch({ maskInvert: e.target.checked })} />反相遮罩</label>
          <p>白色混合叠加图，黑色保留底图，灰色过渡。也可把图片节点连接到左侧混合遮罩端口。</p>
        </div>
        <p>以底图尺寸输出，遮罩缩放至底图尺寸。</p>
      </> : <>
        <div className="photo-adjustment-palette" role="group" aria-label="照片调色工具">
          {ADJUSTMENT_GROUPS.map((group) => <div className="photo-adjustment-tool-group" role="group" aria-label={group.label} key={group.label}>
            <span className="photo-adjustment-tool-heading">{group.label}</span>
            <div className="photo-adjustment-tool-buttons">{group.items.map(({ value, label }) => <button type="button" key={value} aria-pressed={adjustmentType === value} disabled={disabled} onClick={() => patch({ adjustmentType: value })}>{label}</button>)}</div>
          </div>)}
        </div>
        <label className="image-process-select">调整类型<select aria-label="调整类型" value={adjustmentType} disabled={disabled} onChange={(e) => patch({ adjustmentType: e.target.value })}>{ADJUSTMENT_GROUPS.map((group) => <optgroup key={group.label} label={group.label}>{group.items.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</optgroup>)}</select></label>
        {adjustmentType === 'basic' ? CONTROLS.map(([key, label, min, max, step]) => <label className="image-process-range" key={key}><span>{label}<input type="number" aria-label={`${label}数值`} min={min} max={max} step={step} value={data[key] ?? DEFAULT_ADJUSTMENTS[key]} disabled={disabled} onChange={(e) => { if (e.target.value !== '') patch({ [key]: Math.max(min, Math.min(max, Number(e.target.value))) }); }} /></span><input aria-label={label} type="range" min={min} max={max} step={step} value={data[key] ?? DEFAULT_ADJUSTMENTS[key]} disabled={disabled} onChange={(e) => patch({ [key]: Number(e.target.value) })} /></label>) : <PhotoAdjustmentControls data={data} patch={patch} disabled={disabled} baseUrl={base?.data.url} />}
        <p>每个节点应用一种调整，可串联多个节点叠加效果；切换类型会保留各自参数。</p>
      </>}
    </div>
    {data.error && <p className="image-process-error" role="alert">{data.error}</p>}
    <div className="image-process-tga-row nodrag"><span>32 位 TGA · 保留 Alpha</span>{current && state.tgaUrl ? <a href={state.tgaUrl} download={`${data.title || 'image'}.tga`}>下载 TGA</a> : <button disabled={disabled || Boolean(state.error) || Boolean(previewError)} onClick={() => actions.runImageProcess(id, { tga: true, download: true })}>导出 TGA</button>}</div>
    <footer className="image-process-footer nodrag"><button disabled={disabled} title="重置当前调整" onClick={() => patch(pack ? { packChannels: DEFAULT_CHANNEL_PACK.channels } : blend ? { blendMode: 'normal', opacity: 100, fit: 'cover', maskChannel: 'luminance', maskInvert: false } : adjustmentType === 'hsl' ? { hsl: DEFAULT_HSL_SETTINGS } : adjustmentType === 'levels' ? { levels: DEFAULT_LEVELS_SETTINGS } : adjustmentType === 'basic' ? { ...DEFAULT_ADJUSTMENTS } : { [adjustmentType]: DEFAULT_PHOTO_SETTINGS[adjustmentType] })}><RotateCcw size={13} />重置</button><span>{running ? data.stage || '处理中…' : current ? '结果已输出' : data.processedAssetPath ? '参数已更新 · 待输出' : preview ? `${preview.originalWidth} × ${preview.originalHeight}` : '连接图片开始'}</span><button className="image-process-output" disabled={disabled || Boolean(state.error) || Boolean(previewError)} onClick={() => actions.runImageProcess(id)}>{running ? <LoaderCircle size={14} /> : <ArrowDownToLine size={14} />}{running ? '处理中' : pack ? '输出 PNG + TGA' : '输出 PNG'}</button></footer>
  </div>;
}
