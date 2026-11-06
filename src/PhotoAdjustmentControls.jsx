import React, { useEffect, useState } from 'react';
import { HSL_CHANNELS, LEVEL_CHANNELS, normalizeHslSettings, normalizeLevelsSettings } from './image-compositing';
import { PHOTO_CONTROL_SCHEMAS, normalizePhotoAdjustment } from './photo-adjustments';
import { LevelsGraphControls, CurvesGraphControls } from './ToneGraphControls';
import { readImageHistogram } from './image-process-runtime';

export function AdjustmentRange({ name, label, value, min, max, step = 1, disabled, onChange }) {
  return <label className="image-process-range"><span>{label}<input type="number" aria-label={`${name || label}数值`} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => {
    if (event.target.value !== '' && Number.isFinite(Number(event.target.value))) onChange(Math.max(min, Math.min(max, Number(event.target.value))));
  }} /></span><input aria-label={name || label} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
function useHistogram(url) {
  const [state, setState] = useState({ bins: null, error: '' });
  useEffect(() => {
    const controller = new AbortController(); setState({ bins: null, error: '' });
    if (url) readImageHistogram(url, controller.signal).then((bins) => { if (!controller.signal.aborted) setState({ bins, error: '' }); }).catch((error) => { if (error.name !== 'AbortError') setState({ bins: null, error: error.message }); });
    return () => controller.abort();
  }, [url]);
  return state;
}
const BALANCE_RANGES = ['shadows', 'midtones', 'highlights'].map((value, i) => ({ value, label: ['阴影', '中间调', '高光'][i] }));
const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'].map((value, i) => ({ value, label: ['红色', '黄色', '绿色', '青色', '蓝色', '洋红', '白色', '中性色', '黑色'][i] }));
const CHANNELS = LEVEL_CHANNELS.filter(({ value }) => value !== 'rgb');
const FILTERS = [['#ec8a2e', '暖色滤镜'], ['#527ecb', '冷色滤镜'], ['#bd7e45', '怀旧棕色'], ['#c26ba0', '洋红滤镜'], ['custom', '自定义颜色']].map(([value, label]) => ({ value, label }));
function Select({ label, value, items, disabled, onChange }) {
  return <label className="image-process-select">{label}<select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{items.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>;
}
function Checkbox({ label, value, disabled, onChange }) {
  return <label className="photo-checkbox"><input type="checkbox" aria-label={label} checked={value} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}
export default function PhotoAdjustmentControls({ data, patch, disabled, baseUrl }) {
  const type = data.adjustmentType;
  const histogram = useHistogram(['levels', 'curves'].includes(type) ? baseUrl : null);
  const settings = type === 'hsl' ? normalizeHslSettings(data).hsl : type === 'levels' ? normalizeLevelsSettings(data).levels : normalizePhotoAdjustment(data)[type];
  const update = (key, value) => patch({ [type]: { ...settings, [key]: value } });
  const range = (label, key, value, min, max, step = 1, onChange = (value) => update(key, value)) => <AdjustmentRange key={key} label={label} value={value} min={min} max={max} step={step} disabled={disabled} onChange={onChange} />;
  if (type === 'hsl') {
    const channel = HSL_CHANNELS.some(({ value }) => value === data.hslChannel) ? data.hslChannel : 'master';
    const values = settings[channel];
    const edit = (key, value) => update(channel, { ...values, [key]: value });
    return <><Select label="HSL 颜色范围" value={channel} items={HSL_CHANNELS} disabled={disabled} onChange={(hslChannel) => patch({ hslChannel })} /><div className={`photo-color-strip color-${channel}`} aria-hidden="true" />
      <AdjustmentRange label="色相" name="HSL 色相" value={values.hue} min={-180} max={180} disabled={disabled} onChange={(v) => edit('hue', v)} />
      <AdjustmentRange label="饱和度" name="HSL 饱和度" value={values.saturation} min={-100} max={100} disabled={disabled} onChange={(v) => edit('saturation', v)} />
      <AdjustmentRange label="明度" name="HSL 明度" value={values.lightness} min={-100} max={100} disabled={disabled} onChange={(v) => edit('lightness', v)} /><p>全色影响整张图；也可分别调整六种颜色，范围之间柔和过渡。</p></>;
  }
  if (type === 'levels' || type === 'curves') {
    const selectionKey = type === 'levels' ? 'levelsChannel' : 'curvesChannel';
    const channel = LEVEL_CHANNELS.some(({ value }) => value === data[selectionKey]) ? data[selectionKey] : 'rgb';
    const autoLevels = () => {
      const bins = histogram.bins?.[channel]; if (!bins) return;
      const total = bins.reduce((sum, count) => sum + count, 0); if (!total) return;
      const cutoff = total * 0.005; let black = 0; let white = 255; let sum = 0;
      while (black < 254 && sum + bins[black] <= cutoff) sum += bins[black++];
      sum = 0; while (white > 1 && sum + bins[white] <= cutoff) sum += bins[white--];
      if (white > black) update(channel, { ...settings[channel], inputBlack: black, inputWhite: white, gamma: 1 });
    };
    return <><Select label={type === 'levels' ? '色阶通道' : '曲线通道'} value={channel} items={LEVEL_CHANNELS} disabled={disabled} onChange={(value) => patch({ [selectionKey]: value })} />
      {type === 'levels' ? <LevelsGraphControls values={settings[channel]} histogram={histogram.bins?.[channel]} disabled={disabled} onChange={(values) => update(channel, { ...settings[channel], ...values })} /> : <CurvesGraphControls key={channel} points={settings[channel]} histogram={histogram.bins?.[channel]} channel={channel} disabled={disabled} onChange={(points) => update(channel, points)} />}
      {histogram.error && <p role="alert">{histogram.error}</p>}{!baseUrl && <p>连接原图后显示亮度分布。</p>}
      {type === 'levels' && <button className="photo-small-button" disabled={disabled || !histogram.bins} onClick={autoLevels}>自动色阶 · 当前通道</button>}
      <p>{type === 'levels' ? '拖动波峰图下的黑、灰、白三角调整输入色阶；下方渐变两端控制输出黑白场。' : '点击曲线添加控制点，拖动调整明暗；双击内部控制点可删除。RGB 后叠加各颜色通道。'}</p></>;
  }
  if (type === 'colorBalance' || type === 'selectiveColor') {
    const balance = type === 'colorBalance'; const items = balance ? BALANCE_RANGES : SELECTIVE_RANGES;
    const selectionKey = balance ? 'colorBalanceRange' : 'selectiveColorRange';
    const channel = items.some(({ value }) => value === data[selectionKey]) ? data[selectionKey] : balance ? 'midtones' : 'reds'; const values = settings[channel];
    return <><Select label={balance ? '色调范围' : '可选颜色范围'} value={channel} items={items} disabled={disabled} onChange={(value) => patch({ [selectionKey]: value })} />
      {!balance && <Select label="调整方式" value={settings.method} items={[{ value: 'relative', label: '相对' }, { value: 'absolute', label: '绝对' }]} disabled={disabled} onChange={(v) => update('method', v)} />}
      {(balance ? [['cyanRed', '青色 ↔ 红色'], ['magentaGreen', '洋红 ↔ 绿色'], ['yellowBlue', '黄色 ↔ 蓝色']] : [['cyan', '青色'], ['magenta', '洋红'], ['yellow', '黄色'], ['black', '黑色']]).map(([key, label]) => range(label, key, values[key], -100, 100, 1, (v) => update(channel, { ...values, [key]: v })))}
      {balance && <Checkbox label="保持明度" value={settings.preserveLuminosity} disabled={disabled} onChange={(v) => update('preserveLuminosity', v)} />}</>;
  }
  if (type === 'channelMixer') {
    const channel = settings.monochrome ? 'red' : CHANNELS.some(({ value }) => value === data.channelMixerChannel) ? data.channelMixerChannel : 'red'; const values = settings[channel];
    return <><Checkbox label="单色输出" value={settings.monochrome} disabled={disabled} onChange={(v) => update('monochrome', v)} />
      {!settings.monochrome && <Select label="输出通道" value={channel} items={CHANNELS} disabled={disabled} onChange={(channelMixerChannel) => patch({ channelMixerChannel })} />}
      {CHANNELS.map(({ value, label }) => range(`${label}来源`, value, values[value], -200, 200, 1, (v) => update(channel, { ...values, [value]: v })))}
      {range('常数', 'constant', values.constant, -100, 100, 1, (constant) => update(channel, { ...values, constant }))}
      <p>通道总量 {values.red + values.green + values.blue}%。单色使用红色输出通道的混合配方。</p></>;
  }
  if (type === 'invert') return <p className="photo-effect-note">反转 RGB 颜色，保留透明度。可连接后续调色或混合节点继续处理。</p>;
  return <>
    {type === 'photoFilter' && <Select label="滤镜预设" value={FILTERS.some(({ value }) => value === settings.color) ? settings.color : 'custom'} items={FILTERS} disabled={disabled} onChange={(v) => { if (v !== 'custom') update('color', v); }} />}
    {type === 'gradientMap' && <div className="photo-gradient-preview" style={{ background: `linear-gradient(90deg, ${settings.reverse ? settings.light : settings.dark}, ${settings.reverse ? settings.dark : settings.light})` }} aria-label="渐变映射预览" />}
    {(PHOTO_CONTROL_SCHEMAS[type] || []).map((control) => control.type === 'color' ? <label key={control.key} className="photo-color-input"><span>{control.label}</span><input type="color" aria-label={control.label} value={settings[control.key]} disabled={disabled} onChange={(e) => update(control.key, e.target.value)} /><code>{settings[control.key].toUpperCase()}</code></label> : control.type === 'checkbox' ? <Checkbox key={control.key} label={control.label} value={settings[control.key]} disabled={disabled} onChange={(v) => update(control.key, v)} /> : control.type === 'select' ? <Select key={control.key} label={control.label} value={settings[control.key]} items={control.options} disabled={disabled} onChange={(v) => update(control.key, v)} /> : range(control.label, control.key, settings[control.key], control.min, control.max, control.step))}
    {type === 'shadowsHighlights' && <p>提亮阴影、压回高光，保留中间调层次。</p>}{type === 'blackWhite' && <p>分别控制六种颜色转换后的灰度明暗。</p>}
  </>;
}
