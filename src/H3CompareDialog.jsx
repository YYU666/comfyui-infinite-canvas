import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { h3FrameTarget, h3MediaUrl, loadH3Comparison, presentH3Frame, seconds } from './h3-compare.js';
import './h3-compare.css';

const REASONS = {
  'route-unavailable': '当前工作台后端尚未提供同帧核验，二采片可单独播放。',
  'preview-only': '同帧核验数据暂不可用。',
  'result-kind': '此节点没有可读取的 H3 二采文件记录。',
  'asset-identity': '项目里保存的视频丢失或未通过资产身份校验。',
  'result-missing': '二采文件已移除或无法读取。',
  'receipt-unreadable': '无法读取二采文件的内嵌工作流。',
  'receipt-missing': '二采文件没有可识别的执行记录，无法确定原片。',
  'source-missing': '执行记录指向的原片已移除或无法读取。',
  'source-newer': '原片文件的修改时间晚于二采成片，无法确认仍是同一份输入。',
  'media-changed': '读取时文件发生变化，请关掉对照窗口后重开。',
  'probe-unavailable': '无法取得两路完整的解码帧时间戳。',
  'nonzero-start': '两路未同时从零时刻开始，无法按同一播放时钟定位。',
  'frame-count': '原片和二采片的解码帧数不同。',
  timestamps: '两路解码帧时间戳不同。',
  'video-end': '两路视频结束时间无法核对或不一致。',
};

function clipFacts(media) {
  if (!media?.frameCount) return '';
  const fps = seconds(media.fps);
  const duration = seconds(media.duration);
  return [media.width + '×' + media.height, media.frameCount + ' 帧',
    fps ? Number(fps.toFixed(3)) + ' fps' : null, duration === null ? null : duration.toFixed(3) + ' 秒']
    .filter(Boolean).join(' · ');
}

function Clip({ videoRef, label, media, controls, onReady, onError }) {
  return <section className="h3-review-clip" aria-label={label}>
    <h3>{label}</h3>
    {media
      ? <video ref={videoRef} src={h3MediaUrl(media)} playsInline muted={!controls}
          controls={controls} preload="auto" aria-label={label}
          onLoadedMetadata={onReady} onError={onError} />
      : <div className="h3-review-empty">素材不可用</div>}
    {clipFacts(media) && <div className="h3-review-facts">{clipFacts(media)}</div>}
  </section>;
}

function Comparison({ result }) {
  const source = useRef(null);
  const refined = useRef(null);
  const [ready, setReady] = useState({ source: false, refined: false });
  const [frame, setFrame] = useState(0);
  const [display, setDisplay] = useState(null);
  const [independent, setIndependent] = useState(false);
  const [failed, setFailed] = useState(false);
  const clock = result.clock;
  const synchronized = Boolean(clock) && !independent;
  const bothReady = ready.source && ready.refined;
  const markReady = (key) => setReady((old) => old[key] ? old : { ...old, [key]: true });

  useEffect(() => {
    if (!synchronized || !bothReady || failed) return;
    const controller = new AbortController();
    const { signal } = controller;
    const target = h3FrameTarget(clock, frame);
    Promise.all([
      presentH3Frame(source.current, target, signal),
      presentH3Frame(refined.current, target, signal),
    ]).then(() => {
      if (!signal.aborted) setDisplay({ frame });
    }).catch((error) => {
      if (!signal.aborted) {
        setDisplay({ frame, error: error.message });
        controller.abort();
      }
    });
    return () => controller.abort();
  }, [synchronized, bothReady, clock, frame, failed]);

  const selected = display?.frame === frame ? display : null;
  const target = clock && h3FrameTarget(clock, frame);
  const warning = failed ? '一条视频无法播放。' : synchronized && selected?.error;
  const status = warning || (
    synchronized
      ? selected ? '两路已显示目标帧' : '正在核对两路显示帧…'
      : REASONS[result.reason] || '独立播放'
  );
  return <>
    <div className="h3-review-media">
      <Clip label="原片" media={result.source} videoRef={source} controls={!synchronized}
        onReady={() => markReady('source')} onError={() => setFailed(true)} />
      <Clip label="二采片" media={result.refined} videoRef={refined} controls={!synchronized}
        onReady={() => markReady('refined')} onError={() => setFailed(true)} />
    </div>
    <div className="h3-review-footer">
      {synchronized && <div className="h3-review-nav">
        <button type="button" aria-label="上一帧" disabled={frame === 0 || failed}
          onClick={() => setFrame((value) => Math.max(0, value - 1))}><ChevronLeft size={17} /></button>
        <input type="range" aria-label="对照帧" min="0" max={clock.count - 1} step="1"
          value={frame} disabled={clock.count < 2 || failed} onChange={(event) => setFrame(event.currentTarget.valueAsNumber)} />
        <button type="button" aria-label="下一帧" disabled={frame >= clock.count - 1 || failed}
          onClick={() => setFrame((value) => Math.min(clock.count - 1, value + 1))}><ChevronRight size={17} /></button>
        <span className="h3-review-index">{frame + 1} / {clock.count} 帧 · {target?.pts.toFixed(3)} 秒</span>
      </div>}
      <div className="h3-review-status">
        <span role="status" data-ready={synchronized && Boolean(selected && !warning)}>{status}</span>
        {clock && <button type="button" onClick={() => {
          source.current?.pause();
          refined.current?.pause();
          setDisplay(null);
          setIndependent(!independent);
        }}>{independent ? '返回同帧对照' : '独立播放'}</button>}
      </div>
      {result.aspectDiffers && <div>两个视频画幅比例不同。原画幅并排显示，像素位置不可直接比较。</div>}
      {result.provenance && <div>原片路径来自二采文件的内嵌工作流。历史输入没有内容哈希。</div>}
    </div>
  </>;
}

export default function H3CompareDialog({ projectId, nodeId, fallbackMedia, onClose }) {
  const dialog = useRef(null);
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    loadH3Comparison(projectId, nodeId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLoaded({ projectId, nodeId, result });
    }).catch((error) => {
      if (!controller.signal.aborted) setLoaded({
        projectId, nodeId, error: error.message, routeUnavailable: error.routeUnavailable,
      });
    });
    return () => controller.abort();
  }, [projectId, nodeId]);
  const current = loaded?.projectId === projectId && loaded?.nodeId === nodeId ? loaded : null;
  const preview = current?.error && fallbackMedia ? {
    refined: fallbackMedia, reason: current.routeUnavailable ? 'route-unavailable' : 'preview-only',
  } : null;
  const comparison = current?.result || preview;
  return <dialog ref={dialog} className="h3-review" aria-label="H3 原片与二采对照"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="h3-review-header">
      <h2>原片与二采对照</h2>
      <button type="button" aria-label="关闭对照" onClick={onClose}><X size={18} /></button>
    </header>
    {comparison ? <Comparison key={nodeId} result={comparison} /> : (
      <div className="h3-review-footer" role="status">{current?.error || '正在读取二采记录与帧时间戳…'}</div>
    )}
  </dialog>;
}
