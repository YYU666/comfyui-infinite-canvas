import React, { useRef } from 'react';
import { CHANNEL_KEYS, normalizeChannelPackSettings } from './channel-packing';

const LABELS = { red: 'R', green: 'G', blue: 'B', alpha: 'A' };
const SOURCES = [['luminance', '灰度亮度'], ['red', '红色 R'], ['green', '绿色 G'], ['blue', '蓝色 B'], ['alpha', '透明度 A']];

export default function ChannelPackControls({ id, data, refs, patch, disabled, actions, onBusy }) {
  const inputs = useRef({});
  const { channels } = normalizeChannelPackSettings(data);
  const update = (channel, key, value) => patch({ packChannels: { ...channels, [channel]: { ...channels[channel], [key]: value } } });
  return <>
    <label className="image-process-select">通道预览<select aria-label="通道预览" value={data.packPreview || 'rgb'} onChange={(event) => patch({ packPreview: event.target.value })} disabled={disabled}>
      {[['rgb', 'RGB · 不透明预览'], ['rgba', 'RGBA · 含透明度'], ...CHANNEL_KEYS.map((key) => [key, `${LABELS[key]} · 灰度`])].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    {CHANNEL_KEYS.map((channel) => {
      const label = LABELS[channel]; const settings = channels[channel]; const source = refs?.find((ref) => ref.data.slot === channel);
      return <div key={channel} className={`channel-pack-slot channel-pack-${channel}`}>
        <div className="channel-pack-heading"><b>{label}</b><span>{source?.data.title || '未连接 · 使用常量'}</span><button disabled={disabled} onClick={() => inputs.current[channel]?.click()}>{source ? '更换贴图' : '上传贴图'}</button>{source && <button aria-label={`${label} 断开贴图`} disabled={disabled} onClick={() => actions.disconnectImageProcessInput(id, channel)}>断开</button>}</div>
        <input ref={(element) => { inputs.current[channel] = element; }} type="file" hidden aria-label={`${label} 通道贴图`} accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={async (event) => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
          onBusy(true);
          try { await actions.attachImageProcessInput(id, channel, file); } catch (error) { actions.updateNode(id, { error: error.message }); } finally { onBusy(false); }
        }} />
        <div className="channel-pack-options"><label>取值<select aria-label={`${label} 来源通道`} value={settings.source} disabled={disabled} onChange={(event) => update(channel, 'source', event.target.value)}>{SOURCES.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
          <label>常量<input type="number" aria-label={`${label} 默认值`} min="0" max="255" step="1" value={settings.value} disabled={disabled || Boolean(source)} onChange={(event) => { if (event.target.value !== '') update(channel, 'value', Math.round(Math.min(255, Math.max(0, Number(event.target.value))))); }} /></label>
          <label className="photo-checkbox"><input type="checkbox" aria-label={`${label} 反相`} checked={settings.invert} disabled={disabled} onChange={(event) => update(channel, 'invert', event.target.checked)} />反相</label>
        </div>
      </div>;
    })}
    <p>把不同灰度贴图连接到 R / G / B / A。至少连接一张；空通道使用常量，A 默认 255（不透明）。输出尺寸取首个已连接通道，其他贴图按最近邻缩放。</p>
    <p>灰度源图使用不透明图片。节点串联时读取原始 TGA，保留透明区域的数据。画布默认以不透明 RGB 预览，也可检查单通道。</p>
  </>;
}
