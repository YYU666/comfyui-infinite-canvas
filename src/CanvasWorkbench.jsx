import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, NodeToolbar,
  Handle, Position, addEdge, useNodesState, useEdgesState, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowDownToLine, ArrowUp, AudioLines, Check, ChevronDown, CircleHelp, Clock3,
  Cpu, Crosshair, Film, FolderOpen, Grid2X2, History, Image as ImageIcon, Layers3,
  Library, Link2, LoaderCircle, Magnet, Map as MapIcon, Maximize2, MemoryStick, Minus, MoreHorizontal, MousePointer2,
  Music2, Pin, Plus, RefreshCw, Search, Settings2, Sparkles, Square, Trash2,
  Type, Upload, Video, WandSparkles, X, Zap,
} from 'lucide-react';
import {
  COMFY_ORIGIN, buildWorkflow, buildReferenceWorkflow, buildCharacterSwapWorkflow, cancelPrompt, createClientId,
  extractVideos, getHardwareMetrics, getHistory, getSystemStats, importVideoFromUrl, openProgressSocket,
  openFileLocation as requestFileLocation, optimizePrompt as requestPromptOptimization, queuePrompt, resolveDimensions, uploadMedia,
} from './workbench-api';
import './canvas.css';
import PromptEditor from './PromptEditor';

const CANVAS_KEY = 'h3-infinite-canvas-v2';
const OLD_CANVAS_KEY = 'h3-infinite-canvas-v1';
const NAME_KEY = 'h3-canvas-name-v1';
const SNAP_KEY = 'h3-canvas-snap-v1';
const NodeContext = createContext(null);
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const DEFAULT_GENERATOR = {
  title: '全能参考', mode: 'reference', prompt: '', ratio: '16:9', resolution: '480P', duration: 5,
  turbo: false, refImageSize: 'max', referenceSettingsVersion: 3, seed: 42, randomSeed: true,
  preserveBackground: true, targetQuery: 'person', targetIndex: 0, targetDescription: '',
  status: 'idle', progress: 0, stage: '', pinned: false, runs: [],
};
const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };
const KIND_ICON = { image: ImageIcon, video: Video, audio: Music2 };
const formatGb = (bytes) => Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(1) : '--';

function initialCanvas() {
  return {
    nodes: [
      { id: 'reference-image', type: 'media', position: { x: 60, y: 180 }, data: { kind: 'image', title: '角色参考', url: '', name: '', pinned: false } },
      { id: 'main-generator', type: 'generator', position: { x: 430, y: 120 }, data: { ...DEFAULT_GENERATOR } },
    ],
    edges: [{ id: 'edge-reference-image-main-generator', source: 'reference-image', target: 'main-generator', sourceHandle: 'ref', targetHandle: 'references' }],
    viewport: { x: 0, y: 0, zoom: 0.9 },
  };
}

function migrateCanvas(value) {
  if (!value?.nodes?.length) return initialCanvas();
  const nodes = value.nodes.map((node) => {
    if (node.type === 'generator' || node.type === 'h3') {
      const data = { ...DEFAULT_GENERATOR, ...node.data, title: node.data.title === 'H3 视频生成' ? '全能参考' : node.data.title, mode: node.data.mode || 'reference' };
      if (data.mode === 'reference' && node.data.referenceSettingsVersion !== 3) Object.assign(data, { turbo: false, refImageSize: 'max', referenceSettingsVersion: 3 });
      return { ...node, type: 'generator', data };
    }
    if (node.type === 'media' || node.type === 'image') {
      const kind = node.data.kind || 'image';
      return { ...node, type: 'media', data: { ...node.data, kind, title: node.data.title === '首帧素材' ? '角色参考' : node.data.title } };
    }
    if (node.type === 'video') return { ...node, type: 'media', data: { ...node.data, kind: 'video', output: true } };
    if (node.type === 'prompt') return { ...node, data: { title: 'H3 提示词优化', idea: '', optimizedPrompt: '', status: 'idle', ...node.data } };
    if (node.type === 'note') return { ...node, data: node.data.title === '从这里开始' ? { ...node.data, text: '① 上传图片、视频或音频素材\n② 选中全能参考，用 + 添加或连线素材\n③ 输入 @ 名称引用角色、动作或声音\n④ 点击右下角箭头，本地生成视频\n\n首尾帧已收进次要模式。' } : node };
    return null;
  }).filter(Boolean);
  const edges = (value.edges || []).map((edge) => {
    const target = nodes.find((node) => node.id === edge.target);
    const isReference = target?.type === 'generator' && (target.data.mode || 'reference') === 'reference';
    return {
      ...edge,
      sourceHandle: ['image', 'video'].includes(edge.sourceHandle) ? 'ref' : edge.sourceHandle,
      targetHandle: isReference && ['first', 'last'].includes(edge.targetHandle) ? 'references' : ['first', 'last', 'preview', 'prompt', 'guide', 'identity'].includes(edge.targetHandle) ? edge.targetHandle : 'references',
    };
  }).filter((edge) => nodes.some((n) => n.id === edge.source) && nodes.some((n) => n.id === edge.target));
  return { ...value, nodes, edges };
}

function readCanvas() {
  try {
    const current = JSON.parse(localStorage.getItem(CANVAS_KEY));
    if (current?.nodes?.length) return migrateCanvas(current);
    const old = JSON.parse(localStorage.getItem(OLD_CANVAS_KEY));
    if (old?.nodes?.length) return migrateCanvas(old);
  } catch { /* Use a clean canvas. */ }
  return initialCanvas();
}

function canvasSnapshot(nodes, edges, viewport) {
  return {
    nodes: nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        url: node.data.remoteName || node.data.output ? node.data.url : node.data.url?.startsWith('blob:') ? '' : node.data.url,
        file: undefined,
      },
    })), edges, viewport,
  };
}

const mediaDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('h3-workbench-media', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('files');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function storeFile(id, file) {
  const db = await mediaDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(file, id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function restoreFile(id) {
  const db = await mediaDb();
  const file = await new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(id);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close();
  return file;
}
async function deleteStoredFile(id) {
  try {
    const db = await mediaDb();
    db.transaction('files').objectStore('files').delete(id);
    db.close();
  } catch { /* Storage cleanup is best-effort. */ }
}

function remoteMediaUrl(path) {
  const parts = (path || '').split('/');
  const filename = parts.pop();
  return `${COMFY_ORIGIN}/view?${new URLSearchParams({ filename, subfolder: parts.join('/'), type: 'input' })}`;
}

function NodeTitle({ id, data, kind }) {
  const { updateNode, togglePin } = useContext(NodeContext);
  const Icon = kind === 'generator' ? WandSparkles : kind === 'prompt' ? Sparkles : kind === 'note' ? Type : KIND_ICON[data.kind] || Film;
  return <div className="neo-node-title">
    <Icon size={14} />
    <input className="nodrag" value={data.title || ''} aria-label="节点名称" onChange={(e) => updateNode(id, { title: e.target.value })} />
    {data.pinned && <button className="title-pin nodrag" onClick={() => togglePin(id)} title="取消 Pin"><Pin size={12} fill="currentColor" /></button>}
  </div>;
}

function NodeActions({ id, data, generator, selected }) {
  const { togglePin, removeNode } = useContext(NodeContext);
  const [historyOpen, setHistoryOpen] = useState(false);
  return <NodeToolbar isVisible={selected} position={Position.Top} offset={10} className="node-top-toolbar nodrag">
    {generator && <div className="node-history-wrap">
      <button onClick={() => setHistoryOpen(!historyOpen)}><Clock3 size={13} /><span>生成记录</span></button>
      {historyOpen && <div className="node-history-pop">
        {(data.runs || []).length ? data.runs.map((run) => <div key={run.promptId || run.time}><i className={run.status} /><span>{run.stage || run.status}<small>{run.time}</small></span></div>) : <p>这个节点还没有生成记录</p>}
      </div>}
    </div>}
    <button className={data.pinned ? 'pin-active' : ''} onClick={() => togglePin(id)} title={data.pinned ? '取消 Pin' : 'Pin 关键节点'}><Pin size={13} fill={data.pinned ? 'currentColor' : 'none'} /></button>
    <button onClick={() => removeNode(id)} title="删除节点"><Trash2 size={13} /></button>
  </NodeToolbar>;
}

function NoteNode({ id, data, selected }) {
  const { updateNode, importVideoReference } = useContext(NodeContext);
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const isGuide = id === 'welcome';
  const submitUrl = async (event) => {
    event.preventDefault();
    if (!url.trim() || importing) return;
    setImporting(true); setError('');
    try { await importVideoReference(url.trim()); setUrl(''); }
    catch (reason) { setError(reason.message || '视频加载失败，请重试。'); }
    finally { setImporting(false); }
  };
  return <div className={`note-shell ${isGuide ? 'guide-note' : ''} ${selected ? 'selected' : ''}`}>
    <NodeTitle id={id} data={data} kind="note" /><NodeActions id={id} data={data} selected={selected} />
    <textarea className="nodrag nowheel" value={data.text || ''} onChange={(e) => updateNode(id, { text: e.target.value })} placeholder="写下分镜、角色设定或创作备注……" />
    {isGuide && <form className="video-url-import nodrag nowheel" onSubmit={submitUrl} onDoubleClick={(event) => event.stopPropagation()}>
      <label htmlFor="video-url-input"><Link2 size={13} />手机分享链接加载参考</label>
      <div className="video-url-row">
        <input id="video-url-input" type="text" inputMode="url" autoComplete="off" spellCheck={false} value={url} disabled={importing} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴抖音 / 小红书分享文字或链接" required />
        <button type="submit" disabled={importing || !url.trim()} title="提取链接并连接为视频参考" aria-label="加载视频链接">{importing ? <LoaderCircle className="spin" size={14} /> : <ArrowDownToLine size={14} />}</button>
      </div>
      <span>{importing ? '正在解析并下载到本机，请保持窗口开启……' : '支持 App 复制的一整段分享内容，会自动提取短链接。'}</span>
      {error && <p className="video-url-error">{error}</p>}
    </form>}
  </div>;
}

function PromptOptimizerNode({ id, data, selected }) {
  const { updateNode, optimizePromptNode, getPromptTarget, getMentionItems } = useContext(NodeContext);
  const target = getPromptTarget(id);
  const running = data.status === 'optimizing';
  const canOptimize = target && !running && (data.idea?.trim() || target.data.prompt?.trim());
  const mentionItems = target ? getMentionItems(target.id) : [];
  return <div className={`prompt-optimizer-shell ${selected ? 'selected' : ''} ${data.pinned ? 'pinned' : ''}`}>
    <NodeTitle id={id} data={data} kind="prompt" /><NodeActions id={id} data={data} selected={selected} />
    <div className="prompt-optimizer-body">
      <div className="optimizer-label"><span>自然语言创意</span><b>DeepSeek · 官方 H3 规范</b></div>
      <PromptEditor
        className="optimizer-idea"
        ariaLabel="自然语言创意"
        value={data.idea || ''}
        disabled={running}
        onChange={(idea) => updateNode(id, { idea, status: 'idle', error: null })}
        items={mentionItems}
        placeholder="输入创意，或输入 @ 引用图片、视频和音频素材……"
      />
      <div className={`optimizer-connection ${target ? 'connected' : ''}`}><Link2 size={12} /><span>{target ? `已连接：${target.data.title} · ${target.data.duration} 秒 · ${target.data.ratio}` : '将右侧 ✦ 端口连接到生成节点左侧 ✦ 端口'}</span></div>
      {data.error && <div className="optimizer-error">{data.error}</div>}
      <button className="optimizer-run nodrag" disabled={!canOptimize} onClick={() => optimizePromptNode(id)}>{running ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}<span>{running ? '正在按 H3 规范改写……' : data.optimizedPrompt ? '重新优化并填入' : '优化并填入生成节点'}</span></button>
      {data.optimizedPrompt && <details className="optimizer-result"><summary><Check size={12} />已填入生成节点，可在提示词框继续微调</summary><pre>{data.optimizedPrompt}</pre></details>}
    </div>
    <Handle type="source" position={Position.Right} id="prompt" className="neo-handle source prompt-source" title="连接到视频生成节点的提示词端口" />
  </div>;
}

function MediaDragSurface({ videoRef, video = false, onActivate }) {
  const pressOrigin = useRef(null);
  const activate = (event) => {
    if (event.detail > 1) return;
    const origin = pressOrigin.current;
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 6) return;
    if (onActivate) { onActivate(); return; }
    if (!video) return;
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) element.play().catch(() => {});
    else element.pause();
  };
  return <div className={`media-drag-surface ${video ? 'video-surface' : ''}`}
    role={onActivate ? 'button' : undefined} tabIndex={onActivate ? 0 : undefined}
    aria-label={onActivate ? '添加素材' : undefined}
    title={onActivate ? '拖动移动节点；单击添加素材' : video ? '拖动移动节点；单击播放或暂停' : '拖动移动节点'}
    onPointerDown={(event) => { pressOrigin.current = { x: event.clientX, y: event.clientY }; }}
    onKeyDown={(event) => { if (onActivate && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onActivate(); } }}
    onClick={activate} />;
}

function MediaNode({ id, data, selected }) {
  const { chooseMedia, togglePin } = useContext(NodeContext);
  const input = useRef(null);
  const videoRef = useRef(null);
  const kind = data.kind || 'image';
  const Icon = KIND_ICON[kind];
  const accept = kind === 'image' ? 'image/png,image/jpeg,image/webp' : kind === 'video' ? 'video/*' : 'audio/*';
  return <div className={`media-shell media-${kind} ${kind === 'image' ? 'image-node' : ''} ${selected ? 'selected' : ''} ${data.pinned ? 'pinned' : ''}`}>
    <NodeTitle id={id} data={data} kind="media" /><NodeActions id={id} data={data} selected={selected} />
    <div className={`media-preview ${!data.url ? 'empty' : ''}`} onDoubleClick={() => input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const file = [...(e.dataTransfer.files || [])].find((item) => item.type.startsWith(`${kind}/`)); if (file) chooseMedia(id, file); }}>
      {data.url ? <>
        {kind === 'image' && <img src={data.url} alt={data.title} draggable={false} />}
        {kind === 'video' && <video ref={videoRef} className="nodrag" src={data.url} controls preload="metadata" playsInline />}
        {kind === 'audio' && <div className="audio-content"><span><AudioLines size={25} /></span><strong>{data.title}</strong><audio className="nodrag" src={data.url} controls preload="metadata" /></div>}
        {['image', 'video'].includes(kind) && <MediaDragSurface videoRef={videoRef} video={kind === 'video'} />}
      </> : <div className="media-empty"><Icon size={26} /><strong>添加{KIND_LABEL[kind]}素材</strong><span>单击添加 · 按住拖动节点</span><MediaDragSurface onActivate={() => input.current?.click()} /></div>}
      <button className="media-replace nodrag" onClick={() => input.current?.click()} title="替换素材"><RefreshCw size={12} /><span>替换</span></button>
      {data.output && <a className="media-download nodrag" href={data.url} target="_blank" rel="noreferrer" title="打开并下载"><ArrowDownToLine size={13} /></a>}
    </div>
    <div className="media-caption"><span>{data.output ? '生成结果' : KIND_LABEL[kind]}</span><b title={data.name}>{data.name || (data.url ? data.title : '未上传')}</b></div>
    <input ref={input} hidden type="file" accept={accept} onChange={(e) => e.target.files?.[0] && chooseMedia(id, e.target.files[0])} />
    {data.output && <Handle type="target" position={Position.Left} id="preview" className="neo-handle target" />}
    <Handle type="source" position={Position.Right} id="ref" className="neo-handle source" title="连接到全能参考" />
  </div>;
}

function referenceDescriptors(nodes) {
  const counters = { image: 0, video: 0, audio: 0 };
  return nodes.map((node) => {
    const kind = node.data.kind || 'image';
    counters[kind] += 1;
    return { node, kind, tag: `<${kind === 'image' ? 'Picture' : kind === 'video' ? 'Video' : 'Audio'} ${counters[kind]}>` };
  });
}

function GeneratorNode({ id, data, selected }) {
  const {
    updateNode, generateNode, cancelNode, serverOnline, getReferences,
    getMentionItems, attachFilesToGenerator,
  } = useContext(NodeContext);
  const promptEditorRef = useRef(null);
  const uploadRef = useRef(null);
  const resultVideoRef = useRef(null);
  const running = ['uploading', 'queued', 'running', 'finishing'].includes(data.status);
  const mode = data.mode || 'reference';
  const refs = getReferences(id);
  const descriptors = referenceDescriptors(refs);
  const guide = refs.find((node) => node.data.slot === 'guide');
  const identity = refs.find((node) => node.data.slot === 'identity');
  const mentionItems = getMentionItems(id);
  const resolution = data.resolution || '480P';
  const [outputWidth, outputHeight] = resolveDimensions(data.ratio, resolution);
  const switchMode = (nextMode) => updateNode(id, { mode: nextMode, title: nextMode === 'swap' && data.title === '全能参考' ? '精准角色替换' : data.title, error: null });

  return <div className={`generator-shell h3-node ${mode === 'swap' ? 'swap-node' : ''} ${selected ? 'selected' : ''} ${running ? 'running' : ''} ${data.pinned ? 'pinned' : ''}`}>
    <NodeTitle id={id} data={data} kind="generator" /><NodeActions id={id} data={data} selected={selected} generator />
    <div className="generator-preview">
      {data.resultUrl ? <>
        <video ref={resultVideoRef} className="nodrag" src={data.resultUrl} controls preload="metadata" playsInline />
        <MediaDragSurface videoRef={resultVideoRef} video />
      </> : <div className="generator-placeholder">
        {running ? <LoaderCircle className="spin" size={29} /> : <WandSparkles size={29} />}
        <strong>{running ? data.stage || '正在准备本地模型' : mode === 'swap' ? '源视频换人 · 保留动作、镜头与原音轨' : mode === 'reference' ? '用图、文、音、视频共同定义新镜头' : mode === 'frames' ? '首尾帧生成视频' : '输入提示词生成视频'}</strong>
        <span>{running ? `${data.progress || 0}% · 可随时取消` : mode === 'swap' ? 'Character Swap v1.1 · AddGuide · SAM3.1' : 'MiniMax H3 · 本地生成 · 24 FPS'}</span>
      </div>}
      {running && <div className="generation-overlay"><div><i style={{ width: `${data.progress || 3}%` }} /></div><span>{data.stage} · {data.progress || 0}%</span></div>}
    </div>
    <div className="generator-subline"><span>{data.ratio} · {resolution} · {data.duration} 秒</span><b>{data.status === 'done' ? '已完成' : mode === 'swap' ? 'H3 换人 v1.1' : 'H3 INT8'}</b></div>
    {data.error && <div className="generator-error">{data.error}</div>}
    {mode === 'reference' ? <Handle type="target" position={Position.Left} id="references" className="neo-handle target" /> : mode === 'frames' ? <>
      <Handle type="target" position={Position.Left} id="first" className="neo-handle target frame-first" />
      <Handle type="target" position={Position.Left} id="last" className="neo-handle target frame-last" />
    </> : mode === 'swap' ? <>
      <Handle type="target" position={Position.Left} id="guide" className="neo-handle target frame-first" title="连接源视频" />
      <Handle type="target" position={Position.Left} id="identity" className="neo-handle target frame-last" title="连接单人身份图" />
    </> : null}
    <Handle type="target" position={Position.Left} id="prompt" className="neo-handle target prompt-target" title="连接 H3 提示词优化" />
    <Handle type="source" position={Position.Right} id="video" className="neo-handle source" />

    <NodeToolbar isVisible={selected} position={Position.Bottom} offset={12} className="creator-toolbar nodrag">
      <div className="creator-modes">
        {[['reference', '全能参考'], ['swap', '角色替换'], ['text', '文生视频'], ['frames', '首尾帧']].map(([value, label]) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => switchMode(value)}>{label}</button>)}
        <span className="local-model"><i />MiniMax H3</span>
      </div>
      {mode === 'swap' && <div className="reference-strip swap-strip">
        <span className={guide ? 'connected' : ''}><Video size={13} />源视频：{guide?.data.title || '连接左侧上方端口'}</span>
        <span className={identity ? 'connected' : ''}><ImageIcon size={13} />身份图：{identity?.data.title || '连接左侧下方端口'}</span>
      </div>}
      {mode === 'reference' && <div className="reference-strip">
        {descriptors.map(({ node, kind, tag }) => <button key={node.id} className={`reference-chip ${kind}`} onClick={() => promptEditorRef.current?.insertReference(node)} title={`${tag} · 点击插入提示词`}>
          {node.data.url && kind === 'image' ? <img src={node.data.url} alt="" /> : node.data.url && kind === 'video' ? <video src={node.data.url} muted playsInline preload="metadata" /> : React.createElement(KIND_ICON[kind], { size: 13 })}
          <span>@{node.data.title}</span><X size={11} onClick={(e) => { e.stopPropagation(); updateNode(id, { prompt: data.prompt.replaceAll(`@${node.data.title}`, '').replace(/ {2,}/g, ' ') }); }} />
        </button>)}
        {descriptors.length < 15 && <button className="add-reference" onClick={() => uploadRef.current?.click()} title="添加图片、视频或音频"><Plus size={17} /></button>}
        <input ref={uploadRef} hidden type="file" multiple accept="image/*,video/*,audio/*" onChange={(e) => { attachFilesToGenerator(id, [...(e.target.files || [])]); e.target.value = ''; }} />
      </div>}
      {mode === 'frames' && <div className="reference-strip frame-strip"><span><i />首帧：{refs.find((n) => n.data.slot === 'first')?.data.title || '连接一张图片'}</span><span><i />尾帧：{refs.find((n) => n.data.slot === 'last')?.data.title || '连接一张图片（可选）'}</span></div>}
      <PromptEditor
        ref={promptEditorRef}
        value={data.prompt || ''}
        onChange={(prompt) => updateNode(id, { prompt })}
        items={mentionItems}
        disabled={running}
        placeholder={mode === 'swap' ? '留空自动锁定参考人物的面部、发型、体型和整套穿搭，不只换脸；也可补充可见特征……' : mode === 'reference' ? '输入文字或 @ 参考内容，自由组合图、文、音、视频……\n例如：@角色参考 在雨夜街道回头，电影感，环境雨声。' : '描述主体、动作、镜头和声音……'}
      />
      {mode === 'swap' && <div className="swap-settings">
        <label>换人目标<input value={data.targetDescription || ''} disabled={running} onChange={(e) => updateNode(id, { targetDescription: e.target.value })} placeholder="例如：左侧穿红衣的人；单人可留空" /></label>
        {data.preserveBackground && <><label>SAM 识别<input value={data.targetQuery || 'person'} disabled={running} onChange={(e) => updateNode(id, { targetQuery: e.target.value })} placeholder="person" /></label><label className="target-index">编号<input type="number" min="0" max="63" value={data.targetIndex ?? 0} disabled={running} onChange={(e) => updateNode(id, { targetIndex: Math.max(0, Number(e.target.value)) })} /></label></>}
      </div>}
      <div className="creator-params">
        <div className="param-group">
          <label className="param-pill"><Zap size={12} /><select aria-label="画幅比例" value={data.ratio} disabled={running} onChange={(e) => updateNode(id, { ratio: e.target.value })}>{['16:9','9:16','1:1','4:3','3:4','21:9'].map((x) => <option key={x}>{x}</option>)}</select><ChevronDown size={11} /></label>
          <label className="param-pill" title={`输出尺寸 ${outputWidth} × ${outputHeight}；分辨率越高，显存占用和生成时间越长`}><Maximize2 size={12} /><select aria-label="分辨率" value={resolution} disabled={running} onChange={(e) => updateNode(id, { resolution: e.target.value })}>{['480P','720P','1080P'].map((x) => <option key={x} value={x}>{x}</option>)}</select><ChevronDown size={11} /></label>
          <label className="param-pill"><Clock3 size={12} /><select aria-label="视频时长" value={data.duration} disabled={running} onChange={(e) => updateNode(id, { duration: Number(e.target.value) })}>{[5,6,7,8,9,10,11,12,13,14,15].map((x) => <option key={x} value={x}>{x} 秒</option>)}</select><ChevronDown size={11} /></label>
          {mode === 'swap' ? <span className="param-pill active" title="作者指定的 DMD、Euler、Simple、CFG 1"><Zap size={12} />DMD 8 步</span> : <button className={`param-pill turbo-pill ${data.turbo ? 'active' : ''}`} disabled={running} title={data.turbo ? 'Turbo 适合快速看构图；角色或动作参考不准确时请切换标准模式' : '标准模式使用 beta 调度，参考身份与动作更稳定'} onClick={() => updateNode(id, { turbo: !data.turbo })}><Zap size={12} />{data.turbo ? `${mode === 'reference' ? 4 : 8} 步 Turbo` : '标准 20 步'}</button>}
          {['reference', 'swap'].includes(mode) && <button className={`param-pill ${data.refImageSize === 'max' ? 'active' : ''}`} onClick={() => updateNode(id, { refImageSize: data.refImageSize === 'max' ? 'match' : 'max' })} title="高保真参考更慢，但保留更多主体细节"><Layers3 size={12} />{data.refImageSize === 'max' ? '高保真' : '均衡'}</button>}
          {mode === 'swap' && <button className={`param-pill ${data.preserveBackground ? 'active' : ''}`} disabled={running} onClick={() => updateNode(id, { preserveBackground: !data.preserveBackground })} title="SAM3.1 跟踪目标并将人物回填到原片，保留蒙版外背景"><Crosshair size={12} />{data.preserveBackground ? '背景保护' : '整片生成'}</button>}
        </div>
        {running ? <button className="send-button cancel" onClick={() => cancelNode(id)} title="取消生成"><Square size={15} fill="currentColor" /></button> : <button className="send-button node-generate" onClick={() => generateNode(id)} disabled={!serverOnline} title="本地生成"><ArrowUp size={17} /></button>}
      </div>
      <div className="creator-footnote"><span>{mode === 'swap' ? '使用清晰单人身份图，不要四宫格；输出保留原音轨' : mode === 'reference' ? `已连接 ${refs.length} 个素材 · 本地上限 9 图 / 3 视频 / 3 音频` : mode === 'frames' ? '首尾帧是次要模式，从图片节点连线到对应端口' : '无需参考素材，直接通过文字生成'}</span><b>本地免费</b></div>
    </NodeToolbar>
  </div>;
}

const nodeTypes = { note: NoteNode, media: MediaNode, generator: GeneratorNode, prompt: PromptOptimizerNode };

function CanvasInner({ onSimpleMode }) {
  const saved = useMemo(readCanvas, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(saved.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved.edges || []);
  const [projectName, setProjectName] = useState(() => localStorage.getItem(NAME_KEY) || '我的本地创作');
  const [saveState, setSaveState] = useState('已保存');
  const [server, setServer] = useState({ online: false, label: '正在连接' });
  const [metrics, setMetrics] = useState({ vramUsed: null, vramTotal: null, cpuPercent: null, ramUsed: null, ramTotal: null });
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);
  const [gridVisible, setGridVisible] = useState(true);
  const [miniMapVisible, setMiniMapVisible] = useState(false);
  const [zoom, setZoom] = useState(Math.round((saved.viewport?.zoom || 1) * 100));
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(() => localStorage.getItem(SNAP_KEY) !== 'false');
  const [addMenu, setAddMenu] = useState(null);
  const [nodeMenu, setNodeMenu] = useState(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const filesRef = useRef({});
  const clientId = useMemo(createClientId, []);
  const { screenToFlowPosition, fitView, setCenter, zoomIn, zoomOut, zoomTo } = useReactFlow();

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => {
    setSaveState('保存中');
    const timer = setTimeout(() => {
      localStorage.setItem(CANVAS_KEY, JSON.stringify(canvasSnapshot(nodes, edges, saved.viewport)));
      setSaveState('已保存');
    }, 400);
    return () => clearTimeout(timer);
  }, [nodes, edges, saved.viewport]);
  useEffect(() => { localStorage.setItem(NAME_KEY, projectName); }, [projectName]);
  useEffect(() => {
    let alive = true;
    nodes.forEach(async (node) => {
      if (node.type !== 'media' || !node.data.localFile || filesRef.current[node.id]) return;
      try {
        const file = await restoreFile(node.id);
        if (!alive || !file) return;
        filesRef.current[node.id] = file;
        if (!node.data.remoteName && !node.data.output) updateNode(node.id, { url: URL.createObjectURL(file), name: file.name });
      } catch { /* The user can replace an unavailable local file. */ }
    });
    return () => { alive = false; };
  }, []);

  const updateNode = useCallback((id, patch) => {
    setNodes((items) => {
      const previous = items.find((node) => node.id === id);
      const renamed = previous && patch.title && patch.title !== previous.data.title;
      return items.map((node) => {
        if (node.id === id) return { ...node, data: { ...node.data, ...patch } };
        if (renamed && node.type === 'generator' && node.data.prompt?.includes(`@${previous.data.title}`)) {
          return { ...node, data: { ...node.data, prompt: node.data.prompt.split(`@${previous.data.title}`).join(`@${patch.title}`) } };
        }
        return node;
      });
    });
  }, [setNodes]);

  const removeNode = useCallback((id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (node?.data.promptId && ['uploading','queued','running'].includes(node.data.status)) cancelPrompt(node.data.promptId).catch(() => {});
    setNodes((items) => items.filter((item) => item.id !== id));
    setEdges((items) => items.filter((edge) => edge.source !== id && edge.target !== id));
    delete filesRef.current[id]; deleteStoredFile(id);
  }, [setNodes, setEdges]);

  const togglePin = useCallback((id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (node) updateNode(id, { pinned: !node.data.pinned });
  }, [updateNode]);

  const chooseMedia = useCallback((id, file) => {
    filesRef.current[id] = file;
    storeFile(id, file).catch(() => {});
    updateNode(id, { url: URL.createObjectURL(file), name: file.name, remoteName: null, localFile: true, output: false, resultUrl: null });
  }, [updateNode]);

  const getReferences = useCallback((id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    const mode = node?.data.mode || 'reference';
    return edgesRef.current.filter((edge) => edge.target === id).map((edge) => {
      const source = nodesRef.current.find((item) => item.id === edge.source);
      return source?.type === 'media' ? { ...source, data: { ...source.data, slot: edge.targetHandle } } : null;
    }).filter(Boolean).filter((source) => mode === 'reference' ? source.data.slot === 'references' : mode === 'frames' ? ['first', 'last'].includes(source.data.slot) && source.data.kind === 'image' : mode === 'swap' ? (source.data.slot === 'guide' && source.data.kind === 'video') || (source.data.slot === 'identity' && source.data.kind === 'image') : false);
  }, []);

  const getMentionItems = useCallback((id) => nodesRef.current.filter((node) => node.type === 'media' && node.id !== id && node.data.title), []);
  const getPromptTarget = useCallback((id) => {
    const edge = edgesRef.current.find((item) => item.source === id && item.targetHandle === 'prompt');
    const target = nodesRef.current.find((node) => node.id === edge?.target);
    return target?.type === 'generator' ? target : null;
  }, []);

  const optimizePromptNode = useCallback(async (id) => {
    const promptNode = nodesRef.current.find((node) => node.id === id);
    const target = getPromptTarget(id);
    if (!promptNode || !target) {
      updateNode(id, { status: 'error', error: '请先把此节点右侧 ✦ 端口连接到生成节点左侧 ✦ 端口。' });
      return;
    }
    const descriptors = referenceDescriptors(getReferences(target.id));
    const toTags = (text) => descriptors.reduce((result, { node, tag }) => result.split(`@${node.data.title}`).join(tag), text || '');
    const toMentions = (text) => descriptors.reduce((result, { node, tag }) => result.split(tag).join(`@${node.data.title}`), text || '');
    updateNode(id, { status: 'optimizing', error: null });
    try {
      const result = await requestPromptOptimization({
        idea: promptNode.data.idea || '',
        currentPrompt: toTags(target.data.prompt),
        mode: target.data.mode || 'reference',
        duration: target.data.duration || 5,
        ratio: target.data.ratio || '16:9',
        references: descriptors.map(({ node, kind, tag }) => ({ title: node.data.title, kind, tag, slot: node.data.slot })),
      });
      const optimized = target.data.mode === 'reference' ? toMentions(result.prompt) : result.prompt;
      updateNode(id, { status: 'done', optimizedPrompt: optimized, model: result.model, syncedAt: Date.now(), error: null });
      updateNode(target.id, { prompt: optimized, error: null });
    } catch (error) {
      updateNode(id, { status: 'error', error: error.message || '提示词优化失败，请重试。' });
    }
  }, [getPromptTarget, getReferences, updateNode]);

  const completeGeneration = useCallback(async (id, promptId) => {
    try {
      const history = await getHistory(100);
      const videos = extractVideos(history?.[promptId]);
      if (!videos.length) throw new Error('任务已结束，但没有找到视频输出。');
      const source = nodesRef.current.find((node) => node.id === id);
      const result = source?.data.mode === 'swap' ? videos.find((file) => file.filename?.startsWith('H3_CharacterSwap')) || videos[0] : videos[0];
      const videoId = uid('video');
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const videoNode = {
        id: videoId, type: 'media', position: { x: (source?.position.x || 0) + 540, y: source?.position.y || 0 },
        data: { ...result, kind: 'video', output: true, title: `${source?.data.mode === 'swap' ? '换人结果' : '成片'} ${time}`, name: result.filename, prompt: source?.data.prompt },
      };
      setNodes((items) => items.map((node) => node.id === id ? {
        ...node,
        data: {
          ...node.data, status: 'done', progress: 100, stage: '生成完成', promptId,
          resultUrl: result.url,
          runs: [{ promptId, status: 'done', stage: '生成完成', time: new Date().toLocaleString('zh-CN') }, ...(node.data.runs || [])].slice(0, 12),
        },
      } : node).concat(videoNode));
      setEdges((items) => addEdge({ id: `edge-${id}-${videoId}`, source: id, target: videoId, sourceHandle: 'video', targetHandle: 'preview' }, items));
    } catch (error) { updateNode(id, { status: 'error', error: error.message, stage: '读取成片失败' }); }
  }, [setNodes, setEdges, updateNode]);

  useEffect(() => {
    const socket = openProgressSocket(clientId, {
      onProgress(data) {
        for (const node of nodesRef.current) if (node.data.promptId === data.prompt_id) updateNode(node.id, { status: 'running', progress: data.max ? Math.round(data.value / data.max * 100) : 0, stage: `采样 ${data.value}/${data.max} 步` });
      },
      onExecuting(data) {
        for (const node of nodesRef.current) {
          if (node.data.promptId !== data.prompt_id) continue;
          if (data.node) updateNode(node.id, { status: 'running', stage: data.node === '12' ? '正在生成画面与声音' : data.node === '16' ? '正在保存 MP4' : '正在准备参考素材与模型' });
          else { updateNode(node.id, { status: 'finishing', stage: '正在读取成片', progress: 100 }); setTimeout(() => completeGeneration(node.id, data.prompt_id), 700); }
        }
      },
      onExecutionError(data) {
        for (const node of nodesRef.current) if (node.data.promptId === data.prompt_id) updateNode(node.id, { status: 'error', error: data.exception_message || '生成执行失败', stage: '生成失败' });
      },
      onInterrupted(data) {
        for (const node of nodesRef.current) if (node.data.promptId === data.prompt_id) updateNode(node.id, { status: 'cancelled', stage: '已取消', progress: 0 });
      },
    });
    return () => socket.close();
  }, [clientId, completeGeneration, updateNode]);

  const checkServer = useCallback(async () => {
    try {
      const [stats, hardware] = await Promise.all([getSystemStats(), getHardwareMetrics().catch(() => null)]);
      const device = stats?.devices?.[0];
      const gpu = device?.name?.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, '') || '本地 GPU';
      setServer({ online: true, label: gpu });
      setMetrics({
        vramUsed: device ? device.vram_total - device.vram_free : null,
        vramTotal: device?.vram_total ?? null,
        cpuPercent: hardware?.cpuPercent ?? null,
        ramUsed: hardware?.ramUsed ?? null,
        ramTotal: hardware?.ramTotal ?? null,
      });
    } catch {
      setServer({ online: false, label: 'ComfyUI 未连接' });
      setMetrics({ vramUsed: null, vramTotal: null, cpuPercent: null, ramUsed: null, ramTotal: null });
    }
  }, []);
  useEffect(() => {
    checkServer();
    const interval = setInterval(checkServer, 3000);
    return () => clearInterval(interval);
  }, [checkServer]);

  const refreshLibrary = useCallback(async () => {
    try {
      const history = await getHistory(100);
      const items = [];
      for (const [promptId, entry] of Object.entries(history || {})) for (const file of extractVideos(entry)) if (file.filename?.includes('H3_Workbench')) items.push({ ...file, promptId, title: file.filename });
      setHistoryItems(items.reverse());
    } catch { setHistoryItems([]); }
  }, []);
  useEffect(() => { if (libraryOpen) refreshLibrary(); }, [libraryOpen, refreshLibrary]);

  const generateNode = useCallback(async (id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (node?.data.mode !== 'swap' && !node?.data.prompt?.trim()) { updateNode(id, { status: 'error', error: '请先输入画面描述。' }); return; }
    const refs = getReferences(id);
    if (node.data.mode === 'reference' && !refs.length) { updateNode(id, { status: 'error', error: '全能参考至少需要一个素材，也可以切换到文生视频。' }); return; }
    if (node.data.mode === 'swap' && (!refs.some((ref) => ref.data.slot === 'guide') || !refs.some((ref) => ref.data.slot === 'identity'))) { updateNode(id, { status: 'error', error: '请连接源视频到上方端口、单人身份图到下方端口。' }); return; }
    updateNode(id, { status: 'uploading', stage: '正在准备素材', progress: 0, error: null });
    try {
      const upload = async (mediaNode) => {
        if (mediaNode.data.remoteName) return mediaNode.data.remoteName;
        let file = filesRef.current[mediaNode.id];
        if (!file && mediaNode.data.url) {
          const response = await fetch(mediaNode.data.url);
          if (!response.ok) throw new Error(`无法读取“${mediaNode.data.title}”。`);
          file = new File([await response.blob()], mediaNode.data.name || `${mediaNode.data.title}.${mediaNode.data.kind === 'audio' ? 'wav' : 'mp4'}`, { type: response.headers.get('content-type') || undefined });
          filesRef.current[mediaNode.id] = file;
        }
        if (!file) throw new Error(`“${mediaNode.data.title}”需要重新上传${KIND_LABEL[mediaNode.data.kind]}。`);
        const remoteName = await uploadMedia(file, mediaNode.data.kind);
        updateNode(mediaNode.id, { remoteName, url: remoteMediaUrl(remoteName) });
        return remoteName;
      };
      const references = [];
      for (const mediaNode of refs) references.push({ kind: mediaNode.data.kind, title: mediaNode.data.title, slot: mediaNode.data.slot, name: await upload(mediaNode) });
      const seed = node.data.randomSeed ? Math.floor(Math.random() * 2147483647) : Number(node.data.seed || 42);
      const options = { ...node.data, seed, references };
      const workflow = node.data.mode === 'swap' ? buildCharacterSwapWorkflow(options) : node.data.mode === 'reference' ? buildReferenceWorkflow(options) : buildWorkflow({ ...options, firstFrame: references.find((ref) => ref.slot === 'first')?.name, lastFrame: references.find((ref) => ref.slot === 'last')?.name });
      updateNode(id, { status: 'queued', stage: '任务已排队', seed });
      const result = await queuePrompt(workflow, clientId);
      updateNode(id, { status: 'queued', stage: '等待本地 GPU', promptId: result.prompt_id, runs: [{ promptId: result.prompt_id, status: 'queued', stage: '已提交', time: new Date().toLocaleString('zh-CN') }, ...(node.data.runs || [])].slice(0, 12) });
    } catch (error) { updateNode(id, { status: 'error', error: error.message, stage: '提交失败' }); }
  }, [clientId, getReferences, updateNode]);

  const cancelNode = useCallback(async (id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    try { await cancelPrompt(node?.data.promptId); updateNode(id, { status: 'cancelled', stage: '已取消', progress: 0 }); }
    catch (error) { updateNode(id, { status: 'error', error: error.message }); }
  }, [updateNode]);

  const addNode = useCallback((type, extra = {}, atPosition = null) => {
    const position = atPosition || screenToFlowPosition({ x: window.innerWidth * 0.45 + Math.random() * 60, y: window.innerHeight * 0.35 + Math.random() * 50 });
    const id = uid(type);
    let data;
    if (type === 'generator') data = { ...DEFAULT_GENERATOR, ...extra };
    else if (type === 'prompt') data = { title: 'H3 提示词优化', idea: '', optimizedPrompt: '', status: 'idle', ...extra };
    else if (type === 'note') data = { title: '创作备注', text: '', ...extra };
    else {
      const kind = extra.kind || type;
      const count = nodesRef.current.filter((node) => node.type === 'media' && node.data.kind === kind).length + 1;
      data = { kind, title: `${KIND_LABEL[kind]} ${count}`, url: '', name: '', ...extra };
      type = 'media';
    }
    setNodes((items) => items.concat({ id, type, position, data }));
    setAddMenu(null);
    setTimeout(() => fitView({ nodes: [{ id }], duration: 300, maxZoom: 1, padding: 0.6 }), 60);
    return id;
  }, [screenToFlowPosition, setNodes, fitView]);

  const attachFilesToGenerator = useCallback((generatorId, files) => {
    const generator = nodesRef.current.find((node) => node.id === generatorId);
    if (!generator) return;
    files.forEach((file, index) => {
      const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image';
      const position = { x: generator.position.x - 330, y: generator.position.y + index * 215 - 60 };
      const id = addNode(kind, { title: file.name.replace(/\.[^.]+$/, '') }, position);
      chooseMedia(id, file);
      setEdges((items) => addEdge({ id: `edge-${id}-${generatorId}`, source: id, target: generatorId, sourceHandle: 'ref', targetHandle: 'references' }, items));
    });
  }, [addNode, chooseMedia, setEdges]);

  const importVideoReference = useCallback(async (url) => {
    const generator = nodesRef.current.find((node) => node.type === 'generator' && node.selected)
      || nodesRef.current.find((node) => node.type === 'generator');
    if (!generator) throw new Error('请先在画布中添加一个生成节点。');
    const mode = generator.data.mode || 'reference';
    if (!['reference', 'swap'].includes(mode)) throw new Error('请先把生成节点切换到“全能参考”或“角色替换”模式。');
    const targetHandle = mode === 'swap' ? 'guide' : 'references';
    const videoCount = edgesRef.current.filter((edge) => edge.target === generator.id && edge.targetHandle === targetHandle)
      .map((edge) => nodesRef.current.find((node) => node.id === edge.source))
      .filter((node) => node?.data.kind === 'video').length;
    if (videoCount >= (mode === 'swap' ? 1 : 3)) throw new Error(mode === 'swap' ? '角色替换已连接源视频，请先移除原连线再导入。' : '每个全能参考节点最多连接 3 段视频。');
    const result = await importVideoFromUrl(url);
    const remoteName = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
    const position = { x: generator.position.x - 340, y: generator.position.y + 220 + videoCount * 210 };
    const id = addNode('video', {
      title: result.title || '在线视频参考', name: result.name, remoteName,
      url: remoteMediaUrl(remoteName), sourceUrl: result.sourceUrl || url, localFile: false,
    }, position);
    setEdges((items) => addEdge({ id: `edge-${id}-${generator.id}`, source: id, target: generator.id, sourceHandle: 'ref', targetHandle }, items));
    return id;
  }, [addNode, setEdges]);

  const onConnect = useCallback((connection) => {
    const source = nodesRef.current.find((node) => node.id === connection.source);
    const target = nodesRef.current.find((node) => node.id === connection.target);
    if (source?.type === 'prompt' && target?.type === 'generator' && connection.targetHandle === 'prompt') {
      setEdges((items) => addEdge({ ...connection, sourceHandle: 'prompt', id: `edge-${connection.source}-${connection.target}-prompt-${Date.now()}` }, items.filter((edge) => !(edge.target === connection.target && edge.targetHandle === 'prompt') && !(edge.source === connection.source && edge.sourceHandle === 'prompt'))));
      return;
    }
    if (source?.type !== 'media' || target?.type !== 'generator') return;
    const mode = target.data.mode || 'reference';
    if (mode === 'reference' && connection.targetHandle === 'references') {
      const sameKind = edgesRef.current.filter((edge) => edge.target === target.id && edge.targetHandle === 'references').map((edge) => nodesRef.current.find((node) => node.id === edge.source)).filter((node) => node?.data.kind === source.data.kind).length;
      const limit = { image: 9, video: 3, audio: 3 }[source.data.kind];
      if (sameKind >= limit) return;
    } else if (mode === 'frames' && ['first','last'].includes(connection.targetHandle) && source.data.kind === 'image') {
      // Single-image keyframe ports are replaced below.
    } else if (mode === 'swap' && ((connection.targetHandle === 'guide' && source.data.kind === 'video') || (connection.targetHandle === 'identity' && source.data.kind === 'image'))) {
      // One guide video and one identity image; reconnecting replaces the previous input.
    } else return;
    setEdges((items) => addEdge({ ...connection, sourceHandle: 'ref', id: `edge-${connection.source}-${connection.target}-${connection.targetHandle}-${Date.now()}` }, items.filter((edge) => mode === 'reference' ? !(edge.source === connection.source && edge.target === connection.target && edge.targetHandle === connection.targetHandle) : !(edge.target === connection.target && edge.targetHandle === connection.targetHandle))));
  }, [setEdges]);

  useEffect(() => {
    if (!addMenu && !nodeMenu) return;
    const closeOnEscape = (event) => { if (event.key === 'Escape') { setAddMenu(null); setNodeMenu(null); } };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [addMenu, nodeMenu]);

  const resetCanvas = () => {
    if (!window.confirm('新建空白画布？当前画布会被替换，但已经生成的视频文件不会删除。')) return;
    const fresh = initialCanvas();
    setNodes(fresh.nodes); setEdges(fresh.edges); setTimeout(() => fitView({ duration: 300 }), 60);
  };
  const placeAddMenu = (screenPoint) => {
    const point = {
      x: Math.max(8, Math.min(screenPoint.x, window.innerWidth - 253)),
      y: Math.max(8, Math.min(screenPoint.y, window.innerHeight - 390)),
    };
    setNodeMenu(null);
    setAddMenu({ ...point, flow: screenToFlowPosition(screenPoint) });
  };
  const openAddMenu = (event) => {
    if (event.target.closest('.react-flow__node,button,input,textarea,.react-flow__controls,.react-flow__minimap,.node-top-toolbar,.creator-toolbar')) return;
    placeAddMenu({ x: event.clientX, y: event.clientY });
  };
  const nodeFileLocation = (node) => {
    if (node.data.output && node.data.filename) return { kind: 'output', name: `${node.data.subfolder ? `${node.data.subfolder}/` : ''}${node.data.filename}` };
    if (node.data.remoteName) return { kind: 'input', name: node.data.remoteName };
    if (node.data.resultUrl) {
      const params = new URL(node.data.resultUrl).searchParams;
      const filename = params.get('filename');
      if (filename) return { kind: params.get('type') || 'output', name: `${params.get('subfolder') ? `${params.get('subfolder')}/` : ''}${filename}` };
    }
    return null;
  };
  const openContextMenu = (event) => {
    if (event.target.closest('input,textarea,select,button,a,[contenteditable="true"],.node-top-toolbar,.creator-toolbar,.add-node-menu,.node-context-menu')) return;
    event.preventDefault();
    const nodeElement = event.target.closest('.react-flow__node');
    const node = nodesRef.current.find((item) => item.id === nodeElement?.dataset.id);
    if (node) {
      setAddMenu(null);
      setNodeMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 238)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 135)),
        nodeId: node.id, title: node.data.title || '节点', file: nodeFileLocation(node), status: 'idle', error: null,
      });
      return;
    }
    placeAddMenu({ x: event.clientX, y: event.clientY });
  };
  const openNodeLocation = async () => {
    if (!nodeMenu?.file || nodeMenu.status === 'opening') return;
    setNodeMenu((menu) => ({ ...menu, status: 'opening', error: null }));
    try {
      await requestFileLocation(nodeMenu.file);
      setNodeMenu(null);
    } catch (error) {
      setNodeMenu((menu) => ({ ...menu, status: 'error', error: error.message || '无法打开文件位置。' }));
    }
  };
  const focusNode = (id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return;
    setCenter(node.position.x + 180, node.position.y + 100, { zoom: 1, duration: 400 });
    setPinOpen(false);
  };

  const context = { updateNode, removeNode, chooseMedia, togglePin, generateNode, cancelNode, serverOnline: server.online, getReferences, getMentionItems, getPromptTarget, optimizePromptNode, attachFilesToGenerator, importVideoReference };
  const pinnedNodes = nodes.filter((node) => node.data.pinned);
  const vramPercent = metrics.vramTotal ? Math.min(100, Math.max(0, metrics.vramUsed / metrics.vramTotal * 100)) : 0;
  const cpuPercent = Number.isFinite(metrics.cpuPercent) ? Math.min(100, Math.max(0, metrics.cpuPercent)) : 0;
  return <NodeContext.Provider value={context}>
    <div className="neo-app">
      <header className="neo-header">
        <div className="neo-project-pill">
          <span className="neo-logo">H<b>3</b></span><ChevronDown size={12} />
          <i />
          <input value={projectName} onChange={(e) => setProjectName(e.target.value)} aria-label="画布项目名称" />
          <span className="save-indicator" title={saveState}><Check size={13} /></span>
        </div>
        <div className="neo-header-right">
          <div className="hardware-monitor" aria-label="硬件状态" title={`${server.label} · 系统内存 ${formatGb(metrics.ramUsed)} / ${formatGb(metrics.ramTotal)} GB · 每 3 秒刷新`}>
            <div className="hardware-metric">
              <span><MemoryStick size={12} />GPU 显存</span>
              <strong>{formatGb(metrics.vramUsed)} <small>/ {formatGb(metrics.vramTotal)} GB</small></strong>
              <div className="hardware-bar"><i style={{ width: `${vramPercent}%` }} /></div>
            </div>
            <div className="hardware-metric cpu-metric">
              <span><Cpu size={12} />CPU</span>
              <strong>{Number.isFinite(metrics.cpuPercent) ? `${Math.round(metrics.cpuPercent)}%` : '--'}</strong>
              <div className="hardware-bar"><i style={{ width: `${cpuPercent}%` }} /></div>
            </div>
          </div>
          <div className="neo-header-actions">
            <button className={`server-status ${server.online ? 'online' : ''}`} onClick={checkServer} title={server.label}><i />{server.online ? '本地已连接' : '本地未连接'}</button>
            <button onClick={onSimpleMode} title="切换简易模式"><MousePointer2 size={15} /></button>
            <button onClick={() => window.open('http://127.0.0.1:8188','_blank')} title="打开 ComfyUI 高级节点"><MoreHorizontal size={17} /></button>
          </div>
        </div>
      </header>
      <main className="neo-canvas-wrap"
        onDragOver={(e) => e.preventDefault()}
        onPointerDownCapture={(event) => { if (event.button === 0 && !event.target.closest('.add-node-menu,.node-context-menu')) { setAddMenu(null); setNodeMenu(null); } }}
        onContextMenuCapture={openContextMenu}
        onDrop={(e) => {
          e.preventDefault();
          [...(e.dataTransfer.files || [])].forEach((file, index) => {
            const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image';
            const position = screenToFlowPosition({ x: e.clientX + index * 25, y: e.clientY + index * 25 });
            const id = addNode(kind, { title: file.name.replace(/\.[^.]+$/, '') }, position); chooseMedia(id, file);
          });
        }}
        onDoubleClickCapture={openAddMenu}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          defaultViewport={saved.viewport} fitView={!localStorage.getItem(CANVAS_KEY) && !localStorage.getItem(OLD_CANVAS_KEY)}
          fitViewOptions={{ padding: 0.16, maxZoom: 0.85 }}
          minZoom={0.12} maxZoom={1.8} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
          panOnDrag panOnScroll={false} selectionOnDrag={false} deleteKeyCode={['Backspace','Delete']}
          snapToGrid={snapEnabled} snapGrid={[22, 22]}
          onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))}
          onMoveEnd={(_, viewport) => { saved.viewport = viewport; localStorage.setItem(CANVAS_KEY, JSON.stringify(canvasSnapshot(nodesRef.current, edgesRef.current, viewport))); }}
          defaultEdgeOptions={{ style: { stroke: '#77777e', strokeWidth: 1.5 }, type: 'smoothstep' }}
          connectionLineStyle={{ stroke: '#eeeeee', strokeWidth: 1.8 }}
          proOptions={{ hideAttribution: true }}
        >
          {gridVisible && <Background variant={BackgroundVariant.Dots} gap={22} size={1.15} color="#3a3a3e" />}
          {miniMapVisible && <MiniMap pannable zoomable nodeColor={(node) => node.type === 'generator' ? '#9999a5' : node.data?.kind === 'audio' ? '#9c83a8' : '#65656d'} maskColor="#111113dc" />}
        </ReactFlow>
        {!nodes.length && <button className="empty-canvas" onClick={(e) => setAddMenu({ x: e.clientX, y: e.clientY, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) })}><Plus size={28} /><strong>双击画布开始创作</strong><span>或点击右下角添加节点</span></button>}
        <div className="canvas-bottom-left">
          {zoomMenuOpen && <div className="zoom-menu">
            <button onClick={() => zoomOut({ duration: 160 })} title="缩小"><Minus size={14} /></button>
            <button className="zoom-current" onClick={() => zoomTo(1, { duration: 200 })} title="恢复到 100%">{zoom}%</button>
            <button onClick={() => zoomIn({ duration: 160 })} title="放大"><Plus size={14} /></button>
            <i />
            <button onClick={() => { fitView({ duration: 350, padding: 0.15 }); setZoomMenuOpen(false); }} title="适应全部节点"><Maximize2 size={14} /></button>
          </div>}
          <div className="canvas-control-pill">
            <button className={gridVisible ? 'active' : ''} onClick={() => setGridVisible(!gridVisible)} title="显示或隐藏网格"><Grid2X2 size={15} /></button>
            <button className={miniMapVisible ? 'active' : ''} onClick={() => setMiniMapVisible(!miniMapVisible)} title="小地图"><MapIcon size={15} /></button>
            <button className={zoomMenuOpen ? 'zoom-button active' : 'zoom-button'} onClick={() => setZoomMenuOpen(!zoomMenuOpen)} title="缩放" aria-expanded={zoomMenuOpen}><Search size={13} /><span>{zoom}%</span></button>
          </div>
          <button className="round-control" onClick={() => fitView({ duration: 350, padding: 0.15 })} title="节点定位"><Crosshair size={16} /></button>
          <button className="round-control" onClick={resetCanvas} title="新建画布"><CircleHelp size={16} /></button>
        </div>
        <div className="canvas-dock">
          <button className="dock-add" onClick={(e) => setAddMenu({ x: window.innerWidth / 2 - 110, y: window.innerHeight - 440, flow: screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) })} title="添加元素"><Plus size={19} /></button>
          <button className={libraryOpen ? 'active' : ''} onClick={() => { setLibraryOpen(!libraryOpen); setPinOpen(false); }} title="本地作品"><FolderOpen size={17} /></button>
          <button onClick={() => { setLibraryOpen(true); refreshLibrary(); }} title="生成历史"><History size={17} /></button>
          <button onClick={() => fitView({ duration: 350, padding: 0.15 })} title="适应画布"><Crosshair size={17} /></button>
          <button className={snapEnabled ? 'active' : ''} aria-pressed={snapEnabled} onClick={() => { const next = !snapEnabled; setSnapEnabled(next); localStorage.setItem(SNAP_KEY, String(next)); }} title="自动吸附"><Magnet size={16} /></button>
          <button onClick={onSimpleMode} title="工作台设置与简易模式"><Settings2 size={17} /></button>
          <button className={pinOpen ? 'active' : ''} onClick={() => { setPinOpen(!pinOpen); setLibraryOpen(false); }} title={`Pin 节点 ${pinnedNodes.length}`}><Pin size={16} /></button>
        </div>
        {addMenu && <div className="add-node-menu" role="menu" aria-label="添加节点" style={{ left: addMenu.x, top: addMenu.y }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} onDoubleClick={(e) => e.stopPropagation()}>
          <div className="add-menu-title">添加节点 · 右键画布 <button onClick={() => setAddMenu(null)} aria-label="关闭添加节点菜单"><X size={13} /></button></div>
          <button onClick={() => addNode('generator', {}, addMenu.flow)}><i><WandSparkles size={17} /></i><span>全能参考<small>图、文、音、视频多元素生成</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'swap', title: '精准角色替换' }, addMenu.flow)}><i><Crosshair size={17} /></i><span>角色替换<small>逐帧引导、SAM3.1 锁人、原背景与原音轨</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('prompt', {}, addMenu.flow)}><i><Sparkles size={17} /></i><span>提示词优化<small>自然语言转 MiniMax H3 专用提示词</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('image', {}, addMenu.flow)}><i><ImageIcon size={17} /></i><span>图片素材<small>角色、场景、风格参考</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('video', {}, addMenu.flow)}><i><Video size={17} /></i><span>视频素材<small>动作、运镜或内容参考</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('audio', {}, addMenu.flow)}><i><Music2 size={17} /></i><span>音频素材<small>音色、配乐或声音参考</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('note', {}, addMenu.flow)}><i><Type size={17} /></i><span>文本备注<small>分镜与创作设定</small></span><Plus size={13} /></button>
        </div>}
        {nodeMenu && <div className="add-node-menu node-context-menu" role="menu" aria-label="节点操作"
          style={{ left: nodeMenu.x, top: nodeMenu.y }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onDoubleClick={(event) => event.stopPropagation()}>
          <div className="add-menu-title">{nodeMenu.title}
            <button onClick={() => setNodeMenu(null)} aria-label="关闭节点菜单"><X size={13} /></button>
          </div>
          <button disabled={!nodeMenu.file || nodeMenu.status === 'opening'} onClick={openNodeLocation}>
            <i><FolderOpen size={17} /></i>
            <span>{nodeMenu.status === 'opening' ? '正在打开……' : '打开文件位置'}
              <small>{nodeMenu.file ? '在资源管理器中定位文件' : '上传素材或生成后可定位'}</small>
            </span>
          </button>
          {nodeMenu.error && <p className="node-menu-error">{nodeMenu.error}</p>}
        </div>}
      </main>
      {libraryOpen && <aside className="floating-library">
        <div className="floating-panel-title"><span><Library size={15} />本地作品</span><button onClick={() => setLibraryOpen(false)}><X size={15} /></button></div>
        <p>点击作品添加到画布，也可以继续作为视频参考。</p>
        <button className="library-refresh" onClick={refreshLibrary}><RefreshCw size={12} />刷新列表</button>
        <div className="library-list">{historyItems.map((item) => <button key={`${item.promptId}-${item.filename}`} onClick={() => { addNode('video', { ...item, output: true, kind: 'video', title: item.filename.replace(/^H3_Workbench_?/, '成片 ') }); setLibraryOpen(false); }}>
          <video src={item.url} preload="metadata" muted /><span>{item.filename}<small>添加到画布</small></span><Plus size={14} />
        </button>)}{!historyItems.length && <div className="library-empty"><Film size={26} /><span>还没有 H3 视频作品</span></div>}</div>
      </aside>}
      {pinOpen && <aside className="floating-pins">
        <div className="floating-panel-title"><span><Pin size={14} />Pin 关键节点</span><button onClick={() => setPinOpen(false)}><X size={14} /></button></div>
        <p>把常用角色、设定和生成节点固定在这里。</p>
        {pinnedNodes.map((node) => <button key={node.id} onClick={() => focusNode(node.id)}><Crosshair size={13} /><span>{node.data.title}</span><small>{node.type === 'generator' ? '生成' : KIND_LABEL[node.data.kind] || '备注'}</small></button>)}
        {!pinnedNodes.length && <div className="library-empty"><Pin size={22} /><span>选中节点后点击 Pin 标记</span></div>}
      </aside>}
    </div>
  </NodeContext.Provider>;
}

export default function CanvasWorkbench(props) {
  return <ReactFlowProvider><CanvasInner {...props} /></ReactFlowProvider>;
}
