import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { COMPARISON_FIELDS, describeImageStage, imageFit, inspectionStage, parameterDifference, zoomImageView } from './image-comparison.js';
import './image-comparison.css';

function useImageRecord(image) {
  const query = image?.query;
  const key = query && new URLSearchParams(query).toString();
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let mounted = true;
    async function load() {
      try {
        const response = await fetch('/api/queue/inspect?' + key, { signal: controller.signal });
        if (!response.ok) throw new Error('missing');
        const stage = inspectionStage(await response.json(), Object.fromEntries(new URLSearchParams(key)));
        if (mounted) setLoaded({ key, record: describeImageStage(stage), missing: !stage });
      } catch {
        if (mounted) setLoaded({ key, record: null, missing: true });
      } finally { clearTimeout(timer); }
    }
    void load();
    return () => { mounted = false; clearTimeout(timer); controller.abort(); };
  }, [key]);
  if (!key) return { message: '无关联执行记录' };
  if (loaded?.key !== key) return { message: '正在读取执行记录…' };
  if (loaded.missing) return { message: '对应的执行记录缺失或不可读' };
  if (loaded.record?.provenance === 'execution') return { ...loaded, message: '实际执行 · ComfyUI 历史' };
  return { ...loaded, message: '已存计划 · 实际执行未核实' };
}

function ImagePane({ image, empty, label, state, onLoaded, onMeasure, view, onWheel, onDrag }) {
  const viewport = useRef(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    function resize() { onMeasure?.({ width: element.clientWidth, height: element.clientHeight }); }
    resize();
    if (!globalThis.ResizeObserver) { window.addEventListener('resize', resize); }
    const observer = globalThis.ResizeObserver ? new ResizeObserver(resize) : null;
    observer?.observe(element);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); };
  }, [onMeasure]);
  useEffect(() => {
    const element = viewport.current;
    const listener = event => {
      if (!image?.url) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      onWheel(delta, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    };
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, [image?.url, onWheel]);
  const crop = state?.crop;
  const scale = view.scale;
  return <figure className="image-compare-pane">
    <figcaption><strong>{label}</strong><span title={image?.title}>{image?.title}</span>
      {state?.size && <small>{state.size.width} × {state.size.height} px</small>}
    </figcaption>
    <div className="image-compare-viewport" ref={viewport} {...onDrag}>
      {image?.url && !state?.error && <div className="image-compare-pixels" style={state?.size ? {
        width: state.size.width * scale, height: state.size.height * scale,
        transform: 'translate(' + (-view.x * scale) + 'px, ' + (-view.y * scale) + 'px)',
      } : { visibility: 'hidden' }}>
        <img src={image.url} draggable={false} alt={image.title} onLoad={(event) => {
          const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
          if (image.crop && (image.crop.x + image.crop.width > width || image.crop.y + image.crop.height > height)) {
            onLoaded({ error: '记录裁切超出原图，无法对齐。' });
          } else onLoaded({ natural: { width, height }, crop: image.crop, size: image.crop || { width, height } });
        }} onError={() => onLoaded({ error: '原图文件无法读取。' })} style={state?.natural ? {
          width: state.natural.width * scale, height: state.natural.height * scale,
          left: -(crop?.x || 0) * scale, top: -(crop?.y || 0) * scale,
        } : undefined} />
      </div>}
      {(!image?.url || state?.error || !state?.size) && <p role="status">{state?.error || (image?.url ? '正在加载原图…' : empty)}</p>}
    </div>
  </figure>;
}

function ParameterTable({ left, right, leftState, rightState, isInput }) {
  const fields = (record, state) => ({
    ...record.record?.fields,
    size: state?.natural ? [state.natural.width + ' × ' + state.natural.height] : [],
  });
  const leftFields = fields(left, leftState);
  const rightFields = fields(right, rightState);
  function cell(id, values, info, isLeft) {
    if (values?.length) return values.join('\n');
    if (id === 'size') return '原图尺寸缺失';
    if (id === 'positive' && info.record?.fields.promptInput?.length) return '运行时扩写文本未记录';
    if (isLeft && isInput) return '不适用（输入图）';
    return info.record ? '记录未提供' : '缺失';
  }
  return <details className="image-compare-details" open>
    <summary>参数差异与记录缺失</summary>
    <div className="image-compare-metadata">
      <table>
        <caption className="image-compare-visually-hidden">来源与结果参数</caption>
        <thead><tr><th scope="col">参数</th><th scope="col">来源 · {isInput ? '记录输入' : left.message}</th><th scope="col">结果 · {right.message}</th></tr></thead>
        <tbody>{COMPARISON_FIELDS.map(([id, label]) => {
          const difference = parameterDifference(leftFields[id], rightFields[id]);
          return <tr key={id} data-difference={difference}>
            <th scope="row">{label}{difference === 'different' && <small>{[left, right].some((info) => info.record?.provenance === 'persisted-plan') && id !== 'size' ? '与已存计划不同' : '有差异'}</small>}</th>
            <td>{cell(id, leftFields[id], left, true)}</td><td>{cell(id, rightFields[id], right, false)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </details>;
}

export default function ImageComparison({ result, candidates }) {
  const rightRecord = useImageRecord(result);
  const [selected, setSelected] = useState('reference');
  const record = rightRecord.record;
  const refs = record?.provenance === 'execution' ? record.inputs : [];
  const refIndex = selected.startsWith('ref:') ? Number(selected.slice(4)) : 0;
  const isInput = selected === 'reference' || selected.startsWith('ref:');
  const activeRef = isInput ? refs[refIndex] : null;
  const fromCanvas = isInput ? null : candidates.find((image) => image.id === selected);
  const leftRecord = useImageRecord(fromCanvas);
  const leftImage = activeRef ? { ...activeRef, title: activeRef.name || '输入文件缺失' } : fromCanvas;
  const missingSource = activeRef?.reason || (!result.query ? '这张图没有可追溯的运行 ID，可手动选择对照图。'
    : record?.provenance === 'execution' ? '执行图没有记录可显示的图片输入，可手动选择对照图。'
      : rightRecord.message + '，无法确认当时使用的原图。');
  return <div className="image-compare">
    <div className="image-compare-pick">
      <label>左侧图片 <select value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="reference">执行记录中的首个输入</option>
        {refs.map((ref, index) => <option key={index} value={'ref:' + index}>{ref.order ? '图' + ref.order + ' · ' : '文件输入 · '}{ref.name || '来源未还原'}</option>)}
        {candidates.length > 0 && <optgroup label="手动选择画布图片">{candidates.map((image) => <option key={image.id} value={image.id}>{image.title}{image.name && image.name !== image.title ? ' · ' + image.name : ''}</option>)}</optgroup>}
      </select></label>
      {activeRef?.crop && <span>左图使用记录裁切 ({activeRef.crop.x}, {activeRef.crop.y}) · {activeRef.crop.width} × {activeRef.crop.height} px</span>}
    </div>
    <SynchronizedImages key={selected} left={leftImage} right={result} leftRecord={leftRecord}
      rightRecord={rightRecord} missingSource={missingSource} isInput={isInput} />
  </div>;
}

function SynchronizedImages({ left, right, leftRecord, rightRecord, missingSource, isInput }) {
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [view, setView] = useState(null);
  const [leftState, setLeft] = useState(null);
  const [rightState, setRight] = useState(null);
  const drag = useRef(null);
  const leftImageKey = (left?.url || '') + JSON.stringify(left?.crop || null);
  const shownLeft = leftState?.key === leftImageKey ? leftState : null;
  const fit = imageFit(viewport, [shownLeft?.size, rightState?.size]);
  const current = view || fit;
  const zoom = (step, x, y) => setView((before) => {
    const basis = before || fit;
    return zoomImageView(basis, Math.min(8, Math.max(Math.min(fit.scale, 0.125), basis.scale * step)), x, y);
  });
  const wheel = (delta, x, y) => zoom(Math.exp(-delta * 0.0015), x, y);
  const onDrag = {
    onPointerDown(event) {
      if (event.button !== 0 || !rightState?.size) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerMove(event) {
      if (drag.current?.id !== event.pointerId) return;
      const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      setView((previous) => {
        const camera = previous || fit;
        return { ...camera, x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale };
      });
    },
    onLostPointerCapture() { drag.current = null; },
    onPointerCancel() { drag.current = null; },
    onDoubleClick() { setView(null); },
  };
  return <>
    <div className="image-compare-tools" aria-label="同步查看工具">
      <button onClick={() => zoom(1 / 1.25)} aria-label="同步缩小"><Minus size={15} /></button>
      <button onClick={() => zoom(1.25)} aria-label="同步放大"><Plus size={15} /></button>
      <button onClick={() => setView(null)}>适合窗口</button>
      <button onClick={() => setView((before) => zoomImageView(before || fit, 1))}>1:1 像素</button>
      <output>{(current.scale * 100).toFixed(1)}% · ({Math.round(current.x)}, {Math.round(current.y)}) px</output>
      <small>两侧共用左上原点 · 滚轮缩放 · 拖动平移</small>
    </div>
    <div className="image-compare-panes">
      <ImagePane key={leftImageKey} image={left} empty={missingSource} label="来源" state={shownLeft} view={current}
        onLoaded={(state) => setLeft({ ...state, key: leftImageKey })} onWheel={wheel} onDrag={onDrag} />
      <ImagePane image={right} label="结果" state={rightState} view={current}
        onLoaded={setRight} onMeasure={setViewport} onWheel={wheel} onDrag={onDrag} />
    </div>
    <ParameterTable left={leftRecord} right={rightRecord} leftState={shownLeft} rightState={rightState} isInput={isInput} />
  </>;
}
