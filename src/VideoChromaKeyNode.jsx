import React, { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Aperture, ArrowDownToLine, LoaderCircle, Pipette, Square } from 'lucide-react';
import { CHROMA_ANCHORS, CHROMA_FITS, videoChromaSummary } from './video-chroma-document';
import './video-chroma.css';

const ANCHOR_LABEL = { center: '居中', top: '上', bottom: '下', left: '左', right: '右', topLeft: '左上', topRight: '右上', bottomLeft: '左下', bottomRight: '右下' };
const FIT_LABEL = { cover: '覆盖', contain: '包含', stretch: '拉伸' };

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export default function VideoChromaKeyNode({ id, data, actions, title, toolbar }) {
  const state = actions.getVideoChromaState(id);
  const running = ['running', 'queued'].includes(data.status) || state.busy;
  const disabled = running || actions.readOnly;
  const stale = videoChromaSummary(data).chromaStale;
  const [hexDraft, setHexDraft] = useState(data.keyColor || '#00FF00');
  const [secondHexDraft, setSecondHexDraft] = useState(data.secondKeyColor || '#FFFFFF');
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [previewError, setPreviewError] = useState('');
  useEffect(() => { actions.resumeVideoChroma?.(id); }, [id]);
  useEffect(() => { setHexDraft(data.keyColor || '#00FF00'); }, [data.keyColor]);
  useEffect(() => { setSecondHexDraft(data.secondKeyColor || '#FFFFFF'); }, [data.secondKeyColor]);
  const patch = (values) => actions.updateNode(id, values);
  const setNumber = (key, fallback) => (event) => patch({ [key]: numberOr(event.target.value, fallback) });

  async function runPreview(mode) {
    setPreviewError('');
    setPreviewing(true);
    setSampling(false);
    try {
      const result = await actions.previewVideoChroma(id, { mode, time: data.previewTime || 0 });
      if (!result?.ok) throw new Error(result?.error || '预览失败。');
      setPreview({ url: `data:image/png;base64,${result.pngBase64}`, mode: result.mode, frame: result.frame });
      setSampling(mode === 'foreground');
    } catch (error) {
      setPreviewError(error.message);
    } finally {
      setPreviewing(false);
    }
  }

  function sampleColor(event) {
    if (!sampling) return;
    const image = event.currentTarget;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const drawnWidth = image.naturalWidth * scale;
    const drawnHeight = image.naturalHeight * scale;
    const x = (event.clientX - rect.left - (rect.width - drawnWidth) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - drawnHeight) / 2) / scale;
    if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixel = context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    const next = `#${[...pixel.slice(0, 3)].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    patch({ keyColor: next });
    setSampling(false);
  }

  const colorValue = /^#[0-9A-Fa-f]{6}$/.test(data.keyColor || '') ? data.keyColor : '#00FF00';
  const secondColorValue = /^#[0-9A-Fa-f]{6}$/.test(data.secondKeyColor || '') ? data.secondKeyColor : '#FFFFFF';
  return <div className="video-chroma-node" data-status={data.status || 'idle'}>
    {title}{toolbar}
    <Handle type="target" id="fg" position={Position.Left} style={{ top: 72 }} isConnectable={!disabled} title="前景：绿幕视频" />
    <Handle type="target" id="bg" position={Position.Left} style={{ top: 104 }} isConnectable={!disabled} title="背景：图片或视频" />
    <div className="video-chroma-ports">
      <span className={state.foreground ? 'connected' : ''}>{state.foreground ? state.foreground.title : 'fg 绿幕视频'}</span>
      <span className={state.background ? 'connected' : ''}>{state.background ? state.background.title : 'bg 背景'}</span>
    </div>
    <Handle type="source" id="ref" position={Position.Right} style={{ top: 88 }} isConnectable={!actions.readOnly} title="成片可连接到视频编辑、节奏或其他扣像节点" />
    <div className="video-chroma-heading"><span><Aperture size={12} /> 绿幕扣像合成</span><b>CPU</b></div>
    <div className="video-chroma-controls nodrag nopan">
      <p>前景绿幕叠到背景上。成片尺寸默认跟背景，帧率、时长和声音跟前景。静止背景会循环；较短的视频背景停在最后一帧。</p>
      <label>键色<div className="video-chroma-color">
        <input aria-label="键色取色" type="color" value={colorValue} disabled={disabled} onChange={(event) => patch({ keyColor: event.target.value.toUpperCase() })} />
        <input aria-label="键色十六进制" value={hexDraft} disabled={disabled} spellCheck={false} onChange={(event) => setHexDraft(event.target.value)} onBlur={() => { if (/^#[0-9A-Fa-f]{6}$/.test(hexDraft)) patch({ keyColor: hexDraft.toUpperCase() }); else setHexDraft(data.keyColor || '#00FF00'); }} />
      </div></label>
      <div className="video-chroma-grid">
        <label>相似<input aria-label="相似度" type="number" min="0" max="1" step="0.01" value={data.similarity ?? 0.2} disabled={disabled} onChange={setNumber('similarity', 0.2)} /></label>
        <label>柔和<input aria-label="边缘柔和" type="number" min="0" max="1" step="0.01" value={data.blend ?? 0.08} disabled={disabled} onChange={setNumber('blend', 0.08)} /></label>
        <label>溢色<input aria-label="溢色抑制" type="number" min="0" max="1" step="0.01" value={data.despill ?? 0.5} disabled={disabled} onChange={setNumber('despill', 0.5)} /></label>
        <label>收缩<input aria-label="边缘收缩" type="number" min="0" max="8" step="1" value={data.choke ?? 0} disabled={disabled} onChange={setNumber('choke', 0)} /></label>
        <label>羽化<input aria-label="边缘羽化" type="number" min="0" max="16" step="1" value={data.feather ?? 0} disabled={disabled} onChange={setNumber('feather', 0)} /></label>
      </div>
      <label className="video-chroma-toggle">第二键色
        <input aria-label="第二键色" type="checkbox" checked={data.secondKey === true} disabled={disabled} onChange={(event) => patch({ secondKey: event.target.checked })} />
      </label>
      <label>第二色<div className="video-chroma-color">
        <input aria-label="第二键色取色" type="color" value={secondColorValue} disabled={disabled} onChange={(event) => patch({ secondKeyColor: event.target.value.toUpperCase() })} />
        <input aria-label="第二键色十六进制" value={secondHexDraft} disabled={disabled} spellCheck={false} onChange={(event) => setSecondHexDraft(event.target.value)} onBlur={() => { if (/^#[0-9A-Fa-f]{6}$/.test(secondHexDraft)) patch({ secondKeyColor: secondHexDraft.toUpperCase() }); else setSecondHexDraft(data.secondKeyColor || '#FFFFFF'); }} />
      </div></label>
      <div className="video-chroma-grid">
        <label>二相似<input aria-label="第二键色相似度" type="number" min="0" max="1" step="0.01" value={data.secondSimilarity ?? 0.06} disabled={disabled} onChange={setNumber('secondSimilarity', 0.06)} /></label>
        <label>二柔和<input aria-label="第二键色柔和" type="number" min="0" max="1" step="0.01" value={data.secondBlend ?? 0.02} disabled={disabled} onChange={setNumber('secondBlend', 0.02)} /></label>
      </div>
      <div className="video-chroma-grid">
        <label>缩放<input aria-label="前景缩放" type="number" min="0.05" max="8" step="0.01" value={data.scale ?? 1} disabled={disabled} onChange={setNumber('scale', 1)} /></label>
        <label>横移<input aria-label="水平偏移" type="number" step="1" value={data.offsetX ?? 0} disabled={disabled} onChange={setNumber('offsetX', 0)} /></label>
        <label>纵移<input aria-label="垂直偏移" type="number" step="1" value={data.offsetY ?? 0} disabled={disabled} onChange={setNumber('offsetY', 0)} /></label>
      </div>
      <div className="video-chroma-grid">
        <label>锚点<select aria-label="前景锚点" value={data.anchor || 'center'} disabled={disabled} onChange={(event) => patch({ anchor: event.target.value })}>
          {CHROMA_ANCHORS.map((value) => <option key={value} value={value}>{ANCHOR_LABEL[value]}</option>)}
        </select></label>
        <label>背景<select aria-label="背景适配" value={data.backgroundFit || 'cover'} disabled={disabled} onChange={(event) => patch({ backgroundFit: event.target.value })}>
          {CHROMA_FITS.map((value) => <option key={value} value={value}>{FIT_LABEL[value]}</option>)}
        </select></label>
        <label>画幅<select aria-label="成片尺寸" value={data.outputSize || 'background'} disabled={disabled} onChange={(event) => patch({ outputSize: event.target.value })}>
          <option value="background">跟背景</option>
          <option value="foreground">跟前景</option>
        </select></label>
        <label>声音<select aria-label="前景声音" value={data.chromaAudio || 'preserve'} disabled={disabled} onChange={(event) => patch({ chromaAudio: event.target.value })}>
          <option value="preserve">前景原声</option>
          <option value="mute">静音</option>
        </select></label>
      </div>
      <label>起点<input aria-label="背景起点" type="number" min="0" step="0.001" value={data.startOffset ?? 0} disabled={disabled} onChange={setNumber('startOffset', 0)} /></label>
      <p className="video-chroma-note">缩放 1 是前景原始像素，居中叠到背景上。480×832 的人物叠到 720×1280 夜景时，四周会露出背景。收缩和羽化按前景像素计算。第二键色默认关闭；打开后与绿幕一起抠除，默认白色、相似度 0.06。调低相似度可以保住人物高光。</p>
      <label>预览秒<input aria-label="预览时间" type="number" min="0" step="0.001" value={data.previewTime ?? 0} disabled={disabled} onChange={setNumber('previewTime', 0)} /></label>
      <div className="video-chroma-actions">
        <button type="button" disabled={disabled || previewing} onClick={() => runPreview('composite')}>预览合成</button>
        <button type="button" disabled={disabled || previewing} onClick={() => runPreview('matte')}>棋盘格</button>
        <button type="button" disabled={disabled || previewing} onClick={() => runPreview('foreground')}><Pipette size={12} />吸取绿幕</button>
      </div>
    </div>
    <div className="video-chroma-stage nodrag nopan">
      {preview?.url ? <img src={preview.url} alt={preview.mode === 'foreground' ? '未抠像的前景帧' : '绿幕预览'} className={sampling ? 'sampling' : ''} onClick={sampleColor} />
        : state.resultUrl ? <video src={state.resultUrl} controls preload="metadata" playsInline />
          : <span>连接绿幕视频和背景后，可以先预览一帧再导出。吸取颜色会显示未抠像的前景，点一下画面设置键色。</span>}
    </div>
    {data.chromaResult && <div className="video-chroma-meta"><span>{data.chromaResult.width}×{data.chromaResult.height}</span><span>{data.chromaResult.frames} 帧</span><span>{data.chromaResult.audio === 'mute' ? '无声' : '前景原声'}</span></div>}
    {preview?.frame != null && previewing === false && <p className="video-chroma-note" style={{ margin: '6px 14px 0' }}>{sampling ? '点击预览中的绿幕取色。' : `预览第 ${preview.frame} 帧。`}</p>}
    {(previewError || data.error) && <p className="video-chroma-error" role="alert">{previewError || data.error}</p>}
    <footer>
      <span>{running ? `${data.stage || '导出中'} ${Math.round((data.progress || 0) * 100)}%` : stale ? '参数已更新 · 待导出' : data.chromaResultAssetPath ? '结果已导出' : '未导出'}</span>
      {running
        ? <button type="button" onClick={() => actions.cancelVideoChroma(id)}><Square size={12} />取消</button>
        : <button type="button" className="video-chroma-export" disabled={disabled} onClick={() => actions.generateNode(id)}><ArrowDownToLine size={14} />导出</button>}
      {(running || previewing) && <LoaderCircle className="video-chroma-spin" size={14} />}
    </footer>
  </div>;
}
