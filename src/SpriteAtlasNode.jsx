import React, { useEffect, useState } from 'react';
import { DEFAULT_SPRITE_OPTIONS, SPRITE_ACTIVE, spriteSnapshot, spriteRequest } from './sprite-atlas.js';
import './sprite-atlas.css';

export default function SpriteAtlasNode({ id, data, actions, title, toolbar }) {
  const [backend, setBackend] = useState(null);
  const [checking, setChecking] = useState(false);
  const running = SPRITE_ACTIVE.includes(data.status) || actions.isImageProcessBusy(id);
  const disabled = running || actions.readOnly;
  const options = { ...DEFAULT_SPRITE_OPTIONS, ...data.spriteOptions };
  const check = async signal => {
    setChecking(true);
    try { const result = await spriteRequest('/status', { signal }); if (!signal?.aborted) setBackend(result); }
    catch (error) { if (!signal?.aborted) setBackend({ available: false, message: error.message }); }
    finally { if (!signal?.aborted) setChecking(false); }
  };
  useEffect(() => { const controller = new AbortController(); void check(controller.signal); return () => controller.abort(); }, []);
  const patch = values => { if (!disabled) actions.updateNode(id, { ...values, error: null }); };
  const option = (key, value) => patch({ spriteOptions: { ...options, [key]: value } });
  let validation, current = false;
  try { current = spriteSnapshot(data).signature === data.spriteResultSignature; } catch (error) { validation = error.message; }
  const files = data.spriteFiles;
  return <div className="sprite-atlas-node" data-sprite-atlas="v1">{title}{toolbar}
    <div className="sprite-atlas-controls nodrag nopan nowheel">
      <p className="sprite-atlas-backend">Blender · 本机 CPU 渲染 · 透明背景</p>
      <label>角色文件（带动画 GLB / FBX）<input aria-label="角色文件路径" value={data.spriteInputPath || ''} disabled={disabled} placeholder="输入本机文件的绝对路径" onChange={event => patch({ spriteInputPath: event.target.value })} /></label>
      <div className="sprite-atlas-grid">
        <label>方向<select aria-label="精灵方向数" value={options.directions} disabled={disabled} onChange={event => option('directions', Number(event.target.value))}>{[4, 8, 16].map(value => <option key={value} value={value}>{value} 方向</option>)}</select></label>
        <label>单帧尺寸 px<input aria-label="精灵单帧尺寸" type="number" min="32" max="1024" value={options.frameSize} disabled={disabled} onChange={event => option('frameSize', Number(event.target.value))} /></label>
        <label>每段动作帧数<input aria-label="每段动作帧数" type="number" min="1" max="64" value={options.framesPerAction} disabled={disabled} onChange={event => option('framesPerAction', Number(event.target.value))} /></label>
        <label>俯视角 °<input aria-label="精灵俯视角" type="number" min="0" max="60" value={options.elevation} disabled={disabled} onChange={event => option('elevation', Number(event.target.value))} /></label>
        <label>起始朝向 °<input aria-label="精灵起始朝向" type="number" min="-360" max="360" value={options.startYaw} disabled={disabled} onChange={event => option('startYaw', Number(event.target.value))} /></label>
        <label>留白比例<input aria-label="精灵留白比例" type="number" min="0" max="0.4" step="0.01" value={options.padding} disabled={disabled} onChange={event => option('padding', Number(event.target.value))} /></label>
        {['X', 'Y'].map((label, index) => <label key={label}>轴心 {label}（0.01–0.99）<input aria-label={`精灵轴心 ${label}`} type="number" min="0.01" max="0.99" step="0.01" value={options.pivot[index]} disabled={disabled} onChange={event => option('pivot', options.pivot.map((v, i) => i === index ? Number(event.target.value) : v))} /></label>)}
      </div>
      <label>动作名称（每行一个，留空导出全部）<textarea aria-label="精灵动作名称" rows="3" value={(options.actions || []).join('\n')} disabled={disabled} onChange={event => option('actions', event.target.value.split('\n'))} onBlur={event => option('actions', event.target.value.split('\n').map(v => v.trim()).filter(Boolean))} /></label>
      <p>列 = 动作帧；行 = 动作 × 方向。最多 8 段动作，图集最大边长 8192。RGS 先导入颜色图集；法线图集同步导出。</p>
      <div className="sprite-atlas-status"><span>{checking ? '正在检查 Blender…' : backend?.available ? 'Blender 已就绪' : backend?.message || '等待检查 Blender'}</span><button disabled={checking || running} onClick={() => void check()}>重新检查</button></div>
      {files && <section className="sprite-atlas-outputs" aria-label="精灵图导出结果">
        <strong>{current ? '当前参数的图集' : '上次成功结果 · 参数已改变'}</strong>
        <figure><img src={files.albedo} alt="颜色图集（透明背景）" loading="lazy" /><figcaption>颜色 Albedo <a href={files.albedo} download="albedo.png">下载 PNG</a></figcaption></figure>
        <figure><img src={files.normal} alt="相机空间法线图集" loading="lazy" /><figcaption>相机空间法线 <a href={files.normal} download="normal.png">下载 PNG</a></figcaption></figure>
        <a href={files.metadata} download="atlas.json">下载图集描述 atlas.json</a>
      </section>}
      {data.error && <p className="sprite-atlas-error" role="alert">{data.error}</p>}
      {validation && <p className="sprite-atlas-hint">{validation}</p>}
      <footer><span>{running ? data.stage || '渲染中…' : data.status === 'done' ? '已导出 2 张图集 + JSON' : '游戏美术 / 精灵图'}</span>{running ? <button disabled={actions.readOnly} onClick={() => actions.cancelSpriteAtlas(id)}>取消渲染</button> : <button disabled={disabled || !backend?.available || Boolean(validation)} onClick={() => actions.runSpriteAtlas(id)}>渲染精灵图集</button>}</footer>
    </div>
  </div>;
}
