import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture, ArrowDownToLine, Check, ChevronDown, Clapperboard, Clock3, Cpu,
  Film, FolderOpen, Gauge, History, Image, Info, Layers3, LoaderCircle,
  Maximize2, Monitor, MoreHorizontal, Play, Plus, RefreshCw, RotateCcw,
  Settings2, Sparkles, Square, Trash2, Upload, WandSparkles, X, Zap,
} from 'lucide-react';
import {
  buildWorkflow, cancelPrompt, createClientId, durationToFrames, extractVideos,
  getHistory, getSystemStats, openProgressSocket, queuePrompt, uploadImage,
} from './workbench-api';
import './styles.css';

const EXAMPLES = [
  '清晨的薄雾穿过森林，镜头缓慢向前推进，阳光洒在树叶间，电影感',
  '一艘白色帆船驶过宁静海面，海鸥掠过，浪花轻柔，自然音效',
  '雨夜霓虹街道，镜头跟随一位撑伞的人，地面积水映出城市灯光',
];
const NODE_LABELS = {
  '1': '加载视频模型', '2': '加载 Turbo 加速', '3': '配置采样', '4': '加载文本编码器',
  '5': '加载视频 VAE', '6': '加载音频 VAE', '7': '理解提示词与画面', '9': '准备随机种子',
  '11': '规划采样步骤', '12': '正在生成画面与声音', '13': '解码视频画面',
  '14': '解码视频声音', '15': '合成音视频', '16': '保存 MP4',
};
const DEFAULT_FORM = { mode: 'text', prompt: '', ratio: '16:9', duration: 5, turbo: true, seed: 42, randomSeed: true };
const JOB_KEY = 'h3-workbench-jobs-v1';

function readJobs() {
  try { return JSON.parse(localStorage.getItem(JOB_KEY) || '{}'); } catch { return {}; }
}

function formatTime(timestamp) {
  if (!timestamp) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function IconButton({ label, children, ...props }) {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}

function UploadSlot({ kind, file, onChange, disabled }) {
  const inputRef = useRef(null);
  const preview = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);
  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);
  return (
    <div className={`upload-slot ${file ? 'has-file' : ''}`} onClick={() => !disabled && inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={disabled}
        onChange={(event) => onChange(event.target.files?.[0] || null)} />
      {file ? <>
        <img src={preview} alt={`${kind}预览`} />
        <div className="upload-file-overlay"><span>{file.name}</span><X size={15} onClick={(e) => { e.stopPropagation(); onChange(null); }} /></div>
      </> : <>
        <div className="upload-icon"><Image size={19} /></div>
        <strong>{kind}</strong><span>点击上传图片</span>
      </>}
    </div>
  );
}

function EmptyPreview({ ratio }) {
  return <div className={`empty-preview ratio-${ratio.replace(':', '-')}`}>
    <div className="empty-orbit"><Clapperboard size={31} strokeWidth={1.4} /></div>
    <h3>让想法动起来</h3>
    <p>输入画面描述，或上传首尾帧<br />作品将在本机生成并显示在这里</p>
    <div className="empty-tags"><span><Zap size={12} />8 步加速</span><span><Film size={12} />24 FPS</span><span><Monitor size={12} />本地运行</span></div>
  </div>;
}

function VideoCard({ item, onSelect, onDelete }) {
  return <article className="video-card" onClick={() => onSelect(item)}>
    <div className="video-thumb">
      <video src={item.url} preload="metadata" muted />
      <div className="thumb-play"><Play size={17} fill="currentColor" /></div>
      <span className="video-duration">{item.duration || 5}s</span>
    </div>
    <div className="video-card-body">
      <p>{item.prompt || 'H3 本地视频作品'}</p>
      <div><span>{item.ratio || '16:9'} · {formatTime(item.createdAt)}</span>
        {onDelete && <IconButton label="删除此条浏览器记录" onClick={(e) => { e.stopPropagation(); onDelete(item); }}><Trash2 size={14} /></IconButton>}
      </div>
    </div>
  </article>;
}

export default function App({ onCanvasMode }) {
  const [page, setPage] = useState('create');
  const [form, setForm] = useState(DEFAULT_FORM);
  const [firstFrame, setFirstFrame] = useState(null);
  const [lastFrame, setLastFrame] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState({ state: 'connecting', label: '正在连接本地服务' });
  const [system, setSystem] = useState(null);
  const [active, setActive] = useState(null);
  const [selected, setSelected] = useState(null);
  const [historyItems, setHistoryItems] = useState([]);
  const [jobs, setJobs] = useState(readJobs);
  const [notice, setNotice] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const clientId = useMemo(createClientId, []);
  const activeRef = useRef(null);
  const socketRef = useRef(null);
  const fileInputRef = useRef(null);
  const busy = active && ['uploading', 'queued', 'running', 'finishing'].includes(active.state);

  const updateActive = useCallback((value) => {
    setActive((previous) => {
      const next = typeof value === 'function' ? value(previous) : value;
      activeRef.current = next;
      return next;
    });
  }, []);

  const saveJob = useCallback((id, data) => {
    if (!id) return;
    setJobs((previous) => {
      const next = { ...previous, [id]: { ...previous[id], ...data } };
      localStorage.setItem(JOB_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const refreshHistory = useCallback(async (selectId) => {
    try {
      const history = await getHistory();
      const items = [];
      for (const [id, entry] of Object.entries(history || {})) {
        const videos = extractVideos(entry).filter((file) => file.filename?.includes('H3_Workbench'));
        if (!videos.length) continue;
        const meta = jobs[id] || readJobs()[id] || {};
        for (const video of videos) items.push({ ...meta, ...video, id: `${id}-${video.filename}`, promptId: id });
      }
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setHistoryItems(items);
      if (selectId) {
        const found = items.find((item) => item.promptId === selectId);
        if (found) setSelected(found);
      }
      return items;
    } catch { return []; }
  }, [jobs]);

  const checkStatus = useCallback(async () => {
    setStatus({ state: 'connecting', label: '正在连接本地服务' });
    try {
      const stats = await getSystemStats();
      setSystem(stats);
      const gpu = stats?.devices?.[0]?.name?.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, '') || '本地 GPU';
      setStatus({ state: 'online', label: gpu });
    } catch {
      setStatus({ state: 'offline', label: '本地服务未连接' });
    }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);
  useEffect(() => { refreshHistory(); }, [refreshHistory]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!busy) return;
    const started = active.startedAt || Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy, active?.startedAt]);

  useEffect(() => {
    const socket = openProgressSocket(clientId, {
      onProgress(data) {
        if (activeRef.current?.promptId && data.prompt_id && data.prompt_id !== activeRef.current.promptId) return;
        const percent = data.max ? Math.round(data.value / data.max * 100) : 0;
        updateActive((old) => old ? { ...old, state: 'running', progress: percent, stage: `正在采样 · ${data.value}/${data.max} 步` } : old);
      },
      onExecuting(data) {
        const current = activeRef.current;
        if (!current || (data.prompt_id && current.promptId && data.prompt_id !== current.promptId)) return;
        if (data.node) {
          updateActive((old) => old ? { ...old, state: 'running', stage: NODE_LABELS[data.node] || '正在处理工作流' } : old);
        } else if (current.promptId) {
          updateActive((old) => old ? { ...old, state: 'finishing', stage: '正在读取成片', progress: 100 } : old);
          setTimeout(async () => {
            await refreshHistory(current.promptId);
            updateActive(null);
            setNotice({ type: 'success', text: '视频生成完成，已保存到 ComfyUI 输出目录。' });
          }, 800);
        }
      },
      onExecutionError(data) {
        updateActive((old) => old ? { ...old, state: 'error', stage: '生成失败', error: data.exception_message || 'ComfyUI 执行出错' } : old);
      },
      onInterrupted() {
        updateActive((old) => old ? { ...old, state: 'cancelled', stage: '已取消生成' } : old);
      },
    });
    socketRef.current = socket;
    return () => socket.close();
  }, [clientId, refreshHistory, updateActive]);

  const updateForm = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const randomizeSeed = () => updateForm('seed', Math.floor(Math.random() * 2147483647));

  const generate = async () => {
    if (busy) return;
    if (!form.prompt.trim()) { setNotice({ type: 'error', text: '先描述一下你想生成的画面。' }); return; }
    if (form.mode === 'image' && !firstFrame) { setNotice({ type: 'error', text: '图生视频需要至少上传一张首帧图片。' }); return; }
    setSelected(null);
    const startedAt = Date.now();
    const localJob = { ...form, seed: form.randomSeed ? Math.floor(Math.random() * 2147483647) : Number(form.seed), createdAt: startedAt };
    updateActive({ state: 'uploading', stage: '正在准备素材', progress: 0, startedAt });
    try {
      const [first, last] = await Promise.all([
        form.mode === 'image' && firstFrame ? uploadImage(firstFrame) : null,
        form.mode === 'image' && lastFrame ? uploadImage(lastFrame) : null,
      ]);
      updateActive((old) => ({ ...old, state: 'queued', stage: '正在提交本地生成任务' }));
      const workflow = buildWorkflow({ ...localJob, firstFrame: first, lastFrame: last });
      const result = await queuePrompt(workflow, clientId);
      saveJob(result.prompt_id, localJob);
      updateActive((old) => ({ ...old, promptId: result.prompt_id, state: 'queued', stage: '任务已排队，等待 GPU', ...localJob }));
    } catch (error) {
      updateActive((old) => ({ ...old, state: 'error', stage: '无法提交任务', error: error.message }));
    }
  };

  const cancel = async () => {
    try { await cancelPrompt(activeRef.current?.promptId); }
    catch (error) { setNotice({ type: 'error', text: error.message }); }
    updateActive((old) => old ? { ...old, state: 'cancelled', stage: '已取消生成' } : old);
  };

  const removeRecord = (item) => {
    setHistoryItems((old) => old.filter((entry) => entry.id !== item.id));
    if (selected?.id === item.id) setSelected(null);
    setNotice({ type: 'success', text: '已从当前列表隐藏；磁盘中的视频文件未删除。' });
  };

  const selectRatio = (ratio) => updateForm('ratio', ratio);
  const gpuMemory = system?.devices?.[0]?.vram_total ? `${(system.devices[0].vram_total / 1024 ** 3).toFixed(0)} GB 显存` : 'RTX 本地加速';

  return <div className="app-shell">
    <aside className="side-rail">
      <button className="brand" onClick={() => setPage('create')} aria-label="H3 视频工作台"><span>H</span><b>3</b></button>
      <nav>
        <button className={page === 'create' ? 'active' : ''} onClick={() => setPage('create')}><WandSparkles size={21} /><span>创作</span></button>
        <button className={page === 'history' ? 'active' : ''} onClick={() => { setPage('history'); refreshHistory(); }}><History size={21} /><span>作品</span></button>
        <button className={page === 'models' ? 'active' : ''} onClick={() => setPage('models')}><Layers3 size={21} /><span>模型</span></button>
      </nav>
      <div className="rail-bottom"><button onClick={() => setPage('models')}><Settings2 size={20} /><span>设置</span></button><div className="avatar">本</div></div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div><h1>{page === 'create' ? '视频创作' : page === 'history' ? '我的作品' : '本地模型'}</h1><span className="workspace-label">H3 VIDEO STUDIO</span></div>
        <div className="top-actions">
          <button className={`connection-pill ${status.state}`} onClick={checkStatus}><i />{status.label}<RefreshCw size={13} /></button>
          <button className="open-comfy" onClick={onCanvasMode}><Layers3 size={14} />画布模式</button>
          <button className="open-comfy" onClick={() => window.open('http://127.0.0.1:8188', '_blank')}>高级节点<Maximize2 size={14} /></button>
        </div>
      </header>

      {page === 'create' && <div className="create-layout">
        <section className="control-panel">
          <div className="mode-tabs">
            <button className={form.mode === 'text' ? 'active' : ''} onClick={() => updateForm('mode', 'text')} disabled={busy}><Sparkles size={16} />文生视频</button>
            <button className={form.mode === 'image' ? 'active' : ''} onClick={() => updateForm('mode', 'image')} disabled={busy}><Image size={16} />图生视频</button>
          </div>
          <div className="panel-scroll">
            {form.mode === 'image' && <div className="form-section">
              <div className="section-title"><label>关键帧画面</label><span>首帧必填，尾帧可选</span></div>
              <div className="upload-grid"><UploadSlot kind="首帧" file={firstFrame} onChange={setFirstFrame} disabled={busy} /><UploadSlot kind="尾帧" file={lastFrame} onChange={setLastFrame} disabled={busy} /></div>
            </div>}
            <div className="form-section prompt-section">
              <div className="section-title"><label>画面描述</label><button onClick={() => updateForm('prompt', EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)])} disabled={busy}><RotateCcw size={13} />灵感一下</button></div>
              <div className="prompt-box">
                <textarea value={form.prompt} onChange={(e) => updateForm('prompt', e.target.value)} onKeyDown={(e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); generate(); } }} disabled={busy} maxLength={1800}
                  placeholder="描述主体、动作、环境和镜头运动……&#10;&#10;例如：一只橘猫在洒满阳光的工作室里伸懒腰，镜头缓慢推近，温馨自然，电影质感" />
                <div className="prompt-footer"><span>建议同时描述画面与声音</span><b>{form.prompt.length}/1800</b></div>
              </div>
            </div>
            <div className="form-section">
              <div className="section-title"><label>画面比例</label><span>约 0.4 MP</span></div>
              <div className="ratio-options">{Object.keys({ '16:9': 1, '9:16': 1, '1:1': 1, '4:3': 1, '3:4': 1, '21:9': 1 }).map((ratio) =>
                <button key={ratio} className={form.ratio === ratio ? 'active' : ''} onClick={() => selectRatio(ratio)} disabled={busy}><i className={`ratio-shape shape-${ratio.replace(':', '-')}`} />{ratio}</button>)}</div>
            </div>
            <div className="form-section duration-section">
              <div className="section-title"><label>视频时长</label><strong>{form.duration} 秒</strong></div>
              <input type="range" min="5" max="15" step="1" value={form.duration} style={{ '--range': `${(form.duration - 5) * 10}%` }} onChange={(e) => updateForm('duration', Number(e.target.value))} disabled={busy} />
              <div className="range-labels"><span>5 秒</span><span>15 秒</span></div>
            </div>
            <div className="turbo-row"><div className="turbo-title"><span><Zap size={16} />Turbo 快速模式</span><p>8 步采样，适合日常快速创作</p></div>
              <button className={`switch ${form.turbo ? 'on' : ''}`} onClick={() => updateForm('turbo', !form.turbo)} disabled={busy} aria-label="切换 Turbo 快速模式"><i /></button></div>
            <button className="advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}><Settings2 size={14} />高级设置<ChevronDown size={14} className={showAdvanced ? 'rotated' : ''} /></button>
            {showAdvanced && <div className="advanced-content">
              <div className="seed-row"><label>随机种子</label><div><input type="number" min="0" max="2147483647" value={form.seed} onChange={(e) => updateForm('seed', e.target.value)} disabled={busy || form.randomSeed} /><IconButton label="换一个种子" onClick={randomizeSeed} disabled={busy || form.randomSeed}><RotateCcw size={15} /></IconButton></div></div>
              <label className="check-row"><input type="checkbox" checked={form.randomSeed} onChange={(e) => updateForm('randomSeed', e.target.checked)} disabled={busy} /><span><Check size={12} /></span>每次生成使用新种子</label>
              <div className="tech-note">24 FPS · {durationToFrames(form.duration)} 帧 · {form.turbo ? '8' : '30'} 步 · MP4（含声音）</div>
            </div>}
          </div>
          <div className="generate-area">
            {busy ? <button className="generate-button cancel" onClick={cancel}><Square size={16} fill="currentColor" />取消生成<span>{active.stage}</span></button>
              : <button className="generate-button" onClick={generate} disabled={status.state === 'offline'}><Sparkles size={18} />开始生成<span><kbd>Ctrl</kbd><kbd>↵</kbd></span></button>}
            <p><Info size={12} />生成完全在本机进行，时长取决于显卡与参数</p>
          </div>
        </section>

        <section className="preview-column">
          <div className="preview-card">
            <div className="preview-toolbar"><div><span className="preview-dot" />{selected ? '作品预览' : active ? '生成预览' : '预览窗口'}</div><div>
              {selected && <><IconButton label="下载视频" onClick={() => window.open(selected.url, '_blank')}><ArrowDownToLine size={17} /></IconButton><IconButton label="打开文件夹位置说明" onClick={() => setNotice({ type: 'success', text: '视频保存在 D:\\ComfyUI_Output\\video 目录。' })}><FolderOpen size={17} /></IconButton></>}
              <IconButton label="更多作品" onClick={() => setPage('history')}><MoreHorizontal size={18} /></IconButton>
            </div></div>
            <div className="preview-stage">
              {selected ? <video className="result-video" src={selected.url} controls autoPlay playsInline key={selected.url} />
                : active && busy ? <div className="generation-state">
                  <div className="generation-visual"><div className="scan-line" /><Aperture size={45} strokeWidth={1.2} /></div>
                  <div className="generation-copy"><span className="live-label"><LoaderCircle size={13} className="spin" />本地生成中</span><h2>{active.stage}</h2><p>MiniMax H3 正在把文字转化为画面与声音</p></div>
                  <div className="progress-track"><i style={{ width: `${active.progress || 2}%` }} /></div>
                  <div className="progress-meta"><span>{active.progress || 0}%</span><span>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span></div>
                </div>
                : active && ['error', 'cancelled'].includes(active.state) ? <div className="generation-state result-message"><div className="empty-orbit">{active.state === 'error' ? <X size={30} /> : <Square size={27} />}</div><h3>{active.stage}</h3><p>{active.error || '你可以调整提示词后重新开始。'}</p><button onClick={() => updateActive(null)}>返回创作</button></div>
                : <EmptyPreview ratio={form.ratio} />}
            </div>
            <div className="preview-footer"><span><Cpu size={13} />MiniMax H3 · Int8</span><span>{selected ? `${selected.ratio || '16:9'} · ${selected.duration || 5} 秒` : gpuMemory}</span></div>
          </div>

          <div className="recent-section"><div className="recent-heading"><h2>最近作品</h2><button onClick={() => setPage('history')}>查看全部<span>→</span></button></div>
            {historyItems.length ? <div className="recent-grid">{historyItems.slice(0, 3).map((item) => <VideoCard key={item.id} item={item} onSelect={setSelected} />)}</div>
              : <div className="recent-empty"><Film size={19} /><span>你的作品会出现在这里</span><button onClick={() => document.querySelector('textarea')?.focus()}>创作第一个视频<Plus size={14} /></button></div>}
          </div>
        </section>
      </div>}

      {page === 'history' && <section className="page-content">
        <div className="page-summary"><div><h2>本地作品库</h2><p>共 {historyItems.length} 个由工作台生成的视频</p></div><button className="primary-small" onClick={() => setPage('create')}><Plus size={16} />新建视频</button></div>
        {historyItems.length ? <div className="history-grid">{historyItems.map((item) => <VideoCard key={item.id} item={item} onDelete={removeRecord} onSelect={(entry) => { setSelected(entry); setPage('create'); }} />)}</div>
          : <div className="full-empty"><History size={37} /><h3>还没有本地作品</h3><p>完成一次生成后，视频会自动收藏到这里。</p><button onClick={() => setPage('create')}>开始创作</button></div>}
      </section>}

      {page === 'models' && <section className="page-content models-page">
        <div className="model-hero"><div className="model-logo">H3</div><div><span className="eyebrow">LOCAL VIDEO MODEL</span><h2>MiniMax H3</h2><p>文字、首尾帧图片生成视频，并同步生成声音。</p></div><span className={`model-status ${status.state}`}><i />{status.state === 'online' ? '模型服务正常' : '等待本地服务'}</span></div>
        <div className="model-metrics"><div><Gauge size={19} /><span>默认精度</span><strong>Int8 ConvRot</strong></div><div><Zap size={19} /><span>加速方案</span><strong>8 步 Turbo</strong></div><div><Monitor size={19} /><span>视频规格</span><strong>24 FPS · MP4</strong></div><div><Cpu size={19} /><span>运行设备</span><strong>{gpuMemory}</strong></div></div>
        <div className="model-details"><div className="section-title"><label>已配置模型</label><span>文件保存在 D:\\H3-Models</span></div>
          {[['视频生成模型','minimax_h3_fl2va_pruned_int8_convrot.safetensors'],['文本编码器','qwen3vl_32b_minimax_h3_int8_convrot.safetensors'],['视频 / 音频 VAE','Int8 Video VAE + FP32 Audio VAE'],['Turbo LoRA','minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors']].map(([name,file]) => <div className="model-file" key={name}><div><strong>{name}</strong><code>{file}</code></div><span><Check size={13} />已配置</span></div>)}
        </div>
        <div className="settings-note"><Info size={18} /><div><strong>需要更多控制？</strong><p>点击右上角“高级节点”可打开原始 ComfyUI。模型、输出目录和原工作流均保持不变。</p></div></div>
      </section>}
    </main>
    {notice && <div className={`toast ${notice.type}`}><span>{notice.type === 'success' ? <Check size={16} /> : <Info size={16} />}</span>{notice.text}<button onClick={() => setNotice(null)}><X size={14} /></button></div>}
  </div>;
}
