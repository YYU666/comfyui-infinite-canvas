import React, { useId, useRef, useState } from 'react';
import { curveValue, normalizeCurvePoints } from './photo-adjustments';
import './tone-graph-controls.css';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rounded = (value) => Math.round(value * 100) / 100;
const histogramPath = (histogram, height, baseline) => {
  const bins = histogram || [];
  const maximum = Math.max(1, ...bins);
  return `M 0 ${baseline} ${bins.map((count, index) => `L ${index} ${baseline - Math.sqrt(Math.max(0, count) / maximum) * height}`).join(' ')} L 255 ${baseline} Z`;
};

function NumberValue({ label, name = label, value, min, max, step = 1, disabled, onChange }) {
  return <label className="tone-number"><span>{label}</span><input type="number" aria-label={`${name}数值`} value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => {
    if (event.target.value !== '' && Number.isFinite(Number(event.target.value))) onChange(clamp(Number(event.target.value), min, max));
  }} /></label>;
}

const inputMarkers = [
  { key: 'inputBlack', label: '输入黑场', color: 'black' },
  { key: 'gamma', label: '中间调', color: 'gray' },
  { key: 'inputWhite', label: '输入白场', color: 'white' },
];
const outputMarkers = [
  { key: 'outputBlack', label: '输出黑场', color: 'black' },
  { key: 'outputWhite', label: '输出白场', color: 'white' },
];

export function LevelsGraphControls({ values, onChange, disabled, histogram }) {
  const gradientId = useId().replace(/:/g, '');
  const drag = useRef(null);
  const latest = useRef(values); latest.current = values;
  const midpoint = values.inputBlack + (values.inputWhite - values.inputBlack) * 0.5 ** values.gamma;
  const constrain = (key, value) => {
    if (disabled) return;
    const current = latest.current;
    const bounds = {
      inputBlack: [0, current.inputWhite - 1], inputWhite: [current.inputBlack + 1, 255],
      gamma: [0.1, 3], outputBlack: [0, current.outputWhite], outputWhite: [current.outputBlack, 255],
    };
    onChange({ [key]: rounded(clamp(value, ...bounds[key])) });
  };
  const pointerValue = (event, key) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const coordinate = clamp((event.clientX - bounds.left) / bounds.width * 271 - 8, 0, 255);
    const current = latest.current;
    if (key === 'gamma') {
      const fraction = clamp((coordinate - current.inputBlack) / (current.inputWhite - current.inputBlack), 0.001, 0.999);
      constrain(key, Math.log(fraction) / Math.log(0.5));
    } else constrain(key, Math.round(coordinate));
  };
  const keyDown = (event, key) => {
    const current = latest.current;
    const step = key === 'gamma' ? 0.05 : event.shiftKey ? 10 : 1;
    const bounds = key === 'gamma' ? [0.1, 3] : [0, 255];
    if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      constrain(key, event.key === 'Home' ? bounds[0] : event.key === 'End' ? bounds[1] : current[key] + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -step : step));
    }
  };
  const marker = ({ key, label, color }, y) => {
    const x = key === 'gamma' ? midpoint : values[key];
    const minimum = key === 'gamma' ? 0.1 : key === 'inputWhite' ? values.inputBlack + 1 : key === 'outputWhite' ? values.outputBlack : 0;
    const maximum = key === 'gamma' ? 3 : key === 'inputBlack' ? values.inputWhite - 1 : key === 'outputBlack' ? values.outputWhite : 255;
    return <g key={key} transform={`translate(${x + 8}, ${y})`} className={`tone-marker tone-marker-${color}`} role="slider" aria-label={`${label}控制点`} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={values[key]} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0} onKeyDown={(event) => keyDown(event, key)} onPointerDown={(event) => {
      if (disabled) return; event.preventDefault(); event.stopPropagation();
      drag.current = { key, pointerId: event.pointerId };
      event.currentTarget.ownerSVGElement.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    }}><title>{label}：{values[key]}</title><path d="M 0 -7 L -6 4 L 6 4 Z" /><rect x="-9" y="-10" width="18" height="20" className="tone-marker-hit" /></g>;
  };
  const dragHandlers = {
    onPointerMove: (event) => { if (drag.current?.pointerId === event.pointerId) pointerValue(event, drag.current.key); },
    onPointerUp: (event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      pointerValue(event, drag.current.key); drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: () => { drag.current = null; },
    onLostPointerCapture: () => { drag.current = null; },
  };
  return <div className="tone-levels-controls nodrag nopan">
    <div className="tone-graph-caption"><span>输入色阶</span><small>拖动波峰图下方的黑 / 灰 / 白点</small></div>
    <svg className="tone-levels-graph photo-histogram" viewBox="0 0 271 153" role="group" aria-label="色阶波峰图" {...dragHandlers}>
      <defs><linearGradient id={`${gradientId}-input`}><stop offset="0%" stopColor="#000" /><stop offset="100%" stopColor="#fff" /></linearGradient></defs>
      <rect x="8" y="3" width="255" height="117" className="tone-graph-background" />
      {[64, 128, 192].map((x) => <line key={x} x1={x + 8} x2={x + 8} y1="3" y2="120" className="tone-grid" />)}
      <path transform="translate(8,0)" d={histogramPath(histogram, 108, 120)} className="tone-histogram-fill" />
      <line x1={values.inputBlack + 8} x2={values.inputBlack + 8} y1="3" y2="121" className="tone-levels-guide" />
      <line x1={values.inputWhite + 8} x2={values.inputWhite + 8} y1="3" y2="121" className="tone-levels-guide" />
      <rect x="8" y="122" width="255" height="6" fill={`url(#${gradientId}-input)`} />
      {inputMarkers.map((item) => marker(item, 137))}
      {!histogram?.length && <text x="135.5" y="65" className="tone-empty">连接原图后显示波峰分布</text>}
    </svg>
    <div className="tone-number-row tone-number-row-three">
      <NumberValue label="黑场" name="输入黑场" value={values.inputBlack} min={0} max={values.inputWhite - 1} disabled={disabled} onChange={(value) => constrain('inputBlack', value)} />
      <NumberValue label="中间调" value={values.gamma} min={0.1} max={3} step={0.05} disabled={disabled} onChange={(value) => constrain('gamma', value)} />
      <NumberValue label="白场" name="输入白场" value={values.inputWhite} min={values.inputBlack + 1} max={255} disabled={disabled} onChange={(value) => constrain('inputWhite', value)} />
    </div>
    <div className="tone-graph-caption"><span>输出色阶</span></div>
    <svg className="tone-output-graph" viewBox="0 0 271 35" aria-label="输出色阶渐变" {...dragHandlers}>
      <defs><linearGradient id={`${gradientId}-output`}><stop offset="0%" stopColor="#000" /><stop offset="100%" stopColor="#fff" /></linearGradient></defs>
      <rect x="8" y="2" width="255" height="11" fill={`url(#${gradientId}-output)`} />
      {outputMarkers.map((item) => marker(item, 24))}
    </svg>
    <div className="tone-number-row">
      <NumberValue label="黑场" name="输出黑场" value={values.outputBlack} min={0} max={values.outputWhite} disabled={disabled} onChange={(value) => constrain('outputBlack', value)} />
      <NumberValue label="白场" name="输出白场" value={values.outputWhite} min={values.outputBlack} max={255} disabled={disabled} onChange={(value) => constrain('outputWhite', value)} />
    </div>
  </div>;
}

const CURVE_PRESETS = {
  linear: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  contrast: [{ x: 0, y: 0 }, { x: 64, y: 45 }, { x: 192, y: 210 }, { x: 255, y: 255 }],
  lighten: [{ x: 0, y: 0 }, { x: 128, y: 160 }, { x: 255, y: 255 }],
  darken: [{ x: 0, y: 0 }, { x: 128, y: 96 }, { x: 255, y: 255 }],
};

export function CurvesGraphControls({ points, onChange, disabled, histogram, channel = 'rgb' }) {
  const normalized = normalizeCurvePoints(points);
  const [selected, setSelected] = useState(0);
  const drag = useRef(null);
  const latest = useRef(normalized); latest.current = normalized;
  const activeIndex = Math.min(selected, normalized.length - 1);
  const active = normalized[activeIndex];
  const path = Array.from({ length: 256 }, (_, x) => `${x ? 'L' : 'M'} ${x + 8} ${263 - curveValue(normalized, x)}`).join(' ');
  const update = (index, x, y) => {
    if (disabled) return;
    const current = latest.current;
    const point = current[index]; if (!point) return;
    const next = current.map((item, i) => i === index ? {
      x: index === 0 ? 0 : index === current.length - 1 ? 255 : Math.round(clamp(x, current[index - 1].x + 1, current[index + 1].x - 1)),
      y: Math.round(clamp(y, 0, 255)),
    } : item);
    onChange(next);
  };
  const remove = (index) => {
    const current = latest.current;
    if (disabled || index === 0 || index === current.length - 1) return;
    onChange(current.filter((_, i) => i !== index)); setSelected(Math.max(0, index - 1)); drag.current = null;
  };
  const coordinates = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.round(clamp((event.clientX - rect.left) / rect.width * 271 - 8, 0, 255)), y: Math.round(clamp(263 - (event.clientY - rect.top) / rect.height * 271, 0, 255)) };
  };
  const pointKeys = (event, index) => {
    if (disabled) return;
    if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); remove(index); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const point = latest.current[index]; const step = event.shiftKey ? 10 : 1;
    update(index, point.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), point.y + (event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0));
  };
  return <div className={`tone-curves-controls tone-channel-${channel} nodrag nopan`}>
    <div className="tone-graph-caption"><span>调整曲线</span><small>点击加点 · 拖动调整 · 双击删点</small></div>
    <svg viewBox="0 0 271 271" className="tone-curves-graph" role="group" aria-label="曲线编辑图" tabIndex={disabled ? -1 : 0} onKeyDown={(event) => pointKeys(event, activeIndex)} onPointerDown={(event) => {
      if (disabled || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); const coordinate = coordinates(event);
      const current = latest.current;
      const nearest = current.findIndex((point) => Math.abs(point.x - coordinate.x) < 2);
      if (nearest >= 0) { setSelected(nearest); return; }
      if (current.length >= 16 || coordinate.x === 0 || coordinate.x === 255) return;
      const next = [...current, coordinate].sort((a, b) => a.x - b.x);
      const index = next.indexOf(coordinate); onChange(next); setSelected(index);
      drag.current = { index, pointerId: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const coordinate = coordinates(event); update(drag.current.index, coordinate.x, coordinate.y);
    }} onPointerUp={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const coordinate = coordinates(event); update(drag.current.index, coordinate.x, coordinate.y); drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <rect x="8" y="8" width="255" height="255" className="tone-graph-background" />
      <path transform="translate(8,0)" d={histogramPath(histogram, 246, 263)} className="tone-histogram-fill" />
      {[0, 64, 128, 192, 255].map((value) => <React.Fragment key={value}><line x1={value + 8} x2={value + 8} y1="8" y2="263" className="tone-grid" /><line x1="8" x2="263" y1={value + 8} y2={value + 8} className="tone-grid" /></React.Fragment>)}
      <line x1="8" y1="263" x2="263" y2="8" className="tone-diagonal" />
      <path d={path} className="tone-curve-line" />
      {normalized.map((point, index) => <circle key={index} cx={point.x + 8} cy={263 - point.y} r="4" className={`tone-curve-point${index === activeIndex ? ' selected' : ''}`} tabIndex={disabled ? -1 : 0} role="slider" aria-label={`曲线控制点 ${index + 1}`} aria-valuetext={`输入 ${point.x}，输出 ${point.y}`} aria-valuemin={0} aria-valuemax={255} aria-valuenow={point.y} aria-disabled={disabled || undefined} onFocus={() => setSelected(index)} onKeyDown={(event) => pointKeys(event, index)} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); remove(index); }} onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); setSelected(index); event.currentTarget.focus();
        drag.current = { index, pointerId: event.pointerId }; event.currentTarget.ownerSVGElement.setPointerCapture(event.pointerId);
      }} />)}
    </svg>
    <div className="tone-number-row">
      <NumberValue label="输入" name="曲线输入" value={active.x} min={activeIndex === 0 ? 0 : normalized[activeIndex - 1].x + 1} max={activeIndex === normalized.length - 1 ? 255 : normalized[activeIndex + 1].x - 1} disabled={disabled || activeIndex === 0 || activeIndex === normalized.length - 1} onChange={(x) => update(activeIndex, x, active.y)} />
      <NumberValue label="输出" name="曲线输出" value={active.y} min={0} max={255} disabled={disabled} onChange={(y) => update(activeIndex, active.x, y)} />
      <button type="button" className="tone-remove-point" disabled={disabled || activeIndex === 0 || activeIndex === normalized.length - 1} onClick={() => remove(activeIndex)}>删除点</button>
    </div>
    <div className="tone-curve-presets" aria-label="曲线预设">{[['linear', '线性'], ['contrast', 'S 形对比'], ['lighten', '提亮'], ['darken', '压暗']].map(([key, label]) => <button key={key} type="button" disabled={disabled} onClick={() => { onChange(CURVE_PRESETS[key].map((point) => ({ ...point }))); setSelected(0); }}>{label}</button>)}</div>
  </div>;
}
