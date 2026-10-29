import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, NodeToolbar,
  Handle, Position, ConnectionLineType, SelectionMode, addEdge, useNodesState, useEdgesState, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowDownToLine, ArrowUp, AudioLines, Check, ChevronDown, CircleHelp, Clock3,
  Cpu, Crosshair, Film, FolderOpen, Grid2X2, History, Image as ImageIcon, Layers3,
  Library, Link2, LoaderCircle, Magnet, Map as MapIcon, Maximize2, MemoryStick, Minus, MoreHorizontal, MousePointer2,
  Music2, Pin, Plus, Redo2, RefreshCw, Search, Settings2, Sparkles, Square, Trash2,
  Type, Undo2, Upload, Video, WandSparkles, X, Zap,
} from 'lucide-react';
import {
  COMFY_ORIGIN, buildWorkflow, buildReferenceWorkflow, buildCharacterSwapWorkflow, buildHdRefineWorkflow,
  buildImageWorkflow, buildImageHdWorkflow, buildIdentityEditWorkflow, buildQwen21EditWorkflow, buildLocalRealismWorkflow, buildOutfitQueuePlan, resolveOutfitPanels, OUTFIT_PRESETS, QWEN_OUTFIT_PRESETS, cancelGeneration, createClientId, enqueueGeneration, extractImages, extractVideos,
  freeComfyMemory, getHardwareMetrics, getHistory, getMossDependencyStatus, getSystemStats, importVideoFromUrl, openProgressSocket, openQueueEvents,
  openFileLocation as requestFileLocation, optimizePrompt as requestPromptOptimization,
  resolveDimensions, resolveImageDimensions, uploadMedia,
} from './workbench-api';
import { findFreePosition } from './canvas-layout';
import { copyCanvasSelection, pasteCanvasSelection } from './canvas-clipboard';
import './canvas.css';
import PromptEditor from './PromptEditor';
import MaskEditor from './MaskEditor';
import ImageLightbox from './ImageLightbox';
import { useCanvasMcp } from './canvas-mcp';
import CanvasProjectMenu from './CanvasProjectMenu';
import CreativePanel from './CreativePanel';
import { initializeProjects, listProjects, createProject, openProject, closeProject, saveProject, projectSummary, saveProjectFile, readProjectFile, createDomainEntity, createTake } from './project-store-http';
import { AutoSaveController } from './auto-save';
import { CanvasHistory, restoreHistoryNodes } from './canvas-history';
import { comfyExternalAsset, queueJobAction, queueOwnsCompletion, queueOwnsStage, takeOutputIdentity } from './generation-queue';
import { ensureReferenceTags, nextReferenceTag, referenceDescriptors } from './reference-tags';
import { ObjectUrlLru } from './object-url-lru';
import { assertMediaCacheIdentity, mediaCacheIdentity, reconcileMediaCache } from './canvas-media-cache';
import { GenerationAttempts } from './generation-attempts';
import { flushProjectAfterMedia } from './project-save-barrier';

const SNAP_KEY = 'h3-canvas-snap-v1';
const NodeContext = createContext(null);
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const DEFAULT_GENERATOR = {
  title: '全能参考', mode: 'reference', prompt: '', ratio: '16:9', resolution: '480P', duration: 5,
  turbo: false, refImageSize: 'max', referenceSettingsVersion: 3, seed: 42, randomSeed: true,
  preserveBackground: true, targetQuery: 'person', targetIndex: 0, targetDescription: '', precision: 1,
  imageModel: 'krea2', imageLora: 'none', loraStrength: 0.8, imageScale: 1.5,
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
  if (!Array.isArray(value?.nodes)) return initialCanvas();
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
    if (node.type === 'note') return { ...node, data: node.data.title === '从这里开始' ? { ...node.data, text: '① 上传图片、视频或音频素材\n② 选中全能参考，用 + 添加或连线素材\n③ 输入 @ 名称引用角色、动作或声音\n④ 点击右下角箭头，本地生成视频\n\n首尾帧已收进次要模式。' } : node.data };
    return null;
  }).filter(Boolean);
  const edges = (value.edges || []).map((edge) => {
    const target = nodes.find((node) => node.id === edge.target);
    const isReference = target?.type === 'generator' && (target.data.mode || 'reference') === 'reference';
    return {
      ...edge,
      type: 'default',
      sourceHandle: ['image', 'video'].includes(edge.sourceHandle) ? 'ref' : edge.sourceHandle,
      targetHandle: isReference && ['first', 'last'].includes(edge.targetHandle) ? 'references' : ['first', 'last', 'preview', 'prompt', 'guide', 'identity'].includes(edge.targetHandle) ? edge.targetHandle : 'references',
    };
  }).filter((edge) => nodes.some((n) => n.id === edge.source) && nodes.some((n) => n.id === edge.target));
  return { ...value, nodes: ensureReferenceTags(nodes), edges };
}

function canvasSnapshot(nodes, edges, viewport) {
  return {
    nodes: nodes.map((node) => {
      const { measured, selected, dragging, ...stableNode } = node;
      return {
        ...stableNode,
        data: {
          ...node.data,
          url: node.data.remoteName || node.data.output ? node.data.url : node.data.url?.startsWith('blob:') ? '' : node.data.url,
          file: undefined,
        },
      };
    }), edges, viewport,
  };
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

const thumbnailCache = new ObjectUrlLru(64);
const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
let thumbnailQueue = Promise.resolve();
async function imageThumbnail(source) {
  const cached = thumbnailCache.get(source);
  if (cached) return cached.pending;
  const create = async () => {
    const response = await fetch(source);
    if (!response.ok) throw new Error('缩略图读取失败');
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const thumbnail = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.84));
    if (!thumbnail) throw new Error('缩略图编码失败');
    return URL.createObjectURL(thumbnail);
  };
  // Decode one original at a time; simultaneous 4K bitmaps can exhaust the renderer.
  const pending = thumbnailQueue.then(create, create);
  thumbnailQueue = pending.catch(() => {});
  thumbnailCache.set(source, pending);
  return pending;
}

function CanvasImage({ source, alt = '', ...props }) {
  const [displaySource, setDisplaySource] = useState(EMPTY_IMAGE);
  useEffect(() => {
    let active = true;
    setDisplaySource(EMPTY_IMAGE);
    if (source) imageThumbnail(source).then((thumbnail) => { if (active) setDisplaySource(thumbnail); }).catch(() => { if (active) setDisplaySource(source); });
    return () => { active = false; };
  }, [source]);
  return <img src={displaySource} alt={alt} draggable={false} loading="lazy" decoding="async" {...props} />;
}

function MediaNode({ id, data, selected }) {
  const { chooseMedia, openImagePreview, viewTier, getMaskGuide } = useContext(NodeContext);
  const input = useRef(null);
  const videoRef = useRef(null);
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
  const kind = data.kind || 'image';
  const Icon = KIND_ICON[kind];
  const accept = kind === 'image' ? 'image/png,image/jpeg,image/webp' : kind === 'video' ? 'video/*' : 'audio/*';
  const lightweightVideo = kind === 'video' && viewTier !== 'full';
  const maskGuide = kind === 'image' ? getMaskGuide(id) : null;
  const openMaskEditor = () => setMaskEditorOpen(true);
  return <div className={`media-shell media-${kind} ${kind === 'image' ? 'image-node' : ''} ${selected ? 'selected' : ''} ${data.pinned ? 'pinned' : ''}`}>
    <NodeTitle id={id} data={data} kind="media" /><NodeActions id={id} data={data} selected={selected} />
    <div className={`media-preview ${!data.url ? 'empty' : ''}`} title={maskGuide ? '单击在母图上绘制遮罩' : kind === 'image' && data.url ? '双击预览大图' : undefined} onDoubleClick={(event) => {
      event.stopPropagation();
      if (maskGuide) openMaskEditor();
      else if (kind === 'image' && data.url) openImagePreview({ url: data.url, title: data.title, name: data.name });
      else input.current?.click();
    }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const file = [...(e.dataTransfer.files || [])].find((item) => item.type.startsWith(`${kind}/`)); if (file) chooseMedia(id, file); }}>
      {data.url ? <>
        {kind === 'image' && <CanvasImage source={data.url} alt={data.title} />}
        {kind === 'video' && (lightweightVideo ? <div className="media-video-compact"><Film size={24} /><span>视频预览 · 放大恢复播放</span></div> : <video ref={videoRef} className="nodrag" src={data.url} controls preload="metadata" playsInline />)}
        {kind === 'audio' && <div className="audio-content"><span><AudioLines size={25} /></span><strong>{data.title}</strong>{viewTier === 'full' && <audio className="nodrag" src={data.url} controls preload="metadata" />}</div>}
        {['image', 'video'].includes(kind) && <MediaDragSurface videoRef={videoRef} video={kind === 'video' && !lightweightVideo} onActivate={maskGuide ? openMaskEditor : undefined} />}
      </> : <div className="media-empty"><Icon size={26} /><strong>{maskGuide ? '绘制局部遮罩' : `添加${KIND_LABEL[kind]}素材`}</strong><span>{maskGuide ? '单击绘制 · 母图垫底' : '单击添加 · 按住拖动节点'}</span><MediaDragSurface onActivate={maskGuide ? openMaskEditor : () => input.current?.click()} /></div>}
      {maskGuide && <button className="media-mask-edit nodrag" onClick={openMaskEditor}>绘制遮罩</button>}
      <button className="media-replace nodrag" onClick={() => input.current?.click()} title={maskGuide ? '从文件导入黑白遮罩' : '替换素材'}><RefreshCw size={12} /><span>{maskGuide ? '导入' : '替换'}</span></button>
      {data.output && <a className="media-download nodrag" href={data.url} target="_blank" rel="noreferrer" title="打开并下载"><ArrowDownToLine size={13} /></a>}
    </div>
    <div className="media-caption"><span>{maskGuide ? '局部遮罩' : data.output ? '生成结果' : KIND_LABEL[kind]}</span><b title={data.name}>{data.name || (data.url ? data.title : maskGuide ? '尚未绘制' : '未上传')}</b></div>
    <input ref={input} hidden type="file" accept={accept} onChange={(e) => e.target.files?.[0] && chooseMedia(id, e.target.files[0])} />
    {data.output && <Handle type="target" position={Position.Left} id="preview" className="neo-handle target" />}
    <Handle type="source" position={Position.Right} id="ref" className="neo-handle source" title="连接到全能参考" />
    {maskEditorOpen && maskGuide && <MaskEditor guideUrl={maskGuide.data.url} guideTitle={maskGuide.data.title} maskUrl={data.url} onSave={(file) => { chooseMedia(id, file); setMaskEditorOpen(false); }} onClose={() => setMaskEditorOpen(false)} />}
  </div>;
}

function GeneratorNode({ id, data, selected }) {
  const {
    updateNode, generateNode, cancelNode, serverOnline, getReferences,
    getMentionItems, attachFilesToGenerator, openImagePreview, viewTier,
  } = useContext(NodeContext);
  const promptEditorRef = useRef(null);
  const uploadRef = useRef(null);
  const resultVideoRef = useRef(null);
  const running = ['uploading', 'queued', 'running', 'finishing'].includes(data.status);
  const mode = data.mode || 'reference';
  const isMoss = mode === 'image' && data.imageModel === 'moss';
  const imageModelLabel = isMoss ? 'MOSS' : 'Krea2';
  const imageFamily = ['image', 'imageUpscale', 'identityEdit', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(mode);
  const refs = getReferences(id);
  const descriptors = referenceDescriptors(refs);
  const guide = refs.find((node) => node.data.slot === 'guide');
  const identity = refs.find((node) => node.data.slot === 'identity');
  const mentionItems = getMentionItems(id);
  const resolution = data.resolution || '480P';
  const [outputWidth, outputHeight] = ['outfitEdit', 'qwenEdit', 'localRealism'].includes(mode) ? [0, 0] : ['image', 'identityEdit'].includes(mode) ? resolveImageDimensions(data.ratio) : resolveDimensions(data.ratio, resolution);
  const switchMode = (nextMode) => updateNode(id, { mode: nextMode, title: nextMode === 'swap' && data.title === '全能参考' ? '精准角色替换' : data.title, error: null });
  const placeholder = mode === 'localRealism' ? '连接正面人像，只修复皮肤，不重绘五官' : mode === 'outfitEdit' ? '连接原始四视图，分别换装，低于 1K 才高清后拼接' : mode === 'qwenEdit' ? '连接母图，用自然语言精准修改画面' : mode === 'identityEdit' ? '连接母图，保持身份并修改姿态、穿搭或场景' : mode === 'image' ? '本地生成人物、场景和分镜参考图' : mode === 'imageUpscale' ? '图片独立高清 · 连接图片后按需运行' : mode === 'swap' ? '源视频换人 · 保留动作、镜头与原音轨' : mode === 'upscale' ? '独立高清二采 · 需要时才运行' : mode === 'reference' ? '用图、文、音、视频共同定义新镜头' : mode === 'frames' ? '首尾帧生成视频' : '输入提示词生成视频';
  const modelLabel = mode === 'localRealism' ? `Qwen 2.1 · 皮肤区域重绘 · 原图回贴 · ${data.localRealismSteps || 25} 步` : mode === 'outfitEdit' ? 'Qwen 2.1 · 40 步 · 低于 1K 才 SeedVR2 高清' : mode === 'qwenEdit' ? `Qwen Image 2.1 INT8 · 原图比例 · ${data.qwenSteps || 40} 步` : mode === 'identityEdit' ? 'Identity Edit V2 · 参考强度 4 · 8 步' : mode === 'image' ? `${imageModelLabel} · 约 1MP · ${isMoss ? 25 : 8} 步` : mode === 'imageUpscale' ? 'SeedVR2 3B INT8 · 保真色彩' : mode === 'swap' ? 'Character Swap v1.5 · 潜空间遮罩 · SAM3.1' : mode === 'upscale' ? 'H3 3D Latent 放大 · 4 步 Turbo · 原音轨' : 'MiniMax H3 · 本地生成 · 24 FPS';
  const outfitLayout = data.outfitLayout || 'legacy';
  const customOutfitPanels = outfitLayout === 'custom' && Array.isArray(data.outfitPanels) && data.outfitPanels.length === 4 ? data.outfitPanels : resolveOutfitPanels({ outfitLayout: 'equalGrid' });
  const changeOutfitLayout = (layout) => {
    const patch = { outfitLayout: layout, error: null };
    if (layout === 'custom' && outfitLayout !== 'custom') patch.outfitPanels = resolveOutfitPanels({ outfitLayout: outfitLayout === 'legacy' ? 'equalGrid' : outfitLayout });
    updateNode(id, patch);
  };
  const updateCustomOutfitPanel = (panelId, key, value) => updateNode(id, {
    outfitPanels: customOutfitPanels.map((panel) => panel.id === panelId ? { ...panel, [key]: ['x', 'y', 'width', 'height'].includes(key) ? Number(value) / 100 : value } : panel),
    error: null,
  });

  return <div className={`generator-shell h3-node ${mode === 'swap' ? 'swap-node' : ''} ${imageFamily ? 'image-generator-node' : ''} ${selected ? 'selected' : ''} ${running ? 'running' : ''} ${data.pinned ? 'pinned' : ''}`}>
    <NodeTitle id={id} data={data} kind="generator" /><NodeActions id={id} data={data} selected={selected} generator />
    <div className="generator-preview" title={imageFamily && data.resultUrl ? '双击预览大图' : undefined} onDoubleClick={(event) => {
      if (!imageFamily || !data.resultUrl) return;
      event.stopPropagation();
      openImagePreview({ url: data.resultUrl, title: data.title });
    }}>
      {data.resultUrl ? <>
        {imageFamily ? <CanvasImage source={data.resultUrl} alt={data.title} draggable={false} /> : viewTier !== 'full' ? <div className="media-video-compact"><Film size={24} /><span>视频结果 · 放大恢复播放</span></div> : <video ref={resultVideoRef} className="nodrag" src={data.resultUrl} controls preload="metadata" playsInline />}
        <MediaDragSurface videoRef={resultVideoRef} video={!imageFamily && viewTier === 'full'} />
      </> : <div className="generator-placeholder">
        {running ? <LoaderCircle className="spin" size={29} /> : imageFamily ? <ImageIcon size={29} /> : <WandSparkles size={29} />}
        <strong>{running ? data.stage || '正在准备本地模型' : placeholder}</strong>
        <span>{running ? `${data.progress || 0}% · 可随时取消` : modelLabel}</span>
      </div>}
      {running && <div className="generation-overlay"><div><i style={{ width: `${data.progress || 3}%` }} /></div><span>{data.stage} · {data.progress || 0}%</span></div>}
    </div>
    <div className="generator-subline"><span>{mode === 'localRealism' ? `原图尺寸 · 局部 ${data.localRealismSize || 768} · 保护未选区域` : mode === 'outfitEdit' ? (data.outfitPanel ? '单视图 · 低于 1K 才高清' : `四张单图 · 按需高清 · ${(data.outfitLayout || 'legacy') === 'legacy' ? '旧版拼接' : '原版面合成'}`) : mode === 'qwenEdit' ? `继承原图比例 · 参考精度 ${data.qwenRefResolution || 1024} · ${data.qwenSteps || 40} 步` : ['image', 'identityEdit'].includes(mode) ? `${data.ratio} · ${outputWidth} × ${outputHeight} · ${isMoss ? 25 : 8} 步` : mode === 'imageUpscale' ? `${data.imageScale || 1.5} 倍 · 独立图片高清` : `${data.ratio} · ${resolution}${mode === 'upscale' ? ' · 独立二采' : ` · ${data.duration} 秒`}`}</span><b>{data.status === 'done' ? '已完成' : mode === 'outfitEdit' ? '无抠图换装' : mode === 'qwenEdit' ? 'Qwen 2.1' : mode === 'identityEdit' ? 'Identity V2' : mode === 'image' ? `${imageModelLabel} 生图` : mode === 'imageUpscale' ? 'SeedVR2 高清' : mode === 'swap' ? 'H3 换人 v1.5' : mode === 'upscale' ? 'H3 高清二采' : 'H3 INT8'}</b></div>
    {data.error && <div className="generator-error">{data.error}</div>}
    {mode === 'reference' ? <Handle type="target" position={Position.Left} id="references" className="neo-handle target" /> : mode === 'frames' ? <>
      <Handle type="target" position={Position.Left} id="first" className="neo-handle target frame-first" />
      <Handle type="target" position={Position.Left} id="last" className="neo-handle target frame-last" />
    </> : ['swap', 'upscale'].includes(mode) ? <>
      <Handle type="target" position={Position.Left} id="guide" className="neo-handle target frame-first" title={mode === 'upscale' ? '连接一采视频' : '连接源视频'} />
      <Handle type="target" position={Position.Left} id="identity" className="neo-handle target frame-last" title={mode === 'upscale' ? '可选身份图' : '连接单人身份图'} />
    </> : ['qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) ? <>
      <Handle type="target" position={Position.Left} id="guide" className="neo-handle target frame-first" title={mode === 'outfitEdit' ? '连接原始四视图' : '连接人物或场景母图'} />
      <Handle type="target" position={Position.Left} id="identity" className="neo-handle target frame-last" title={mode === 'localRealism' ? '可选：连接自定义局部遮罩图' : mode === 'outfitEdit' ? '可选：连接穿搭参考图' : '可选：连接妆容或风格参考图'} />
    </> : ['imageUpscale', 'identityEdit', 'outfitEdit'].includes(mode) ? <Handle type="target" position={Position.Left} id="guide" className="neo-handle target" title={mode === 'outfitEdit' ? '连接原始四视图' : mode === 'identityEdit' ? '连接人物或场景母图' : '连接要高清的图片'} /> : null}
    {!imageFamily && <Handle type="target" position={Position.Left} id="prompt" className="neo-handle target prompt-target" title="连接 H3 提示词优化" />}
    <Handle type="source" position={Position.Right} id={imageFamily ? 'image' : 'video'} className="neo-handle source" />

    <NodeToolbar isVisible={selected} position={Position.Bottom} offset={12} className="creator-toolbar nodrag">
      <div className="creator-modes">
        {imageFamily ? <button className="active">{mode === 'outfitEdit' ? '无抠图换装' : mode === 'qwenEdit' ? 'Qwen 2.1 图生图' : mode === 'identityEdit' ? '母图编辑 V2' : mode === 'image' ? '本地生图' : '图片高清'}</button> : [['reference', '全能参考'], ['swap', '角色替换'], ['text', '文生视频'], ['frames', '首尾帧']].map(([value, label]) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => switchMode(value)}>{label}</button>)}
        <span className="local-model"><i />{mode === 'outfitEdit' ? '千问换装 · 单图 SeedVR2' : mode === 'qwenEdit' ? 'Qwen Image 2.1 INT8' : mode === 'identityEdit' ? 'Identity Edit V2' : mode === 'image' ? (isMoss ? 'MOSS · Spectrum 加速' : 'Krea2 Turbo') : mode === 'imageUpscale' ? 'SeedVR2 3B' : mode === 'upscale' ? '高清二采' : 'MiniMax H3'}</span>
      </div>
      {['swap', 'upscale'].includes(mode) && <div className="reference-strip swap-strip">
        <span className={guide ? 'connected' : ''}><Video size={13} />{mode === 'upscale' ? '一采视频' : '源视频'}：{guide?.data.title || '连接左侧上方端口'}</span>
        <span className={identity ? 'connected' : ''}><ImageIcon size={13} />身份图：{identity?.data.title || (mode === 'upscale' ? '可选，连接左侧下方端口' : '连接左侧下方端口')}</span>
      </div>}
      {['imageUpscale', 'identityEdit', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && <div className="reference-strip swap-strip"><span className={guide ? 'connected' : ''}><ImageIcon size={13} />{mode === 'outfitEdit' ? '原始四视图' : mode === 'identityEdit' ? '人物母图' : '输入图片'}：{guide?.data.title || '从图片节点右侧连线到本节点左侧'}</span>{['qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && <span className={identity ? 'connected' : ''}><ImageIcon size={13} />{mode === 'localRealism' ? '自定义遮罩' : mode === 'outfitEdit' ? '穿搭参考' : '妆容 / 风格'}：{identity?.data.title || '可选，连接左侧下方端口'}</span>}</div>}
      {mode === 'reference' && <div className="reference-strip">
        {descriptors.map(({ node, kind, tag }) => <button key={node.id} className={`reference-chip ${kind}`} onClick={() => promptEditorRef.current?.insertReference(node)} title={`${tag} · 点击插入提示词`}>
          {node.data.url && kind === 'image' ? <CanvasImage source={node.data.url} alt="" /> : node.data.url && kind === 'video' ? <video src={node.data.url} muted playsInline preload="metadata" /> : React.createElement(KIND_ICON[kind], { size: 13 })}
          <span>@{node.data.title}</span><X size={11} onClick={(e) => { e.stopPropagation(); updateNode(id, { prompt: data.prompt.replaceAll(`@${node.data.title}`, '').replace(/ {2,}/g, ' ') }); }} />
        </button>)}
        {descriptors.length < 15 && <button className="add-reference" onClick={() => uploadRef.current?.click()} title="添加图片、视频或音频"><Plus size={17} /></button>}
        <input ref={uploadRef} hidden type="file" multiple accept="image/*,video/*,audio/*" onChange={(e) => { attachFilesToGenerator(id, [...(e.target.files || [])]); e.target.value = ''; }} />
      </div>}
      {mode === 'frames' && <div className="reference-strip frame-strip"><span><i />首帧：{refs.find((n) => n.data.slot === 'first')?.data.title || '连接一张图片'}</span><span><i />尾帧：{refs.find((n) => n.data.slot === 'last')?.data.title || '连接一张图片（可选）'}</span></div>}
      {mode === 'outfitEdit' && <div className="reference-strip outfit-presets">{Object.entries(OUTFIT_PRESETS).map(([key, preset]) => <button key={key} className={data.outfitPreset === key ? 'reference-chip active' : 'reference-chip'} disabled={running} onClick={() => updateNode(id, { outfitPreset: key, prompt: preset.prompt })}>{preset.label}</button>)}</div>}
      {mode === 'outfitEdit' && <div className="outfit-layout-settings">
        <div className="outfit-layout-head"><label>母图版面<select aria-label="母图版面" value={outfitLayout} disabled={running} onChange={(event) => changeOutfitLayout(event.target.value)}><option value="mixedGrid">非等分四宫格 · 当前母图</option><option value="equalGrid">等分四宫格</option><option value="horizontal">横排四视图</option><option value="custom">自定义面板</option><option value="legacy">旧版兼容</option></select></label><span>{outfitLayout === 'legacy' ? '保留旧项目的固定坐标与近景原图逻辑' : outfitLayout === 'horizontal' ? '四等分横排，默认四个全身视角' : outfitLayout === 'custom' ? '边界使用原图百分比；景别与方向可逐面板调整' : '逐面板换装、独立高清，最后按原尺寸与位置回贴'}</span></div>
        {outfitLayout === 'custom' && <div className="outfit-panel-editor">{customOutfitPanels.map((panel, index) => <div className="outfit-panel-row" key={panel.id}>
          <b>面板 {index + 1}</b>
          <select aria-label={`面板 ${index + 1} 景别`} title="景别" value={panel.role || 'body'} disabled={running} onChange={(event) => updateCustomOutfitPanel(panel.id, 'role', event.target.value)}><option value="portrait">近景</option><option value="body">全身</option></select>
          <select aria-label={`面板 ${index + 1} 视角`} title="视角" value={panel.view || 'front'} disabled={running} onChange={(event) => updateCustomOutfitPanel(panel.id, 'view', event.target.value)}><option value="front">正面</option><option value="side">侧面</option><option value="back">背面</option><option value="threeQuarter">三分之四</option></select>
          {[['x', 'X'], ['y', 'Y'], ['width', '宽'], ['height', '高']].map(([key, label]) => <label key={key}>{label}<input aria-label={`面板 ${index + 1} ${label} 百分比`} type="number" min="0" max="100" step="0.1" value={Number(((panel[key] || 0) * 100).toFixed(3))} disabled={running} onChange={(event) => updateCustomOutfitPanel(panel.id, key, event.target.value)} /></label>)}
        </div>)}</div>}
      </div>}
      {mode === 'qwenEdit' && <div className="reference-strip outfit-presets" aria-label="Qwen 穿搭预设">{Object.entries(QWEN_OUTFIT_PRESETS).map(([key, preset]) => <button key={key} className={data.outfitPreset === key ? 'reference-chip active' : 'reference-chip'} disabled={running} onClick={() => updateNode(id, { outfitPreset: key, prompt: preset.prompt })}>{preset.label}</button>)}</div>}
      {mode !== 'imageUpscale' && <PromptEditor
        ref={promptEditorRef}
        value={data.prompt || ''}
        onChange={(prompt) => updateNode(id, { prompt, outfitPreset: null })}
        items={['image', 'identityEdit', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) ? [] : mentionItems}
        ariaLabel={['image', 'identityEdit', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) ? '图片提示词' : '视频提示词'}
        disabled={running}
        placeholder={mode === 'outfitEdit' ? '选择穿搭或输入服装描述；自动保持母图细腰和身体比例，四张分别高清后拼接……' : mode === 'qwenEdit' ? '明确写出要保持的人物特征，以及只修改的穿搭、局部或场景；输出继承第一张母图的比例……' : mode === 'identityEdit' ? '说明要保持的身份特征和要改变的穿搭、姿态或场景；四视图需写明正面、侧面、背面、三分之四视角……' : mode === 'image' ? '描述人物全身、穿搭、场景、光线和镜头；生成后可连接到视频参考或首尾帧……' : mode === 'swap' ? '留空自动锁定参考人物的面部、发型、体型和整套穿搭，不只换脸；也可补充可见特征……' : mode === 'upscale' ? '留空自动保持人物、穿搭、动作和场景，只补充高清细节；也可输入额外要求……' : mode === 'reference' ? '输入文字或 @ 参考内容，自由组合图、文、音、视频……\n例如：@角色参考 在雨夜街道回头，电影感，环境雨声。' : '描述主体、动作、镜头和声音……'}
      />}
      {mode === 'swap' && <div className="swap-settings">
        <label>换人目标<input value={data.targetDescription || ''} disabled={running} onChange={(e) => updateNode(id, { targetDescription: e.target.value })} placeholder="例如：右侧白色假人；单人可留空" /></label>
        <label>SAM 识别<input value={data.targetQuery || 'person'} disabled={running} onChange={(e) => updateNode(id, { targetQuery: e.target.value })} placeholder="person" /></label>
        <label>目标位置<select aria-label="目标位置" value={data.targetSelection || 'largest'} disabled={running} onChange={(e) => updateNode(id, { targetSelection: e.target.value })}><option value="largest">最大主体</option><option value="leftmost">最左侧</option><option value="rightmost">最右侧</option><option value="index">按编号</option></select></label>
        {(data.targetSelection || 'largest') === 'index' && <label className="target-index">编号<input type="number" min="0" max="63" value={data.targetIndex ?? 0} disabled={running} onChange={(e) => updateNode(id, { targetIndex: Math.max(0, Number(e.target.value)) })} /></label>}
      </div>}
      <div className="creator-params">
        <div className="param-group">
          {!['imageUpscale', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && <label className="param-pill" title={mode === 'upscale' ? '高清二采应保持与一采相同的画幅比例' : ''}><Zap size={12} /><select aria-label="画幅比例" value={data.ratio} disabled={running} onChange={(e) => updateNode(id, { ratio: e.target.value })}>{['16:9','9:16','1:1','4:3','3:4','21:9'].map((x) => <option key={x}>{x}</option>)}</select><ChevronDown size={11} /></label>}
          {!imageFamily && <label className="param-pill" title={`输出尺寸 ${outputWidth} × ${outputHeight}；分辨率越高，显存占用和生成时间越长`}><Maximize2 size={12} /><select aria-label="分辨率" value={resolution} disabled={running} onChange={(e) => updateNode(id, { resolution: e.target.value })}>{['480P','720P','1080P'].map((x) => <option key={x} value={x}>{x}</option>)}</select><ChevronDown size={11} /></label>}
          {!['upscale', 'image', 'imageUpscale', 'identityEdit', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && <label className="param-pill"><Clock3 size={12} /><select aria-label="视频时长" value={data.duration} disabled={running} onChange={(e) => updateNode(id, { duration: Number(e.target.value) })}>{[5,6,7,8,9,10,11,12,13,14,15].map((x) => <option key={x} value={x}>{x} 秒</option>)}</select><ChevronDown size={11} /></label>}
          {mode === 'outfitEdit' && <><span className="param-pill active" title="四张视图分别处理、分别高清，不在整张四视图上高清"><Check size={12} />单图高清 · 后拼接</span><label className="param-pill" title="Qwen 2.1 专用写实角色 LoRA；脸部建议 0.45，过高可能改变人物"><Sparkles size={12} /><select aria-label="换装写实强度" value={data.imageLora === 'qwen21Realism' ? String(data.loraStrength ?? 0.6) : 'off'} disabled={running} onChange={(e) => updateNode(id, e.target.value === 'off' ? { imageLora: 'none' } : { imageLora: 'qwen21Realism', loraStrength: Number(e.target.value) })}><option value="off">原版写实</option><option value={0.45}>写实 LoRA · 0.45</option><option value={0.6}>写实 LoRA · 0.6</option><option value={0.7}>写实 LoRA · 0.7</option><option value={0.8}>写实 LoRA · 0.8</option></select><ChevronDown size={11} /></label></>}
          {mode === 'image' && <><label className="param-pill" title="Krea2 适合快速生图；MOSS 用于从零生成新角色和场景"><Layers3 size={12} /><select aria-label="生图模型" value={data.imageModel || 'krea2'} disabled={running} onChange={(e) => updateNode(id, { imageModel: e.target.value, error: null })}><option value="krea2">Krea2 · 快速生图</option><option value="moss">MOSS · 角色与场景</option></select><ChevronDown size={11} /></label>{!isMoss && <label className="param-pill"><Sparkles size={12} /><select aria-label="图片风格" value={data.imageLora || 'none'} disabled={running} onChange={(e) => updateNode(id, { imageLora: e.target.value })}><option value="none">无 LoRA</option><option value="realism">写实增强</option><option value="asian">亚洲人物</option><option value="fantasy">奇幻现实</option><option value="watercolor">柔和水彩</option><option value="retroAnime">复古动漫</option></select><ChevronDown size={11} /></label>}</>}
          {mode === 'imageUpscale' && <label className="param-pill"><Maximize2 size={12} /><select aria-label="图片放大倍数" value={data.imageScale || 1.5} disabled={running} onChange={(e) => updateNode(id, { imageScale: Number(e.target.value) })}><option value={1.5}>1.5× · 约 2K</option><option value={2}>2× · 细节更多</option></select><ChevronDown size={11} /></label>}
          {mode === 'qwenEdit' && <><label className="param-pill" title="Euler、Simple、CFG 1；25 步用于快速预览，40 步用于质量对照"><Zap size={12} /><select aria-label="Qwen 采样步数" value={data.qwenSteps || 40} disabled={running} onChange={(e) => updateNode(id, { qwenSteps: Number(e.target.value) })}><option value={25}>25 步 · 预览</option><option value={40}>40 步 · 质量</option></select><ChevronDown size={11} /></label><label className="param-pill" title="风格化人物转真人时使用任转真 LoRA；普通编辑可关闭以优先保持原图"><Sparkles size={12} /><select aria-label="图生图真人化强度" value={data.imageLora === 'qwen21Realism' ? String(data.loraStrength ?? 0.6) : 'off'} disabled={running} onChange={(e) => updateNode(id, e.target.value === 'off' ? { imageLora: 'none' } : { imageLora: 'qwen21Realism', loraStrength: Number(e.target.value) })}><option value="off">原模型</option><option value={0.45}>真人化 LoRA · 0.45</option><option value={0.6}>真人化 LoRA · 0.6</option><option value={0.8}>真人化 LoRA · 0.8</option></select><ChevronDown size={11} /></label></>}
          {mode === 'localRealism' && <><label className="param-pill" title="按原图视角选择对应皮肤区域；身体视图使用肤色与区域双重限制"><Crosshair size={12} /><select aria-label="原图视角" value={data.localMaskMode || 'front'} disabled={running} onChange={(e) => updateNode(id, { localMaskMode: e.target.value })}><option value="front">正面近景</option><option value="side">侧面近景</option><option value="back_body">背面全身</option><option value="front_body">正面全身</option></select><ChevronDown size={11} /></label><label className="param-pill" title="仅对皮肤区域采样，之后回贴原图"><Zap size={12} /><select aria-label="局部修复步数" value={data.localRealismSteps || 25} disabled={running} onChange={(e) => updateNode(id, { localRealismSteps: Number(e.target.value) })}><option value={20}>20 步 · 轻修</option><option value={25}>25 步 · 标准</option><option value={30}>30 步 · 精修</option><option value={40}>40 步 · 完整重绘</option></select><ChevronDown size={11} /></label><label className="param-pill" title="局部裁切区域的生成分辨率；最终始终回贴原始尺寸，1536 适合 4K 母图细节对照"><Maximize2 size={12} /><select aria-label="局部修复精度" value={data.localRealismSize || 768} disabled={running} onChange={(e) => updateNode(id, { localRealismSize: Number(e.target.value) })}><option value={768}>局部 768</option><option value={1024}>局部 1024</option><option value={1536}>局部 1536 · 4K 母图</option></select><ChevronDown size={11} /></label><label className="param-pill" title="低强度保留原图结构并轻度增加肤质；1.0 为完整重采样，可能产生接缝"><Zap size={12} /><select aria-label="局部重绘强度" value={data.localRealismDenoise ?? 1} disabled={running} onChange={(e) => updateNode(id, { localRealismDenoise: Number(e.target.value) })}><option value={0.2}>轻修 · 0.20</option><option value={0.35}>自然 · 0.35</option><option value={0.5}>加强 · 0.50</option><option value={1}>完整重采样 · 1.00</option></select><ChevronDown size={11} /></label><label className="param-pill" title="0 最保守；增大后可能碰到五官边缘"><Crosshair size={12} /><select aria-label="皮肤遮罩外扩" value={data.localMaskExpand ?? 0} disabled={running} onChange={(e) => updateNode(id, { localMaskExpand: Number(e.target.value) })}><option value={0}>遮罩不外扩</option><option value={8}>外扩 8 px</option><option value={16}>外扩 16 px</option></select><ChevronDown size={11} /></label><label className="param-pill" title="仅在皮肤遮罩内使用 Qwen 2.1 写实 LoRA；0.45 优先保持人物身份"><Sparkles size={12} /><select aria-label="局部写实强度" value={data.imageLora === 'qwen21Realism' ? String(data.loraStrength ?? 0.45) : 'off'} disabled={running} onChange={(e) => updateNode(id, e.target.value === 'off' ? { imageLora: 'none' } : { imageLora: 'qwen21Realism', loraStrength: Number(e.target.value) })}><option value="off">原模型</option><option value={0.35}>写实 LoRA · 0.35</option><option value={0.45}>写实 LoRA · 0.45</option><option value={0.6}>写实 LoRA · 0.6</option><option value={0.8}>写实 LoRA · 0.8</option></select><ChevronDown size={11} /></label></>}
          {['qwenEdit', 'localRealism'].includes(mode) ? null : ['image', 'identityEdit', 'outfitEdit'].includes(mode) ? <span className="param-pill active" title={`${mode === 'outfitEdit' ? '各视图保持原始宽高比' : `输出 ${outputWidth} × ${outputHeight}`}；Euler、Simple、CFG 1${mode === 'outfitEdit' ? '；千问 40 步；每张独立 SeedVR2 高清' : mode === 'identityEdit' ? '；参考强度 4；自由重构' : ''}`}><Zap size={12} />{mode === 'outfitEdit' ? '40 步 · 单图高清' : mode === 'identityEdit' ? 'V2 · 强度 4' : isMoss ? '25 步 · Spectrum' : '8 步 Turbo'}</span> : mode === 'imageUpscale' ? <span className="param-pill active" title="SeedVR2 3B INT8 一步扩散，Lab 保真校色"><Zap size={12} />1 步 · 保真</span> : mode === 'upscale' ? <span className="param-pill active" title="导演台高清分支参数：4 步 768P Turbo LoRA、Euler、Beta、3 步、0.2 降噪"><Zap size={12} />4 步 Turbo · 3 步二采</span> : mode === 'swap' ? <span className="param-pill active" title="Akatz 官方参数：FL2V Turbo、ER-SDE、Normal、CFG 1"><Zap size={12} />v1.5 · 8 步</span> : <button className={`param-pill turbo-pill ${data.turbo ? 'active' : ''}`} disabled={running} title={data.turbo ? 'Turbo 适合快速看构图；角色或动作参考不准确时请切换标准模式' : '标准模式使用 beta 调度，参考身份与动作更稳定'} onClick={() => updateNode(id, { turbo: !data.turbo })}><Zap size={12} />{data.turbo ? `${mode === 'reference' ? 4 : 8} 步 Turbo` : '标准 20 步'}</button>}
          {mode === 'reference' && <button className={`param-pill ${data.refImageSize === 'max' ? 'active' : ''}`} onClick={() => updateNode(id, { refImageSize: data.refImageSize === 'max' ? 'match' : 'max' })} title="高保真参考更慢，但保留更多主体细节"><Layers3 size={12} />{data.refImageSize === 'max' ? '高保真' : '均衡'}</button>}
          {mode === 'swap' && <span className="param-pill active" title="SAM3.1 遮罩直接作用于源视频 latent，而非生成后回填"><Crosshair size={12} />潜空间保护</span>}
        </div>
        {running ? <button className="send-button cancel" onClick={() => cancelNode(id)} title="取消生成"><Square size={15} fill="currentColor" /></button> : <button className="send-button node-generate" onClick={() => generateNode(id)} disabled={!serverOnline} title={mode === 'imageUpscale' ? '本地高清放大' : '本地生成'}><ArrowUp size={17} /></button>}
      </div>
      <div className="creator-footnote"><span>{mode === 'outfitEdit' ? (outfitLayout === 'legacy' ? '旧版兼容：只换两张身体图并保留近景原图' : '逐面板换装与高清；近景不拉远、全身不补头；最终保持母图原尺寸与版面') : mode === 'qwenEdit' ? '原生整图编辑；继承第一张母图比例；与 Identity V2 同题对照后选用 · Qwen Research License' : mode === 'identityEdit' ? '母图保持身份；可换装、换姿态、做四视图；结果可继续连图片高清或视频参考' : mode === 'image' ? (isMoss ? 'MOSS 从零生成新角色和场景；25 步 Spectrum 加速；模型依赖会在提交前检查' : '人物建议写明“全身、完整穿搭”；结果可直接连视频参考或首尾帧') : mode === 'imageUpscale' ? '只放大图片，不重新设计人物和场景；默认 1.5 倍，按需运行' : mode === 'swap' ? '仅运行一采角色替换；需要高清时，再连接独立高清二采节点' : mode === 'upscale' ? '默认 720P；画幅需与一采一致；Sage 加速；保留原音轨' : mode === 'reference' ? `已连接 ${refs.length} 个素材 · 本地上限 9 图 / 3 视频 / 3 音频` : mode === 'frames' ? '首尾帧是次要模式，从图片节点连线到对应端口' : '无需参考素材，直接通过文字生成'}</span><b>本地免费</b></div>
    </NodeToolbar>
  </div>;
}

const nodeTypes = { note: React.memo(NoteNode), media: React.memo(MediaNode), generator: React.memo(GeneratorNode), prompt: React.memo(PromptOptimizerNode) };

function CanvasInner({ onSimpleMode, onLauncher, project, onProjectChange }) {
  const saved = useMemo(() => migrateCanvas(project.canvas), [project.id]);
  const [nodes, setNodes, onNodesChange] = useNodesState(saved.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved.edges || []);
  const [projectName, setProjectName] = useState(project.name);
  const [projects, setProjects] = useState(() => [projectSummary(project)]);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [creativeOpen, setCreativeOpen] = useState(false);
  const revisionRef = useRef(project.revision);
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => { revisionRef.current = project.revision; }, [project.revision]);
  const updateProjectDocument = useCallback((next) => {
    projectRef.current = next;
    revisionRef.current = next.revision;
    onProjectChange(next);
  }, [onProjectChange]);
  const autoSaveRef = useRef(null);
  const switchingRef = useRef(false);
  const mediaWritesRef = useRef(new Map());
  const nameRef = useRef(projectName);
  nameRef.current = projectName;
  const viewportRef = useRef(saved.viewport);
  const [saveState, setSaveState] = useState(project.readOnly ? '只读' : '已保存');
  const [server, setServer] = useState({ online: false, label: '正在连接' });
  const [metrics, setMetrics] = useState({ vramUsed: null, vramTotal: null, cpuPercent: null, ramUsed: null, ramTotal: null });
  const [memoryCleanup, setMemoryCleanup] = useState('idle');
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
  const [imagePreview, setImagePreview] = useState(null);
  const previewCloseRef = useRef(null);
  const completedJobsRef = useRef(new Set());
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const filesRef = useRef({});
  const fileIdentitiesRef = useRef({});
  const generationAttemptsRef = useRef(new GenerationAttempts());
  const clipboardRef = useRef(null);
  const clientId = useMemo(createClientId, []);
  const { screenToFlowPosition, fitView, setCenter, zoomIn, zoomOut, zoomTo } = useReactFlow();

  useEffect(() => {
    if (!imagePreview) return undefined;
    const previousFocus = document.activeElement;
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setImagePreview(null);
    };
    document.addEventListener('keydown', closeOnEscape, true);
    previewCloseRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', closeOnEscape, true);
      previousFocus?.focus?.();
    };
  }, [imagePreview]);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const historyRef = useRef(null);
  if (!historyRef.current) historyRef.current = new CanvasHistory(nodes, edges, { onChange: setHistoryState });
  useEffect(() => {
    historyRef.current.observe(nodes, edges, { coalesce: nodes.some((node) => node.dragging) });
  }, [nodes, edges]);
  useEffect(() => {
    if (project.readOnly) return undefined;
    const labels = { saved: '已保存', dirty: '有未保存修改', saving: '保存中', error: '保存失败' };
    const controller = new AutoSaveController({
      name: project.name,
      canvas: canvasSnapshot(nodesRef.current, edgesRef.current, viewportRef.current),
      write: async ({ name }) => {
        await Promise.all([...mediaWritesRef.current.values()]);
        const next = await saveProject(project.id, revisionRef.current, nameRef.current || name, canvasSnapshot(nodesRef.current, edgesRef.current, viewportRef.current));
        revisionRef.current = next.revision;
        setProjects((rows) => rows.map((row) => row.id === next.id ? projectSummary(next) : row));
        setProjectError('');
      },
      onStateChange: (state) => setSaveState(labels[state] || '已保存'),
      onNotice: () => setSaveState('已自动保存'),
      onError: (error) => setProjectError(error.message || '项目保存失败，请保留本页后重试。'),
    });
    autoSaveRef.current = controller;
    return () => { controller.dispose(); autoSaveRef.current = null; };
  }, [project.id, project.readOnly]);
  useEffect(() => {
    autoSaveRef.current?.observe(projectName, canvasSnapshot(nodes, edges, viewportRef.current));
  }, [nodes, edges, projectName]);
  const persistProject = useCallback(() => {
    if (project.readOnly || !autoSaveRef.current) return Promise.resolve();
    return flushProjectAfterMedia({
      mediaWrites: mediaWritesRef.current,
      observeAndFlush: () => {
        // A slow upload may be the only dirty change. Always sample after it
        // commits, even when AutoSaveController had no pending snapshot before.
        autoSaveRef.current.observe(nameRef.current, canvasSnapshot(nodesRef.current, edgesRef.current, viewportRef.current));
        return autoSaveRef.current.flush();
      },
    });
  }, [project.readOnly]);
  useEffect(() => {
    const flush = () => { if (document.visibilityState === 'hidden') persistProject().catch(() => {}); };
    const beforeUnload = (event) => {
      if (autoSaveRef.current?.hasUnsaved() || mediaWritesRef.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('beforeunload', beforeUnload);
    return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('beforeunload', beforeUnload); };
  }, [persistProject]);
  const refreshProjects = useCallback(async () => {
    try { setProjects(await listProjects()); }
    catch (error) { setProjectError(error.message || '项目列表读取失败。'); }
  }, []);
  useEffect(() => { refreshProjects(); }, [refreshProjects]);
  const hasActiveTask = () => nodesRef.current.some((node) => ['uploading', 'queued', 'running', 'finishing', 'optimizing'].includes(node.data.status));
  const changeProject = async (id, name) => {
    if (switchingRef.current) return false;
    if (hasActiveTask()) { setProjectError('任务进行中，请等待完成后再新建或切换项目。'); return false; }
    switchingRef.current = true; setProjectBusy(true);
    try {
      await persistProject();
      if (hasActiveTask()) throw new Error('任务进行中，请等待完成后再切换项目。');
      const target = id ? await openProject(id) : await createProject(name, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
      const active = id ? target : await openProject(target.id);
      await closeProject(project.id);
      onProjectChange(active);
      return true;
    } catch (error) { setProjectError(error.message || '切换失败，当前画布已保留。'); return false; }
    finally { switchingRef.current = false; setProjectBusy(false); }
  };
  useEffect(() => {
    let alive = true;
    nodes.forEach(async (node) => {
      if (node.type !== 'media' || !node.data.localFile || filesRef.current[node.id]) return;
      try {
        const file = await readProjectFile(project, node.data.mediaStorageId || node.id, node.data.assetPath);
        if (!alive || !file) return;
        filesRef.current[node.id] = file;
        fileIdentitiesRef.current[node.id] = mediaCacheIdentity(node.data);
        if (!node.data.remoteName && !node.data.output) updateNode(node.id, { url: URL.createObjectURL(file) });
      } catch { /* The user can replace an unavailable local file. */ }
    });
    return () => { alive = false; thumbnailCache.clear(); };
  }, []);

  const updateNode = useCallback((id, patch) => {
    if (switchingRef.current || project.readOnly) return;
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

  const promoteToShot = useCallback(async () => {
    const selected = nodesRef.current.filter((node) => node.selected && node.type === 'generator');
    if (selected.length !== 1) { setProjectError('请先选中一个生成节点，再提升为镜头。'); return; }
    const source = selected[0];
    try {
      await persistProject();
      const current = { ...projectRef.current, revision: revisionRef.current };
      const result = await createDomainEntity(current, 'shots', {
        number: `S${String(current.shots.length + 1).padStart(2, '0')}`,
        name: source.data.title || '未命名镜头', prompt: source.data.prompt || '', canvasNodeId: source.id,
        params: { ratio: source.data.ratio || '16:9', resolution: source.data.resolution || '480P', duration: source.data.duration || 5, seed: source.data.seed || 0, turbo: !!source.data.turbo },
      });
      updateProjectDocument(result.project);
      updateNode(source.id, { shotId: result.item.id });
      setCreativeOpen(true);
      setProjectError('');
    } catch (error) { setProjectError(error.message || '提升为镜头失败。'); }
  }, [persistProject, updateNode, updateProjectDocument]);

  const removeNode = useCallback((id) => {
    if (switchingRef.current || project.readOnly) return;
    const node = nodesRef.current.find((item) => item.id === id);
    if ((node?.data.queueJobId || node?.data.promptId) && ['uploading', 'queued', 'running', 'finishing'].includes(node.data.status)) cancelGeneration(node.data).catch(() => {});
    setNodes((items) => items.filter((item) => item.id !== id));
    setEdges((items) => items.filter((edge) => edge.source !== id && edge.target !== id));
    delete filesRef.current[id];
    delete fileIdentitiesRef.current[id];
    generationAttemptsRef.current.cancel(id);
    mediaWritesRef.current.delete(id);
    // Keep immutable media records: this deletion may fail its project revision
    // check, and another committed canvas can still reference the same record.
  }, [setNodes, setEdges]);

  const togglePin = useCallback((id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (node) updateNode(id, { pinned: !node.data.pinned });
  }, [updateNode]);

  const chooseMedia = useCallback((id, file) => {
    if (switchingRef.current || project.readOnly) return;
    // Keep the previous committed reference until the immutable replacement is
    // fully written. A full disk or failed request must not blank the old media.
    const mediaStorageId = uid('media');
    const pending = saveProjectFile(project.id, mediaStorageId, file);
    mediaWritesRef.current.set(id, pending);
    setSaveState('保存中');
    pending.then((result) => {
      if (mediaWritesRef.current.get(id) !== pending) return;
      mediaWritesRef.current.delete(id);
      if (!nodesRef.current.some((node) => node.id === id)) return;
      revisionRef.current = Math.max(revisionRef.current, result.revision);
      filesRef.current[id] = file;
      const patch = { url: URL.createObjectURL(file), name: file.name, mediaStorageId, assetPath: result.asset.path, remoteName: null, localFile: true, output: false, resultUrl: null };
      fileIdentitiesRef.current[id] = mediaCacheIdentity({ ...nodesRef.current.find((node) => node.id === id)?.data, ...patch });
      const nextNodes = nodesRef.current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node);
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
    }, (error) => {
      if (mediaWritesRef.current.get(id) === pending) mediaWritesRef.current.delete(id);
      setSaveState('保存失败');
      setProjectError(error.message || '素材保存失败，已保留原素材，请释放磁盘空间后重试。');
    });
  }, [setNodes, project.id, project.readOnly]);

  const getReferences = useCallback((id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    const mode = node?.data.mode || 'reference';
    return edgesRef.current.filter((edge) => edge.target === id).map((edge) => {
      const source = nodesRef.current.find((item) => item.id === edge.source);
      return source?.type === 'media' ? { ...source, data: { ...source.data, slot: edge.targetHandle } } : null;
    }).filter(Boolean).filter((source) => mode === 'reference' ? source.data.slot === 'references' : mode === 'frames' ? ['first', 'last'].includes(source.data.slot) && source.data.kind === 'image' : ['imageUpscale', 'identityEdit', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) ? source.data.kind === 'image' && (source.data.slot === 'guide' || (['qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && source.data.slot === 'identity')) : ['swap', 'upscale'].includes(mode) ? (source.data.slot === 'guide' && source.data.kind === 'video') || (source.data.slot === 'identity' && source.data.kind === 'image') : false);
  }, []);

  const getMaskGuide = useCallback((id) => {
    const maskEdge = edgesRef.current.find((edge) => edge.source === id && edge.targetHandle === 'identity');
    const target = nodesRef.current.find((node) => node.id === maskEdge?.target);
    if (target?.type !== 'generator' || target.data.mode !== 'localRealism') return null;
    const guideEdge = edgesRef.current.find((edge) => edge.target === target.id && edge.targetHandle === 'guide');
    const guide = nodesRef.current.find((node) => node.id === guideEdge?.source);
    return guide?.type === 'media' && guide.data.kind === 'image' && guide.data.url ? guide : null;
  }, []);

  const getMentionItems = useCallback((id) => nodesRef.current.filter((node) => node.type === 'media' && node.id !== id && node.data.title), []);
  const getPromptTarget = useCallback((id) => {
    const edge = edgesRef.current.find((item) => item.source === id && item.targetHandle === 'prompt');
    const target = nodesRef.current.find((node) => node.id === edge?.target);
    return target?.type === 'generator' ? target : null;
  }, []);

  const optimizePromptNode = useCallback(async (id) => {
    if (switchingRef.current || project.readOnly) return;
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

  const completeGeneration = useCallback(async (id, promptId, completedEntry = null, attempt = 1) => {
    if (completedJobsRef.current.has(promptId) || nodesRef.current.some((node) => node.type === 'media' && node.data.sourcePromptId === promptId)) return;
    completedJobsRef.current.add(promptId);
    try {
      const history = completedEntry ? { [promptId]: completedEntry } : await getHistory(100);
      const source = nodesRef.current.find((node) => node.id === id);
      const isImage = ['image', 'imageUpscale', 'identityEdit', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(source?.data.mode);
      const files = isImage ? extractImages(history?.[promptId]) : extractVideos(history?.[promptId]);
      if (!files.length) throw new Error(`任务已结束，但没有找到${isImage ? '图片' : '视频'}输出。`);
      const standard = files.find((file) => file.filename?.startsWith('H3_CharacterSwap') && !file.filename?.startsWith('H3_CharacterSwap_'));
      const singleOutfit = source?.data.mode === 'outfitEdit' && (source?.data.outfitPanel || source?.data.panelId);
      const preferredImage = files.find((file) => source?.data.mode === 'outfitEdit' ? file.filename?.startsWith(singleOutfit ? `H3_OutfitHD_${singleOutfit}_` : 'H3_OutfitQuad_') : source?.data.mode === 'qwenEdit' ? file.filename?.startsWith('H3_Qwen21Edit_') : source?.data.mode === 'identityEdit' ? file.filename?.startsWith('H3_IdentityV2_') : source?.data.mode === 'imageUpscale' ? file.filename?.startsWith('H3_Image_HD') : source?.data.mode === 'image' && source?.data.imageModel === 'moss' ? file.filename?.startsWith('H3_MOSS_Image_') : file.filename?.startsWith('H3_Image_'));
      const result = isImage ? preferredImage || files[0] : source?.data.mode === 'swap' ? standard || files[0] : files[0];
      const outfitTitle = singleOutfit ? `${resolveOutfitPanels(source.data).find((panel) => panel.id === singleOutfit)?.label || singleOutfit} · ${result.filename?.startsWith(`H3_OutfitSingle_${singleOutfit}_`) ? '原生尺寸 · 未高清' : '独立高清'}` : `四视图 · 单图按需高清${(source?.data.outfitLayout || 'legacy') === 'legacy' ? '拼接' : '原版面合成'}`;
      const title = source?.data.mode === 'outfitEdit' ? outfitTitle : source?.data.mode === 'qwenEdit' ? 'Qwen 2.1 图生图' : source?.data.mode === 'localRealism' ? '局部写实修复' : source?.data.mode === 'identityEdit' ? '母图编辑 V2' : source?.data.mode === 'image' ? (source?.data.imageModel === 'moss' ? 'MOSS 生图' : 'Krea2 生图') : source?.data.mode === 'imageUpscale' ? '图片高清' : source?.data.mode === 'swap' ? '换人一采' : source?.data.mode === 'upscale' ? '高清二采' : '成片';
      const resultIndex = edgesRef.current.filter((edge) => edge.source === id && edge.targetHandle === 'preview').length;
      const resultPosition = findFreePosition(nodesRef.current, { x: (source?.position.x || 0) + 540, y: (source?.position.y || 0) + resultIndex * 340 }, 'media');
      const mediaNode = {
        id: uid(isImage ? 'image' : 'video'), type: 'media', position: resultPosition,
        data: { ...result, kind: isImage ? 'image' : 'video', output: true, title: `${source?.data.title || title} · 成品 ${resultIndex + 1}`, name: result.filename, prompt: source?.data.prompt, sourcePromptId: promptId },
      };
      if (source?.data.shotId) {
        await persistProject();
        const current = { ...projectRef.current, revision: revisionRef.current };
        const outputIdentity = takeOutputIdentity({ projectId: project.id, shotId: source.data.shotId, jobId: source.data.queueJobId, attempt, promptId, output: result });
        const shot = current.shots?.find((item) => item.id === source.data.shotId);
        const existing = shot?.takes?.find((take) => take.recipe?.outputIdentity === outputIdentity);
        if (!existing) {
          const takeResult = await createTake(current, source.data.shotId, {
            asset: comfyExternalAsset(result),
            recipe: { output: result, outputIdentity, promptId, jobId: source.data.queueJobId, attempt, mode: source.data.mode, seed: source.data.seed, prompt: source.data.prompt,
              ratio: source.data.ratio, resolution: source.data.resolution, duration: source.data.duration, turbo: source.data.turbo },
          });
          updateProjectDocument(takeResult.project);
        }
      }
      const pinMedia = !source?.data.shotId || source?.data.pinResultToCanvas;
      setNodes((items) => items.map((node) => node.id === id ? {
        ...node,
        data: {
          ...node.data, status: 'done', progress: 100, stage: source?.data.shotId ? '已加入 Take 栈' : '生成完成', promptId, resultUrl: result.url, error: null,
          runs: [{ promptId, status: 'done', stage: `${title}已输出`, time: new Date().toLocaleString('zh-CN') }, ...(node.data.runs || [])].slice(0, 12),
        },
      } : node).concat(pinMedia ? [mediaNode] : []));
      if (pinMedia) setEdges((items) => addEdge({ id: `edge-${id}-${mediaNode.id}`, source: id, target: mediaNode.id, sourceHandle: isImage ? 'image' : 'video', targetHandle: 'preview' }, items));
    } catch (error) {
      completedJobsRef.current.delete(promptId);
      updateNode(id, { status: 'error', error: error.message, stage: '读取结果失败' });
    }
  }, [setNodes, setEdges, updateNode, persistProject, updateProjectDocument, project.id]);

  const syncQueueJob = useCallback(async (job) => {
    if (!job || job.projectId !== project.id || !job.nodeId) return;
    const node = nodesRef.current.find((item) => item.id === job.nodeId && item.type === 'generator');
    const action = queueJobAction(node, job);
    if (action?.type === 'complete') await completeGeneration(node.id, action.promptId, action.history, action.attempt);
    else if (action?.type === 'patch') updateNode(node.id, action.patch);
  }, [completeGeneration, project.id, updateNode]);

  useEffect(() => {
    const events = openQueueEvents({
      onSnapshot(snapshot) { snapshot.jobs?.forEach((job) => { void syncQueueJob(job); }); },
      onJobEvent(job) { void syncQueueJob(job); },
      // EventSource reconnects automatically; the next snapshot restores state.
    });
    return () => events.close();
  }, [syncQueueJob]);

  useEffect(() => {
    const socket = openProgressSocket(clientId, {
      onProgress(data) {
        for (const node of nodesRef.current) if (node.data.promptId === data.prompt_id && !queueOwnsStage(node)) {
          const refinePass = String(data.node || '').match(/^refine_sample_(\d+)$/)?.[1];
          updateNode(node.id, { status: 'running', progress: data.max ? Math.round(data.value / data.max * 100) : 0, stage: `${refinePass ? `第 ${refinePass} 采精修` : '基础采样'} ${data.value}/${data.max} 步` });
        }
      },
      onExecuting(data) {
        for (const node of nodesRef.current) {
          if (node.data.promptId !== data.prompt_id) continue;
          const refinePass = String(data.node || '').match(/^refine_sample_(\d+)$/)?.[1];
          if (data.node) {
            if (!queueOwnsStage(node)) updateNode(node.id, { status: 'running', stage: refinePass ? `正在第 ${refinePass} 采精修` : data.node === 'sample' ? '正在基础采样' : data.node?.startsWith('save') ? '正在保存 MP4 对照' : data.node === '12' ? '正在生成画面与声音' : data.node === '16' ? '正在保存 MP4' : '正在准备参考素材与模型' });
          } else {
            if (queueOwnsCompletion(node)) continue;
            updateNode(node.id, { status: 'finishing', stage: '正在读取成片', progress: 100 });
            setTimeout(() => completeGeneration(node.id, data.prompt_id), 700);
          }
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

  useEffect(() => {
    let checking = false;
    const reconcileFinishedJobs = async () => {
      if (checking) return;
      const needsResult = (data) => ['queued', 'running', 'finishing'].includes(data.status) || (data.status === 'error' && data.stage === '读取结果失败');
      const pending = nodesRef.current.filter((node) => node.data.promptId && !queueOwnsCompletion(node) && needsResult(node.data));
      if (!pending.length) return;
      checking = true;
      try {
        const history = await getHistory(100);
        for (const node of pending) {
          const current = nodesRef.current.find((item) => item.id === node.id);
          if (!current || current.data.promptId !== node.data.promptId || !needsResult(current.data)) continue;
          const entry = history?.[node.data.promptId];
          if (entry?.status?.completed) await completeGeneration(node.id, node.data.promptId, entry);
          else if (entry?.status?.status_str === 'error') updateNode(node.id, { status: 'error', stage: '生成失败', error: 'ComfyUI 任务执行失败，请查看生成记录。' });
        }
      } catch { /* Keep the existing socket flow when the history endpoint is unavailable. */ }
      finally { checking = false; }
    };
    reconcileFinishedJobs();
    const interval = setInterval(reconcileFinishedJobs, 2000);
    return () => clearInterval(interval);
  }, [completeGeneration, updateNode]);

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
  const clearMemory = useCallback(async () => {
    if (memoryCleanup === 'busy') return;
    setMemoryCleanup('busy');
    try {
      await freeComfyMemory();
      await checkServer();
      setMemoryCleanup('done');
    } catch (error) {
      setMemoryCleanup('error');
      window.alert(error.message || '显存清理失败，请稍后重试。');
    } finally {
      window.setTimeout(() => setMemoryCleanup('idle'), 3000);
    }
  }, [checkServer, memoryCleanup]);
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
    if (switchingRef.current || project.readOnly) return;
    const attempt = generationAttemptsRef.current.begin(id);
    const assertCurrent = () => generationAttemptsRef.current.assert(id, attempt);
    let node = nodesRef.current.find((item) => item.id === id);
    if (!['swap', 'upscale', 'imageUpscale'].includes(node?.data.mode) && !node?.data.prompt?.trim()) { updateNode(id, { status: 'error', error: '请先输入画面描述。' }); return; }
    if (mediaWritesRef.current.size) {
      updateNode(id, { status: 'uploading', stage: '正在等待素材写入磁盘', progress: 0, error: null });
      try {
        await Promise.all([...mediaWritesRef.current.values()]);
        assertCurrent();
      } catch (error) {
        if (generationAttemptsRef.current.isCurrent(id, attempt)) updateNode(id, { status: 'error', error: error.code === 'GENERATION_CANCELLED' ? '本次生成已取消。' : '素材尚未保存成功，已保留原素材，请重试上传。', stage: '提交失败' });
        return;
      }
      node = nodesRef.current.find((item) => item.id === id);
    }
    const refs = getReferences(id);
    if (node.data.mode === 'reference' && !refs.length) { updateNode(id, { status: 'error', error: '全能参考至少需要一个素材，也可以切换到文生视频。' }); return; }
    if (node.data.mode === 'swap' && (!refs.some((ref) => ref.data.slot === 'guide') || !refs.some((ref) => ref.data.slot === 'identity'))) { updateNode(id, { status: 'error', error: '请连接源视频到上方端口、单人身份图到下方端口。' }); return; }
    if (node.data.mode === 'upscale' && !refs.some((ref) => ref.data.slot === 'guide')) { updateNode(id, { status: 'error', error: '请把已经生成的一采视频连接到高清二采节点上方端口。' }); return; }
    if (node.data.mode === 'imageUpscale' && !refs.some((ref) => ref.data.slot === 'guide')) { updateNode(id, { status: 'error', error: '请把一张图片连接到图片高清节点左侧端口。' }); return; }
    if (['identityEdit', 'qwenEdit', 'localRealism'].includes(node.data.mode) && !refs.some((ref) => ref.data.slot === 'guide')) { updateNode(id, { status: 'error', error: '请把一张人物或场景母图连接到图生图节点左侧端口。' }); return; }
    if (node.data.mode === 'outfitEdit' && !refs.some((ref) => ref.data.slot === 'guide' && ref.data.kind === 'image')) { updateNode(id, { status: 'error', error: '请把原始四视图图片连接到无抠图换装节点左侧端口。' }); return; }
    updateNode(id, { status: 'uploading', stage: '正在准备素材', progress: 0, error: null, promptId: null, queueJobId: null });
    try {
      if (node.data.mode === 'image' && node.data.imageModel === 'moss') {
        updateNode(id, { stage: '正在检查 MOSS 模型依赖' });
        const dependencies = await getMossDependencyStatus();
        assertCurrent();
        if (!dependencies.ready) throw new Error(`MOSS 还缺少：${dependencies.missing.join('、')}。请补齐配置的模型目录后再生成。`);
      }
      const upload = async (mediaNode) => {
        assertCurrent();
        if (mediaNode.data.remoteName) return mediaNode.data.remoteName;
        let file = filesRef.current[mediaNode.id];
        assertMediaCacheIdentity(mediaNode, file, fileIdentitiesRef.current[mediaNode.id]);
        if (!file && mediaNode.data.url) {
          const response = await fetch(mediaNode.data.url);
          assertCurrent();
          if (!response.ok) throw new Error(`无法读取“${mediaNode.data.title}”。`);
          file = new File([await response.blob()], mediaNode.data.name || `${mediaNode.data.title}.${mediaNode.data.kind === 'audio' ? 'wav' : mediaNode.data.kind === 'image' ? 'png' : 'mp4'}`, { type: response.headers.get('content-type') || undefined });
          assertCurrent();
          filesRef.current[mediaNode.id] = file;
          fileIdentitiesRef.current[mediaNode.id] = mediaCacheIdentity(mediaNode.data);
        }
        if (!file) throw new Error(`“${mediaNode.data.title}”需要重新上传${KIND_LABEL[mediaNode.data.kind]}。`);
        const remoteName = await uploadMedia(file, mediaNode.data.kind);
        assertCurrent();
        updateNode(mediaNode.id, { remoteName, url: remoteMediaUrl(remoteName) });
        return remoteName;
      };
      const references = [];
      for (const mediaNode of refs) {
        const name = await upload(mediaNode);
        assertCurrent();
        references.push({ kind: mediaNode.data.kind, title: mediaNode.data.title, slot: mediaNode.data.slot, name });
      }
      const seed = node.data.randomSeed ? Math.floor(Math.random() * 2147483647) : Number(node.data.seed || 42);
      const options = { ...node.data, seed, references };
      updateNode(id, { status: 'queued', stage: '任务已排队', seed });
      const plan = node.data.mode === 'outfitEdit' ? buildOutfitQueuePlan(options) : null;
      const workflow = plan ? null : node.data.mode === 'qwenEdit' ? buildQwen21EditWorkflow(options)
        : node.data.mode === 'localRealism' ? buildLocalRealismWorkflow(options)
          : node.data.mode === 'identityEdit' ? buildIdentityEditWorkflow(options)
            : node.data.mode === 'image' ? buildImageWorkflow(options)
              : node.data.mode === 'imageUpscale' ? buildImageHdWorkflow(options)
                : node.data.mode === 'swap' ? buildCharacterSwapWorkflow(options)
                  : node.data.mode === 'upscale' ? buildHdRefineWorkflow(options)
                    : node.data.mode === 'reference' ? buildReferenceWorkflow(options)
                      : buildWorkflow({ ...options, firstFrame: references.find((ref) => ref.slot === 'first')?.name, lastFrame: references.find((ref) => ref.slot === 'last')?.name });
      const job = await enqueueGeneration({ workflow, plan, projectId: project.id, nodeId: id, clientId });
      if (!generationAttemptsRef.current.isCurrent(id, attempt)) {
        // The response may arrive after cancellation/retry. The server job now
        // has a durable ID, so cancel that exact job instead of losing it.
        await cancelGeneration({ queueJobId: job.id });
        return;
      }
      updateNode(id, { status: 'queued', stage: '已加入后台队列', queueJobId: job.id, runs: [{ jobId: job.id, status: 'queued', stage: '已加入后台队列', time: new Date().toLocaleString('zh-CN') }, ...(node.data.runs || [])].slice(0, 12) });
    } catch (error) {
      if (generationAttemptsRef.current.isCurrent(id, attempt) && error.code !== 'GENERATION_CANCELLED') updateNode(id, { status: 'error', error: error.message, stage: '提交失败' });
    }
  }, [clientId, getReferences, project.id, updateNode]);

  const cancelNode = useCallback(async (id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    const cancelledAttempt = generationAttemptsRef.current.cancel(id);
    try {
      await cancelGeneration(node?.data);
      if (generationAttemptsRef.current.isCurrent(id, cancelledAttempt)) updateNode(id, { status: 'cancelled', stage: '已取消', progress: 0, queueJobId: null, promptId: null });
    } catch (error) {
      if (generationAttemptsRef.current.isCurrent(id, cancelledAttempt)) updateNode(id, { status: 'error', error: error.message });
    }
  }, [updateNode]);

  const applyHistory = useCallback((direction) => {
    if (project.readOnly || switchingRef.current || nodesRef.current.some((node) => node.dragging)) return false;
    if (hasActiveTask()) { setProjectError('任务进行中，请等待完成后再撤销或重做。'); return false; }
    const target = historyRef.current[direction]();
    if (!target) return false;
    const nextNodes = restoreHistoryNodes(target.nodes, nodesRef.current);
    const restoredMedia = reconcileMediaCache(nextNodes, filesRef.current, fileIdentitiesRef.current);
    filesRef.current = restoredMedia.files;
    fileIdentitiesRef.current = restoredMedia.identities;
    nodesRef.current = nextNodes;
    edgesRef.current = target.edges;
    setNodes(nextNodes); setEdges(target.edges);
    setAddMenu(null); setNodeMenu(null); setProjectError('');
    return true;
  }, [project.readOnly, setNodes, setEdges]);

  const copySelectedNodes = useCallback(() => {
    const clipboard = copyCanvasSelection(nodesRef.current, edgesRef.current);
    if (!clipboard.nodes.length) return null;
    const files = {};
    clipboard.nodes.forEach((node) => {
      if (filesRef.current[node.id]) files[node.id] = filesRef.current[node.id];
    });
    clipboardRef.current = { ...clipboard, files };
    setAddMenu(null); setNodeMenu(null);
    return clipboardRef.current;
  }, []);

  const pasteClipboard = useCallback((clipboard = clipboardRef.current) => {
    if (!clipboard?.nodes?.length || switchingRef.current) return false;
    const pasted = pasteCanvasSelection(clipboard, nodesRef.current, uid);
    pasted.idMap.forEach((newId, oldId) => {
      if (clipboard.files?.[oldId]) {
        filesRef.current[newId] = clipboard.files[oldId];
        fileIdentitiesRef.current[newId] = mediaCacheIdentity(pasted.nodes.find((node) => node.id === newId)?.data);
      }
    });
    const nextNodes = [...nodesRef.current.map((node) => node.selected ? { ...node, selected: false } : node), ...pasted.nodes];
    const nextEdges = [...edgesRef.current.map((edge) => edge.selected ? { ...edge, selected: false } : edge), ...pasted.edges];
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes); setEdges(nextEdges);
    setAddMenu(null); setNodeMenu(null);
    setTimeout(() => fitView({ nodes: pasted.nodes.map(({ id }) => ({ id })), duration: 250, padding: 0.3, maxZoom: 1 }), 60);
    return true;
  }, [fitView, setNodes, setEdges]);

  useEffect(() => {
    const onCanvasShortcut = (event) => {
      if (imagePreview || switchingRef.current || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      const key = event.key.toLowerCase();
      if (!['c', 'd', 'z', 'y'].includes(key)) return;
      const handled = key === 'z' ? applyHistory(event.shiftKey ? 'redo' : 'undo')
        : key === 'y' ? applyHistory('redo')
          : key === 'c' ? Boolean(copySelectedNodes()) : pasteClipboard(copySelectedNodes());
      if (handled) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('keydown', onCanvasShortcut);
    return () => window.removeEventListener('keydown', onCanvasShortcut);
  }, [applyHistory, copySelectedNodes, pasteClipboard, imagePreview]);

  const addNode = useCallback((type, extra = {}, atPosition = null, shouldFocus = true) => {
    if (switchingRef.current) throw new Error('正在保存并切换项目，请稍后再添加节点。');
    const desired = atPosition || screenToFlowPosition({ x: window.innerWidth * 0.45, y: window.innerHeight * 0.35 });
    const id = uid(type);
    let data;
    if (type === 'generator') data = { ...DEFAULT_GENERATOR, ...extra };
    else if (type === 'prompt') data = { title: 'H3 提示词优化', idea: '', optimizedPrompt: '', status: 'idle', ...extra };
    else if (type === 'note') data = { title: '创作备注', text: '', ...extra };
    else {
      const kind = extra.kind || type;
      const count = nodesRef.current.filter((node) => node.type === 'media' && node.data.kind === kind).length + 1;
      data = { kind, title: `${KIND_LABEL[kind]} ${count}`, url: '', name: '', ...extra, refTag: nextReferenceTag(nodesRef.current, kind) };
      type = 'media';
    }
    const position = findFreePosition(nodesRef.current, desired, type);
    setNodes((items) => items.concat({ id, type, position, data }));
    setAddMenu(null);
    if (shouldFocus) setTimeout(() => fitView({ nodes: [{ id }], duration: 300, maxZoom: 1, padding: 0.6 }), 60);
    return id;
  }, [screenToFlowPosition, setNodes, fitView]);

  useEffect(() => {
    const onPaste = (event) => {
      if (imagePreview || switchingRef.current) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      const images = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
      if (images.length) {
        event.preventDefault(); event.stopPropagation();
        const desired = screenToFlowPosition({ x: window.innerWidth * 0.45, y: window.innerHeight * 0.35 });
        images.forEach((file, index) => {
          const position = { x: desired.x + index * 44, y: desired.y + index * 44 };
          const title = file.name ? file.name.replace(/\.[^.]+$/, '') : `粘贴图片 ${index + 1}`;
          const id = addNode('image', { title }, position, index === images.length - 1);
          chooseMedia(id, file);
        });
        return;
      }
      if (pasteClipboard()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addNode, chooseMedia, imagePreview, pasteClipboard, screenToFlowPosition]);

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
    if (switchingRef.current || project.readOnly) return;
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
    } else if (['swap', 'upscale'].includes(mode) && ((connection.targetHandle === 'guide' && source.data.kind === 'video') || (connection.targetHandle === 'identity' && source.data.kind === 'image'))) {
      // One input video and one optional identity image; reconnecting replaces the previous input.
    } else if (['imageUpscale', 'identityEdit', 'qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && connection.targetHandle === 'guide' && source.data.kind === 'image') {
      // A single source image is replaced when reconnecting.
    } else if (['qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && connection.targetHandle === 'identity' && source.data.kind === 'image') {
      // Qwen accepts makeup/style or outfit references; local realism accepts a custom mask.
    } else return;
    setEdges((items) => addEdge({ ...connection, sourceHandle: 'ref', id: `edge-${connection.source}-${connection.target}-${connection.targetHandle}-${Date.now()}` }, items.filter((edge) => mode === 'reference' ? !(edge.source === connection.source && edge.target === connection.target && edge.targetHandle === connection.targetHandle) : !(edge.target === connection.target && edge.targetHandle === connection.targetHandle))));
  }, [setEdges]);

  useEffect(() => {
    if (!addMenu && !nodeMenu) return;
    const closeOnEscape = (event) => { if (event.key === 'Escape') { setAddMenu(null); setNodeMenu(null); } };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [addMenu, nodeMenu]);

  const resetCanvas = () => changeProject(null, '未命名项目');
  const tidyCanvas = () => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const depths = new Map(currentNodes.map((node) => [node.id, 0]));
    const indegree = new Map(currentNodes.map((node) => [node.id, 0]));
    const outgoing = new Map(currentNodes.map((node) => [node.id, []]));
    currentEdges.forEach((edge) => {
      if (!depths.has(edge.source) || !depths.has(edge.target)) return;
      outgoing.get(edge.source).push(edge.target);
      indegree.set(edge.target, indegree.get(edge.target) + 1);
    });
    const queue = currentNodes.filter((node) => !indegree.get(node.id)).map((node) => node.id);
    for (let index = 0; index < queue.length; index += 1) {
      const source = queue[index];
      outgoing.get(source).forEach((target) => {
        depths.set(target, Math.max(depths.get(target), depths.get(source) + 1));
        indegree.set(target, indegree.get(target) - 1);
        if (!indegree.get(target)) queue.push(target);
      });
    }
    const columns = new Map();
    currentNodes.forEach((node) => {
      const depth = depths.get(node.id) || 0;
      if (!columns.has(depth)) columns.set(depth, []);
      columns.get(depth).push(node);
    });
    const heightOf = (node) => node.type === 'generator' ? 360 : node.type === 'prompt' ? 390 : node.type === 'note' ? 250 : 260;
    const layouts = new Map();
    const maxHeight = Math.max(...[...columns.values()].map((items) => items.reduce((sum, node) => sum + heightOf(node) + 80, -80)));
    [...columns.entries()].sort(([a], [b]) => a - b).forEach(([depth, items]) => {
      const columnHeight = items.reduce((sum, node) => sum + heightOf(node) + 80, -80);
      let y = (maxHeight - columnHeight) / 2;
      items.forEach((node) => {
        layouts.set(node.id, { x: depth * 520, y });
        y += heightOf(node) + 80;
      });
    });
    setNodes((items) => items.map((node) => {
      const incoming = node.data.output ? currentEdges.find((edge) => edge.target === node.id && edge.targetHandle === 'preview') : null;
      const parent = incoming ? currentNodes.find((item) => item.id === incoming.source) : null;
      const resultIndex = incoming ? currentEdges.filter((edge) => edge.source === incoming.source && edge.targetHandle === 'preview').findIndex((edge) => edge.target === node.id) : -1;
      const data = parent ? { ...node.data, title: `${parent.data.title} · 成品 ${resultIndex + 1}` } : node.data;
      return { ...node, data, position: layouts.get(node.id) || node.position, selected: false };
    }));
    setEdges((items) => items.map((edge) => ({ ...edge, type: 'default', selected: false })));
    setAddMenu(null); setNodeMenu(null);
    const recentNodes = currentNodes.slice(-8).map((node) => ({ id: node.id }));
    setTimeout(() => fitView({ nodes: recentNodes, duration: 450, padding: 0.2, maxZoom: 0.75 }), 100);
  };
  const placeAddMenu = (screenPoint) => {
    const point = {
      x: Math.max(8, Math.min(screenPoint.x, window.innerWidth - 253)),
      y: Math.max(8, Math.min(screenPoint.y, window.innerHeight - 500)),
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
      const params = new URL(node.data.resultUrl, window.location.origin).searchParams;
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
  const locateContent = () => {
    const selected = nodesRef.current.filter((node) => node.selected);
    fitView({ nodes: selected.length ? selected : undefined, duration: 350, padding: selected.length ? 0.32 : 0.15, maxZoom: 1 });
  };
  // Refmuse-style progressive detail: only cross render tiers, not on every zoom frame.
  const viewTier = zoom < 24 && nodes.length >= 36 ? 'placeholder' : zoom < 58 ? 'compact' : 'full';
  const context = useMemo(() => ({ updateNode, removeNode, chooseMedia, togglePin, generateNode, cancelNode, serverOnline: server.online, getReferences, getMaskGuide, getMentionItems, getPromptTarget, optimizePromptNode, attachFilesToGenerator, importVideoReference, openImagePreview: setImagePreview, viewTier }), [updateNode, removeNode, chooseMedia, togglePin, generateNode, cancelNode, server.online, getReferences, getMaskGuide, getMentionItems, getPromptTarget, optimizePromptNode, attachFilesToGenerator, importVideoReference, viewTier, edges]);
  useCanvasMcp({
    nodesRef, edgesRef, projectName, server,
    actions: { addNode, updateNode, removeNode, onConnect, generateNode, tidyCanvas, focusNode },
  });
  const pinnedNodes = nodes.filter((node) => node.data.pinned);
  const vramPercent = metrics.vramTotal ? Math.min(100, Math.max(0, metrics.vramUsed / metrics.vramTotal * 100)) : 0;
  const cpuPercent = Number.isFinite(metrics.cpuPercent) ? Math.min(100, Math.max(0, metrics.cpuPercent)) : 0;
  return <NodeContext.Provider value={context}>
    <div className="neo-app">
      <header className="neo-header">
        {onLauncher && <button className="launcher-return" disabled={projectBusy || hasActiveTask()} onClick={async () => {
          if (switchingRef.current) return;
          switchingRef.current = true; setProjectBusy(true);
          try { await persistProject(); await closeProject(project.id); onLauncher(); }
          catch (error) { setProjectError(error.message || '保存或关闭失败，当前项目已保留。'); }
          finally { switchingRef.current = false; setProjectBusy(false); }
        }} title="返回项目启动器"><FolderOpen size={15} /><span>项目</span></button>}
        <CanvasProjectMenu current={project} projects={projects} name={projectName} onNameChange={setProjectName}
          saveState={saveState} error={projectError} busy={projectBusy || project.readOnly} locked={hasActiveTask()}
          onRefresh={refreshProjects} onOpen={(id) => changeProject(id)} onCreate={(name) => changeProject(null, name)} />
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
            <button className={creativeOpen ? 'active' : ''} onClick={() => setCreativeOpen(!creativeOpen)} title="角色、镜头与审片"><Film size={15} /><span>创作</span></button>
            <button className={`memory-cleanup ${memoryCleanup}`} disabled={!server.online || memoryCleanup === 'busy'} onClick={clearMemory} title="仅在无运行或排队任务时卸载 ComfyUI 模型并释放显存"><MemoryStick size={14} /><span>{memoryCleanup === 'busy' ? '清理中' : memoryCleanup === 'done' ? '已释放' : '清理显存'}</span></button>
            <button className={`server-status ${server.online ? 'online' : ''}`} onClick={checkServer} title={server.label}><i />{server.online ? '本地已连接' : '本地未连接'}</button>
            <button onClick={async () => { if (!switchingRef.current && !hasActiveTask()) { try { await persistProject(); onSimpleMode(); } catch { /* Keep the unsaved canvas open. */ } } }} title="切换简易模式"><MousePointer2 size={15} /></button>
            <button onClick={() => window.open('http://127.0.0.1:8188','_blank')} title="打开 ComfyUI 高级节点"><MoreHorizontal size={17} /></button>
          </div>
        </div>
      </header>
      {projectBusy && <div className="project-switching" role="status"><LoaderCircle className="spin" size={18} />正在保存并打开画布…</div>}
      {project.readOnly && <div className="project-switching readonly" role="status">此项目正在另一个窗口中编辑，当前以只读方式打开。</div>}
      <main className={`neo-canvas-wrap canvas-view-${viewTier}`} inert={projectBusy ? true : undefined}
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
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} onlyRenderVisibleElements
          nodesDraggable={!project.readOnly} nodesConnectable={!project.readOnly} edgesFocusable={!project.readOnly}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          deleteKeyCode={project.readOnly ? null : ['Backspace', 'Delete']}
          defaultViewport={saved.viewport} fitView={!saved.viewport}
          fitViewOptions={{ padding: 0.16, maxZoom: 0.85 }}
          minZoom={0.12} maxZoom={1.8} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
          panOnDrag={[1]} panOnScroll={false} selectionOnDrag selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode={['Shift']}
          snapToGrid={snapEnabled} snapGrid={[22, 22]}
          onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))}
          onMoveEnd={(_, viewport) => { viewportRef.current = viewport; persistProject().catch(() => {}); }}
          defaultEdgeOptions={{ style: { stroke: '#77777e', strokeWidth: 1.6 }, type: 'default' }}
          connectionLineType={ConnectionLineType.Bezier}
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
            <button onClick={() => applyHistory('undo')} disabled={project.readOnly || !historyState.canUndo} title="撤销 · Ctrl+Z" aria-label="撤销"><Undo2 size={15} /></button>
            <button onClick={() => applyHistory('redo')} disabled={project.readOnly || !historyState.canRedo} title="重做 · Ctrl+Shift+Z" aria-label="重做"><Redo2 size={15} /></button>
            <button className={gridVisible ? 'active' : ''} onClick={() => setGridVisible(!gridVisible)} title="显示或隐藏网格"><Grid2X2 size={15} /></button>
            <button className={miniMapVisible ? 'active' : ''} onClick={() => setMiniMapVisible(!miniMapVisible)} title="小地图"><MapIcon size={15} /></button>
            <button className={zoomMenuOpen ? 'zoom-button active' : 'zoom-button'} onClick={() => setZoomMenuOpen(!zoomMenuOpen)} title="缩放" aria-expanded={zoomMenuOpen}><Search size={13} /><span>{zoom}%</span></button>
          </div>
          {viewTier !== 'full' && <span className="canvas-performance-mode" role="status">{viewTier === 'placeholder' ? '占位浏览' : '轻量浏览'} · 放大恢复编辑</span>}
          <button className="round-control" onClick={locateContent} title="快速定位当前选择或全部内容"><Crosshair size={16} /></button>
          <button className="round-control" onClick={resetCanvas} title="新建画布"><CircleHelp size={16} /></button>
        </div>
        <div className="canvas-dock">
          <button className="dock-add" onClick={(e) => setAddMenu({ x: window.innerWidth / 2 - 110, y: Math.max(8, window.innerHeight - 550), flow: screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) })} title="添加元素"><Plus size={19} /></button>
          <button className={libraryOpen ? 'active' : ''} onClick={() => { setLibraryOpen(!libraryOpen); setPinOpen(false); }} title="本地作品"><FolderOpen size={17} /></button>
          <button onClick={() => { setLibraryOpen(true); refreshLibrary(); }} title="生成历史"><History size={17} /></button>
          <button onClick={tidyCanvas} title="整理画布 · 平滑连线"><Layers3 size={17} /></button>
          <button onClick={() => fitView({ duration: 350, padding: 0.15 })} title="适应画布"><Crosshair size={17} /></button>
          <button className={snapEnabled ? 'active' : ''} aria-pressed={snapEnabled} onClick={() => { const next = !snapEnabled; setSnapEnabled(next); localStorage.setItem(SNAP_KEY, String(next)); }} title="自动吸附"><Magnet size={16} /></button>
          <button onClick={async () => { if (!switchingRef.current && !hasActiveTask()) { try { await persistProject(); onSimpleMode(); } catch { /* Keep the unsaved canvas open. */ } } }} title="工作台设置与简易模式"><Settings2 size={17} /></button>
          <button className={pinOpen ? 'active' : ''} onClick={() => { setPinOpen(!pinOpen); setLibraryOpen(false); }} title={`Pin 节点 ${pinnedNodes.length}`}><Pin size={16} /></button>
        </div>
        {addMenu && <div className="add-node-menu" role="menu" aria-label="添加节点" style={{ left: addMenu.x, top: addMenu.y }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} onDoubleClick={(e) => e.stopPropagation()}>
          <div className="add-menu-title">添加节点 · 右键画布 <button onClick={() => setAddMenu(null)} aria-label="关闭添加节点菜单"><X size={13} /></button></div>
          <button onClick={() => addNode('generator', {}, addMenu.flow)}><i><WandSparkles size={17} /></i><span>全能参考<small>图、文、音、视频多元素生成</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'swap', title: '精准角色替换' }, addMenu.flow)}><i><Crosshair size={17} /></i><span>角色替换<small>仅运行一采，逐帧引导、SAM3.1 锁人、原音轨</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'image', title: '本地生图' }, addMenu.flow)}><i><ImageIcon size={17} /></i><span>本地生图<small>Krea2 / MOSS · 新人物与场景 · 约 1MP</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'identityEdit', title: '母图编辑 V2', ratio: '16:9', refBoost: 4, groundingPx: 1024, refPosition: 'beside (right of target)' }, addMenu.flow)}><i><WandSparkles size={17} /></i><span>母图编辑 V2<small>保持身份 · 换装换姿态 · 四视图 · 8 步</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'qwenEdit', title: 'Qwen 2.1 图生图', randomSeed: true, qwenSteps: 40, qwenRefResolution: 1024 }, addMenu.flow)}><i><WandSparkles size={17} /></i><span>Qwen 2.1 图生图<small>原生整图编辑 · 原图比例 · 40 步 · 研究许可</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'localRealism', title: '局部写实修复', prompt: '只增强选中皮肤的自然纹理、细小毛孔和真实光影；保持人物身份、五官、妆容、表情及其他区域不变。', localRealismSteps: 25, localRealismSize: 768, localMaskExpand: 0, localMaskBlend: 16, randomSeed: false, seed: 78001 }, addMenu.flow)}><i><Sparkles size={17} /></i><span>局部写实修复<small>只改皮肤 · 保护五官 · 原图回贴</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'outfitEdit', title: '无抠图换装', prompt: OUTFIT_PRESETS.blackSatin.prompt, outfitPreset: 'blackSatin', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, qwenRefResolution: 1536 }, addMenu.flow)}><i><ImageIcon size={17} /></i><span>无抠图换装<small>多版面四视图 · 低于 1K 才高清 · 原版面合成</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'imageUpscale', title: '图片高清', imageScale: 1.5, randomSeed: false }, addMenu.flow)}><i><Maximize2 size={17} /></i><span>图片高清<small>SeedVR2 3B · 独立运行 · 默认 1.5 倍</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'upscale', title: '视频高清二采', resolution: '720P', randomSeed: false }, addMenu.flow)}><i><Sparkles size={17} /></i><span>视频高清二采<small>独立运行 · 3D Latent 放大 · 4 步 Turbo</small></span><Plus size={13} /></button>
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
      {creativeOpen && <CreativePanel project={project} onProjectChange={updateProjectDocument} onClose={() => setCreativeOpen(false)}
        beforeWrite={async () => { await persistProject(); projectRef.current = { ...projectRef.current, revision: revisionRef.current }; return projectRef.current; }}
        onPromote={promoteToShot} onLocateShot={(shot) => { if (shot.canvasNodeId) { focusNode(shot.canvasNodeId); setCreativeOpen(false); } }} />}
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
      {imagePreview && <ImageLightbox preview={imagePreview} onClose={() => setImagePreview(null)} closeRef={previewCloseRef} />}
    </div>
  </NodeContext.Provider>;
}

export default function CanvasWorkbench({ initialProject = null, ...props }) {
  const [project, setProject] = useState(initialProject);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    initializeProjects(initialCanvas).then(setProject).catch((reason) => setError(reason.message || '项目存储无法打开。'));
  }, []);
  useEffect(() => { if (!initialProject) load(); }, [initialProject, load]);
  if (!project) return <div className="neo-app project-loading"><FolderOpen size={26} /><strong>{error ? '项目暂时无法打开' : '正在打开本地项目'}</strong><p role={error ? 'alert' : 'status'}>{error || '正在读取已保存的画布…'}</p>{error && <button onClick={load}>重试</button>}</div>;
  return <ReactFlowProvider key={project.id}><CanvasInner {...props} project={project} onProjectChange={setProject} /></ReactFlowProvider>;
}
