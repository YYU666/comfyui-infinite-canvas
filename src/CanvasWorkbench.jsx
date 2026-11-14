import VideoSuperResolutionNode from './VideoSuperResolutionNode.jsx';
import { buildVideoSuperResolutionWorkflow, getVideoSuperResolutionDependencyStatus } from './video-super-resolution.js';
import { isH3Image, resolveH3ImageDimensions, getH3ImageDependencyStatus } from './h3-image.js';
import {DEFAULT_GENERATOR, initialCanvas, migrateCanvas} from './canvas-migration.js';
import {createProjectAccessRecovery, retryCurrentProjectSave} from './project-save-recovery.js';
import {moveSpecifiedNodes} from './canvas-move.js';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, NodeToolbar,
  Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, ConnectionLineType, SelectionMode, addEdge, useNodesState, useEdgesState, useReactFlow, useUpdateNodeInternals, useStoreApi,
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
  buildImageWorkflow, buildImageHdWorkflow, buildIdentityEditWorkflow, buildQwen21EditWorkflow, buildCharacterSheetQueuePlan, buildLocalRealismWorkflow, buildOutfitQueuePlan, resolveOutfitPanels, OUTFIT_PRESETS, cancelGeneration, createClientId, enqueueGeneration, extractImages, extractVideos,
  comfyFetch, freeComfyMemory, getHistory, getMossDependencyStatus, importVideoFromUrl, openProgressSocket, openQueueEvents,
  openFileLocation as requestFileLocation, optimizePrompt as requestPromptOptimization,
  resolveDimensions, resolveImageDimensions, uploadMedia,
} from './workbench-api';
import { findFreePosition } from './canvas-layout';
import { copyCanvasSelection, pasteCanvasSelection } from './canvas-clipboard';
import './canvas.css';
import PromptEditor from './PromptEditor';
import QwenReferenceEditor from './QwenReferenceEditor';
import { qwenCanvasReferences, bindQwenPrompt, validateQwenReferences, compileQwenPrompt } from './qwen-references';
import MaskEditor from './MaskEditor';
import { isMaskNode, maskSourceKey, canvasMaskGuide, qwenCanvasMask, validateCanvasMask } from './canvas-mask';
import { planCanvasConnection } from './canvas-connections';
import ImageLightbox from './ImageLightbox';
import { useCanvasMcp, NODE_PRESETS, describeNodeModels } from './canvas-mcp';
import { LOCAL_NODE_TOOLS } from './local-node-tools';
import WorkflowInspector from './WorkflowInspector';
import ReferenceLibrary, { REFERENCE_LIBRARIES } from './ReferenceLibrary';
import NodeLibrary from './NodeLibrary';
import WorkflowLibrary from './WorkflowLibrary';
import WorkflowDependencies from './WorkflowDependencies';
import WorkflowShare from './WorkflowShare';
import { shareSource, suggestShareMetadata, resolvedLegacyShareError } from './workflow-sharing';
import { customInput, declaredHistory, extensionMedia, extensionNodeData, getExtension, prepareExtension, importCatalogExtension, extensionDependencies } from './workflow-extensions';
import { flushSync } from 'react-dom';
import { inspectionQuery, canInspectNode } from './workflow-inspector';
import CanvasProjectMenu from './CanvasProjectMenu';
import CreativePanel from './CreativePanel';
import HandoffDialog from './HandoffDialog';
import { initializeProjects, listProjects, createProject, openProject, closeProject, saveProject, projectSummary, saveProjectFile, readProjectFile, createDomainEntity, createTake, updateProjectHandoff, restoreProjectAccess } from './project-store-http';
import { AutoSaveController, persistentCanvas } from './auto-save';
import { readViewport, saveViewport } from './canvas-viewport';
import { outputFileLocation, selectCompletedVideo } from './canvas-output-selection';
import { CanvasHistory, restoreHistoryNodes } from './canvas-history';
import { comfyExternalAsset, queueJobAction, queueOwnsCompletion, queueOwnsStage, resolveCanvasCompletion, shouldReconcileCompletion, takeOutputIdentity } from './generation-queue';
import { absentPromptPatches, absentQueueJobPatches, canvasHasActiveTask, classifyExportJob, comfyQueuePromptIds, exportJobRequest, exportLookupPatch, isActiveTaskStatus, patchNodes, promptEventTargets, promptExecutingPatch, promptProgressPatch } from './canvas-task-state';
import { ensureReferenceTags, nextReferenceTag, referenceDescriptors } from './reference-tags';
import CanvasImage, { clearCanvasThumbnails } from './CanvasImage';
import { hydrateProjectMedia } from './canvas-thumbnails';
import { assertMediaCacheIdentity, mediaCacheIdentity, reconcileMediaCache } from './canvas-media-cache';
import { GenerationAttempts } from './generation-attempts';
import { getFlux3KleinDependencyStatus } from './flux3-klein.js';
import { flushProjectAfterMedia } from './project-save-barrier';
import ImageProcessNode from './ImageProcessNode';
import ArtDirectorNode from './ArtDirectorNode.jsx';
import { useArtDirector } from './art-director-canvas.js';
import PureRefImport from './PureRefImport.jsx';
import { copyPureRefResource, pureRefImageNodes } from './pureref-import.js';
import { DEFAULT_ADJUSTMENTS } from './image-compositing';
import { isImageProcess, imageProcessPorts, imageProcessSnapshot } from './image-process-graph';
import { renderImageProcess } from './image-process-runtime';
import { assetUrl } from './project-store-http';
import { useLocalConnection } from './use-local-connection';
import { localConnectionPresentation } from './local-connection';
import { downloadDoctorLogs } from './doctor-client';

const SNAP_KEY = 'h3-canvas-snap-v1';
const NodeContext = createContext(null);
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };

const KIND_ICON = { image: ImageIcon, video: Video, audio: Music2 };

const formatGb = (bytes) => Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(1) : '--';

function canvasSnapshot(nodes, edges, viewport) {
  return persistentCanvas({ nodes, edges, viewport });
}

function remoteMediaUrl(path) {
  const parts = (path || '').split('/');
  const filename = parts.pop();
  return `${COMFY_ORIGIN}/view?${new URLSearchParams({ filename, subfolder: parts.join('/'), type: 'input' })}`;
}

function CanvasEdge(props) {
  const { disconnectEdge, readOnly } = useContext(NodeContext);
  const { screenToFlowPosition } = useReactFlow();
  const [hoverPoint, setHoverPoint] = useState(null);
  const leaveTimer = useRef(null);
  const [path, labelX, labelY] = getBezierPath(props);
  const keepVisible = () => clearTimeout(leaveTimer.current);
  const leave = () => { keepVisible(); leaveTimer.current = setTimeout(() => setHoverPoint(null), 220); };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const point = hoverPoint || { x: labelX, y: labelY };
  return <>
    <g onMouseEnter={(event) => { keepVisible(); setHoverPoint(screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false })); }} onMouseLeave={leave}>
      <BaseEdge id={props.id} path={path} style={props.style} markerStart={props.markerStart} markerEnd={props.markerEnd} interactionWidth={26} />
    </g>
    {!readOnly && (hoverPoint || props.selected) && <EdgeLabelRenderer>
      <button className="canvas-edge-disconnect nodrag nopan" data-edge-id={props.id}
        style={{ transform: `translate(-50%, -100%) translate(${point.x}px, ${point.y - 12}px)` }}
        aria-label="断开连线" title="断开连线 · Alt + 单击连线"
        onMouseEnter={keepVisible} onMouseLeave={leave}
        onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); disconnectEdge(props.id); }}>
        <X size={12} /><span>断开</span>
      </button>
    </EdgeLabelRenderer>}
  </>;
}
const edgeTypes = { default: CanvasEdge };

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
  const isVideoDownload = data.noteRole === 'videoDownload';
  const videoInputId = isGuide ? 'video-url-input' : `video-url-${id}`;
  const submitUrl = async (event) => {
    event.preventDefault();
    if (!url.trim() || importing) return;
    setImporting(true); setError('');
    try { await importVideoReference(url.trim(), isVideoDownload ? id : null); setUrl(''); }
    catch (reason) { setError(reason.message || '视频加载失败，请重试。'); }
    finally { setImporting(false); }
  };
  return <div className={`note-shell ${isGuide ? 'guide-note' : ''} ${selected ? 'selected' : ''}`}>
    <NodeTitle id={id} data={data} kind="note" /><NodeActions id={id} data={data} selected={selected} />
    {!isVideoDownload && <textarea className="nodrag nowheel" value={data.text || ''} onChange={(e) => updateNode(id, { text: e.target.value })} placeholder="写下分镜、角色设定或创作备注……" />}
    {(isGuide || isVideoDownload) && <form className="video-url-import nodrag nowheel" onSubmit={submitUrl} onDoubleClick={(event) => event.stopPropagation()}>
      <label htmlFor={videoInputId}><Link2 size={13} />{isVideoDownload ? '视频链接下载' : '手机分享链接加载参考'}</label>
      <div className="video-url-row">
        <input id={videoInputId} type="text" inputMode="url" autoComplete="off" spellCheck={false} value={url} disabled={importing} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴抖音 / 小红书分享文字或链接" required />
        <button type="submit" disabled={importing || !url.trim()} title={isVideoDownload ? '下载并添加到画布' : '提取链接并连接为视频参考'} aria-label="加载视频链接">{importing ? <LoaderCircle className="spin" size={14} /> : <ArrowDownToLine size={14} />}</button>
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
  const { chooseMedia, openImagePreview, viewTier, getMaskGuide, readOnly, createArtDirector } = useContext(NodeContext);
  const input = useRef(null);
  const videoRef = useRef(null);
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
  const kind = data.kind || 'image';
  const Icon = KIND_ICON[kind];
  const showResolution = kind === 'image' && data.output;
  const { width, height } = data.metadata || {};
  const resolutionLabel = Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 ? `${width} × ${height}` : '分辨率未知';
  const accept = kind === 'image' ? 'image/png,image/jpeg,image/webp' : kind === 'video' ? 'video/*' : 'audio/*';
  const lightweightVideo = kind === 'video' && viewTier !== 'full';
  const maskGuide = kind === 'image' ? getMaskGuide(id) : null;
  const [mediaError, setMediaError] = useState('');
  const maskNode = data.mediaRole === 'mask';
  const openMaskEditor = () => { if (maskGuide && !readOnly) setMaskEditorOpen(true); };
  const chooseFile = async (file) => {
    setMediaError('');
    if (maskNode && !maskGuide) throw new Error('请先连接遮罩底图。');
    const result = await chooseMedia(id, file, null, maskNode ? { maskSourceId: maskGuide.id, maskSourceKey: maskSourceKey(maskGuide) } : {});
    if (!result?.ok) throw new Error(result?.error?.message || '素材保存失败，请重试。');
  };
  return <div className={`media-shell media-${kind} ${kind === 'image' ? 'image-node' : ''} ${selected ? 'selected' : ''} ${data.pinned ? 'pinned' : ''}`}>
    <NodeTitle id={id} data={data} kind="media" /><NodeActions id={id} data={data} selected={selected} />
    <div className={`media-preview ${!data.url ? 'empty' : ''}`} title={maskGuide ? '单击在母图上绘制遮罩' : kind === 'image' && data.url ? '双击预览大图' : undefined} onDoubleClick={(event) => {
      event.stopPropagation();
      if (maskNode || maskGuide) openMaskEditor();
      else if (kind === 'image' && data.url) openImagePreview({ url: data.url, title: data.title, name: data.name });
      else input.current?.click();
    }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const file = [...(e.dataTransfer.files || [])].find((item) => item.type.startsWith(`${kind}/`)); if (file && (!maskNode || maskGuide)) void chooseFile(file).catch((error) => setMediaError(error.message)); }}>
      {data.url ? <>
        {kind === 'image' && <CanvasImage source={data.url} alt={data.title} />}
        {kind === 'video' && (lightweightVideo ? <div className="media-video-compact"><Film size={24} /><span>视频预览 · 放大恢复播放</span></div> : <video ref={videoRef} className="nodrag" src={data.url} controls preload="metadata" playsInline />)}
        {kind === 'audio' && <div className="audio-content"><span><AudioLines size={25} /></span><strong>{data.title}</strong>{viewTier === 'full' && <audio className="nodrag" src={data.url} controls preload="metadata" />}</div>}
        {['image', 'video'].includes(kind) && <MediaDragSurface videoRef={videoRef} video={kind === 'video' && !lightweightVideo} onActivate={maskGuide ? openMaskEditor : undefined} />}
      </> : <div className="media-empty"><Icon size={26} /><strong>{maskNode || maskGuide ? '局部遮罩修改' : `添加${KIND_LABEL[kind]}素材`}</strong><span>{maskGuide ? '单击绘制 · 白色修改 / 黑色保留' : maskNode ? '连接底图后绘制遮罩' : '单击添加 · 按住拖动节点'}</span><MediaDragSurface onActivate={maskNode || maskGuide ? openMaskEditor : () => input.current?.click()} /></div>}
      {maskGuide && <button className="media-mask-edit nodrag" onClick={openMaskEditor}>绘制遮罩</button>}
      <button className="media-replace nodrag" disabled={readOnly || (maskNode && !maskGuide)} onClick={() => input.current?.click()} title={maskGuide ? '从文件导入黑白遮罩' : '替换素材'}><RefreshCw size={12} /><span>{maskGuide ? '导入' : '替换'}</span></button>
      {data.output && <a className="media-download nodrag" href={data.url} target="_blank" rel="noreferrer" title="打开并下载"><ArrowDownToLine size={13} /></a>}
    </div>
    <div className="media-caption"><span>{data.artDirectorStale ? `旧版解析 · ${data.artDirectorStaleReason || '待重新输出'}` : maskNode || maskGuide ? '局部遮罩' : data.output ? '生成结果' : KIND_LABEL[kind]}</span><b title={showResolution ? '原始图片分辨率（像素）' : data.name}>{showResolution ? resolutionLabel : data.name || (data.url ? data.title : maskGuide ? '尚未绘制' : '未上传')}</b></div>
    {kind === 'image' && data.url && !maskNode && <button className="nodrag art-image-shortcut" disabled={readOnly} onClick={() => createArtDirector(id)}>电子主美 · 图解分析</button>}
    {mediaError && <div className="generator-error">{mediaError}</div>}
    <input ref={input} hidden type="file" accept={accept} onChange={(e) => { if (e.target.files?.[0]) void chooseFile(e.target.files[0]).catch((error) => setMediaError(error.message)); e.target.value = ''; }} />
    {data.output && <Handle type="target" position={Position.Left} id="preview" className="neo-handle target" />}
    {maskNode && <Handle type="target" position={Position.Left} id="guide" className="neo-handle target" title="底图 · 与图生图的图1相同" />}

    <Handle type="source" position={Position.Right} id={maskNode ? "mask" : "ref"} className="neo-handle source" title={maskNode ? "连接图生图的遮罩输入" : "连接图片参考"} />
    {maskEditorOpen && maskGuide && <MaskEditor guideUrl={maskGuide.data.url} guideTitle={maskGuide.data.title} maskUrl={data.url} onSave={async (file) => { await chooseFile(file); setMaskEditorOpen(false); }} onClose={() => setMaskEditorOpen(false)} />}
  </div>;
}

function CustomWorkflowNode({ id, data, selected }) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, data.workflowDefinition, data.resultUrl, updateNodeInternals]);
  const { updateNode, generateNode, cancelNode, serverOnline, getReferences, openNodeShare, checkNodeDependencies } = useContext(NodeContext);
  const running = ['uploading', 'queued', 'running', 'finishing'].includes(data.status);
  const refs = getReferences(id);
  return <div className={`generator-shell h3-node custom-workflow-node ${selected ? 'selected' : ''}`}>
    <NodeTitle id={id} data={data} kind="generator" /><NodeActions id={id} data={data} selected={selected} generator />
    <div className="custom-workflow-identity" title={data.extensionDigest}>{data.extensionPackageId} · {data.extensionVersion} · {data.extensionDigest?.slice(0, 12)}</div>
    {data.resultUrl && <div className="generator-preview">{data.workflowDefinition?.outputs?.[0]?.type === 'video' ? <video className="nodrag" src={data.resultUrl} controls /> : <CanvasImage source={data.resultUrl} alt={data.title} />}</div>}
    {(data.workflowDefinition?.inputs || []).map((port) => <div className="custom-workflow-port" key={port.id}><Handle type="target" position={Position.Left} id={port.id} className="neo-handle target" /><strong>{port.label || port.name || port.id}</strong> · {port.required ? '必填图片' : '可选图片'}<span> · {refs.find((ref) => ref.data.slot === port.id)?.data.title || '未连接'}</span></div>)}
    <div className="custom-workflow-params nodrag nowheel">{Object.entries(data.workflowDefinition?.parameters?.properties || {}).map(([key, field]) => {
      const value = data.workflowParameters?.[key] ?? field.default ?? (field.type === 'boolean' ? false : '');
      const change = (next) => updateNode(id, { workflowParameters: { ...data.workflowParameters, [key]: next }, error: null });
      return <label key={key} title={field.description}>{field.title || key}{field.enum ? <select aria-label={field.title || key} disabled={running} value={String(value)} onChange={(event) => change(field.enum.find((option) => String(option) === event.target.value))}>{field.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : field.type === 'boolean' ? <input aria-label={field.title || key} type="checkbox" checked={Boolean(value)} disabled={running} onChange={(event) => change(event.target.checked)} /> : <input aria-label={field.title || key} type={['integer', 'number'].includes(field.type) ? 'number' : 'text'} value={value} min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : 'any'} disabled={running} onChange={(event) => change(['integer', 'number'].includes(field.type) && event.target.value !== '' ? Number(event.target.value) : event.target.value)} />}</label>;
    })}</div>
    {data.error && <p className="custom-workflow-error" role="alert">{data.error}</p>}
    {data.shareError && <p className="custom-workflow-error" role="alert">节点上传：{data.shareError}</p>}
    {data.dependencyWarning && <p className="custom-workflow-error">{data.dependencyWarning}</p>}
    <div className="custom-workflow-footer"><span>{data.stage || '固定版本 · 本地工作流'}{running ? ` ${data.progress || 0}%` : ''}</span><button className="node-share-button nodrag" disabled={running} onClick={() => checkNodeDependencies(id)}>检查依赖</button><button className="node-share-button nodrag" disabled={running} aria-label="上传此节点" title="上传此节点到节点库" onClick={() => openNodeShare(id)}><Upload size={14} /></button><button className="send-button nodrag" aria-label={running ? '取消工作流' : '运行工作流'} disabled={!running && !serverOnline} onClick={() => running ? cancelNode(id) : generateNode(id)}>{running ? <Square size={16} /> : <ArrowUp size={16} />}</button></div>
    <Handle type="source" position={Position.Right} id="image" className="neo-handle source" /><Handle type="source" position={Position.Right} id="video" style={{ top: '65%' }} className="neo-handle source" />
  </div>;
}

function GeneratorNode(props) {
  const actions = useContext(NodeContext);
  if (props.data.mode === 'videoSuperResolution') return <VideoSuperResolutionNode {...props} actions={actions} title={<NodeTitle id={props.id} data={props.data} kind="generator" />} nodeActions={<NodeActions id={props.id} data={props.data} selected={props.selected} generator />} />;
  return props.data.mode === 'customWorkflow' ? <CustomWorkflowNode {...props} /> : <BuiltinGeneratorNode {...props} />;
}

function BuiltinGeneratorNode({ id, data, selected }) {
  const {
    updateNode, generateNode, cancelNode, serverOnline, getReferences,
    getMentionItems, attachFilesToGenerator, openImagePreview, viewTier, openNodeShare, changeQwenReferences, addQwenMask, getQwenMask, readOnly,
  } = useContext(NodeContext);
  const promptEditorRef = useRef(null);
  const uploadRef = useRef(null);
  const resultVideoRef = useRef(null);
  const running = ['uploading', 'queued', 'running', 'finishing'].includes(data.status);
  const mode = data.mode || 'reference';
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, mode, viewTier, updateNodeInternals]);
  const isMoss = mode === 'image' && data.imageModel === 'moss';
  const isFlux3 = (mode === 'image' && data.imageModel === 'flux3_klein') || (mode === 'qwenEdit' && data.qwenModel === 'flux3_klein');
  const h3Image = isH3Image(data);
  const imageSteps = h3Image ? 6 : isFlux3 ? 16 : isMoss ? 25 : 8;
  const imageModelLabel = h3Image ? 'MiniMax H3 Image INT8' : isFlux3 ? 'FLUX 3 Image Klein INT8' : isMoss ? 'MOSS SFT' : 'Muse V3.0 Turbo';
  const models = describeNodeModels(data);
  const imageFamily = ['image', 'imageUpscale', 'identityEdit', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode);
  const refs = getReferences(id);
  const mask = mode === 'qwenEdit' ? getQwenMask(id) : null;
  const descriptors = referenceDescriptors(refs);
  const guide = refs.find((node) => node.data.slot === 'guide');
  const identity = refs.find((node) => node.data.slot === 'identity');
  const mentionItems = getMentionItems(id);
  const resolution = data.resolution || '480P';
  const [outputWidth, outputHeight] = ['outfitEdit', 'qwenEdit', 'characterSheet', 'localRealism'].includes(mode) ? [0, 0] : ['image', 'identityEdit'].includes(mode) ? h3Image ? resolveH3ImageDimensions(data.ratio, data.h3ImageResolution) : resolveImageDimensions(data.ratio, isFlux3 ? data.flux3Resolution || '1MP' : undefined) : resolveDimensions(data.ratio, resolution);
  const switchMode = (nextMode) => updateNode(id, { mode: nextMode, error: null });
  const placeholder = mode === 'characterSheet' ? '连接一张角色参考，依次生成四张，再拼成整图' : mode === 'localRealism' ? '连接正面人像，只修复皮肤，不重绘五官' : mode === 'outfitEdit' ? '连接母图与穿搭，按原版面分别换装后合成' : mode === 'qwenEdit' ? '连接参考图片，用图1、图2描述修改目标' : mode === 'identityEdit' ? '连接母图，保持身份并修改姿态、穿搭或场景' : mode === 'image' ? '本地生成人物、场景和分镜参考图' : mode === 'imageUpscale' ? '图片独立高清 · 连接图片后按需运行' : mode === 'swap' ? '源视频换人 · 保留动作、镜头与原音轨' : mode === 'upscale' ? '独立高清二采 · 需要时才运行' : mode === 'reference' ? '用图、文、音、视频共同定义新镜头' : mode === 'frames' ? '首尾帧生成视频' : '输入提示词生成视频';
  const modelLabel = mode === 'characterSheet' ? `Qwen 2.1 标准版 · 四张原生 9:16 · ${data.qwenSteps || 40} 步 · 无高清` : mode === 'localRealism' ? `Qwen 2.1 · 皮肤区域重绘 · 原图回贴 · ${data.localRealismSteps || 25} 步` : mode === 'outfitEdit' ? `${models.outfitModelLabel} · ${models.outfitSteps} 步 · ${models.outfitHdLabel}` : mode === 'qwenEdit' ? `${models.qwenModelLabel} · 原图比例 · ${models.qwenSteps} 步` : mode === 'identityEdit' ? 'Identity Edit V2 · 参考强度 4 · 8 步' : mode === 'image' ? `${imageModelLabel} · ${h3Image ? data.h3ImageResolution || '4MP' : isFlux3 ? data.flux3Resolution || '1MP' : '约 1MP'} · ${imageSteps} 步` : mode === 'imageUpscale' ? `${models.upscaleModelLabel} · 保真色彩` : mode === 'swap' ? 'Character Swap v1.5 · 潜空间遮罩 · SAM3.1' : mode === 'upscale' ? 'H3 3D Latent 放大 · 4 步 Turbo · 原音轨' : 'MiniMax H3 · 本地生成 · 24 FPS';
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
    <div className="generator-subline"><span>{mode === 'characterSheet' ? `单格 1152 × 2048 · 整图 2304 × 4096 · ${data.qwenSteps || 40} 步` : mode === 'localRealism' ? `原图尺寸 · 局部 ${data.localRealismSize || 768} · 保护未选区域` : mode === 'outfitEdit' ? `${data.outfitPanel ? '单视图' : '四张单图'} · ${models.outfitHdLabel} · ${(data.outfitLayout || 'legacy') === 'legacy' ? '旧版拼接' : '原版面合成'}` : mode === 'qwenEdit' ? h3Image ? `保持图1比例 · ${data.h3ImageResolution || '4MP'} · 6 步` : isFlux3 ? `保持图1比例 · ${data.flux3Resolution || '1MP'} · 16 步` : `继承原图比例 · 参考精度 ${data.qwenRefResolution || 1024} · ${models.qwenSteps} 步` : ['image', 'identityEdit'].includes(mode) ? `${data.ratio} · ${outputWidth} × ${outputHeight} · ${imageSteps} 步` : mode === 'imageUpscale' ? `${data.imageScale || 1.5} 倍 · 独立图片高清` : `${data.ratio} · ${resolution}${mode === 'upscale' ? ' · 独立二采' : ` · ${data.duration} 秒`}`}</span><b>{data.status === 'done' ? '已完成' : mode === 'characterSheet' ? 'Qwen 2.1 · 无高清' : mode === 'outfitEdit' ? models.outfitModelLabel : mode === 'qwenEdit' ? models.qwenModelLabel : mode === 'identityEdit' ? 'Identity V2' : mode === 'image' ? `${imageModelLabel} 生图` : mode === 'imageUpscale' ? 'SeedVR2 高清' : mode === 'swap' ? 'H3 换人 v1.5' : mode === 'upscale' ? 'H3 高清二采' : 'H3 INT8'}</b></div>
    {mode === 'qwenEdit' && !h3Image && <div className="qwen-mask-row nodrag">
      <span title="白色区域修改，黑色区域保留；遮罩不占参考图编号">局部遮罩：{mask ? (mask.data.url ? '已连接' : '待绘制') : '未连接'}</span>
      {mask && <label className="qwen-mask-crop" title="裁切遮罩附近区域并放大重绘，最后回贴原图；图1在采样时对应局部画面"><input type="checkbox" aria-label="局部放大重绘" checked={Boolean(data.qwenMaskCrop)} disabled={readOnly || running} onChange={(event) => updateNode(id, { qwenMaskCrop: event.target.checked })} />局部放大重绘</label>}
      <button disabled={isFlux3 || readOnly || running || !refs[0]?.data.url} title={isFlux3 ? '局部遮罩请使用 Qwen 模型' : undefined} onClick={() => addQwenMask(id)}>{mask ? '定位遮罩' : '+ 添加遮罩'}</button>
    </div>}
    {data.error && <div className="generator-error">{data.error}</div>}
    {data.shareError && <div className="generator-error" role="alert">节点上传：{data.shareError}</div>}
    {mode === 'qwenEdit' ? <>
      <Handle type="target" position={Position.Left} id="references" className="neo-handle target frame-first" title="参考图片 · 图1为底图 · 最多10张" />
      {!h3Image && <Handle type="target" position={Position.Left} id="mask" className="neo-handle target frame-last" title="局部遮罩 · 连接局部遮罩修改节点" />}
    </> : mode === 'reference' ? <Handle type="target" position={Position.Left} id="references" className="neo-handle target" /> : mode === 'frames' ? <>
      <Handle type="target" position={Position.Left} id="first" className="neo-handle target frame-first" />
      <Handle type="target" position={Position.Left} id="last" className="neo-handle target frame-last" />
    </> : ['swap', 'upscale'].includes(mode) ? <>
      <Handle type="target" position={Position.Left} id="guide" className="neo-handle target frame-first" title={mode === 'upscale' ? '连接一采视频' : '连接源视频'} />
      <Handle type="target" position={Position.Left} id="identity" className="neo-handle target frame-last" title={mode === 'upscale' ? '可选身份图' : '连接单人身份图'} />
    </> : ['outfitEdit', 'localRealism'].includes(mode) ? <>
      <Handle type="target" position={Position.Left} id="guide" className="neo-handle target frame-first" title={mode === 'outfitEdit' ? '连接原始四视图' : '连接人物或场景母图'} />
      <Handle type="target" position={Position.Left} id="identity" className="neo-handle target frame-last" title={mode === 'localRealism' ? '可选：连接自定义局部遮罩图' : mode === 'outfitEdit' ? '可选：连接穿搭参考图' : '可选：连接妆容或风格参考图'} />
    </> : ['imageUpscale', 'identityEdit', 'characterSheet', 'outfitEdit'].includes(mode) ? <Handle type="target" position={Position.Left} id="guide" className="neo-handle target" title={mode === 'characterSheet' ? '连接一张单人角色参考图' : mode === 'outfitEdit' ? '连接原始四视图' : mode === 'identityEdit' ? '连接人物或场景母图' : '连接要高清的图片'} /> : null}
    {!imageFamily && <Handle type="target" position={Position.Left} id="prompt" className="neo-handle target prompt-target" title="连接 H3 提示词优化" />}
    <Handle type="source" position={Position.Right} id={imageFamily ? 'image' : 'video'} className="neo-handle source" title={data.resultUrl ? '连接当前已生成的成品；已有连线不会随重新生成更换素材' : '生成后可从这里连接当前成品'} />

    <NodeToolbar isVisible={selected} position={Position.Bottom} offset={12} className="creator-toolbar nodrag">
      <div className="creator-modes">
        {imageFamily ? <button className="active">{mode === 'characterSheet' ? '角色四视图生成' : mode === 'outfitEdit' ? '无抠图换装' : mode === 'qwenEdit' ? '图生图' : mode === 'identityEdit' ? '母图编辑 V2' : mode === 'image' ? '文生图' : '图片高清'}</button> : (mode === 'swap' ? [['swap', '角色替换']] : mode === 'upscale' ? [['upscale', '视频高清二采']] : [['reference', '全能参考'], ['frames', '首尾帧'], ...(mode === 'text' ? [['text', '文生视频']] : [])]).map(([value, label]) => <button key={value} className={mode === value ? 'active' : ''} disabled={running} onClick={() => switchMode(value)}>{label}</button>)}
        <span className="local-model"><i />{mode === 'characterSheet' ? 'Qwen 2.1 标准版 · 无高清' : mode === 'outfitEdit' ? `${models.outfitModelLabel} · ${models.outfitHdLabel}` : mode === 'qwenEdit' ? models.qwenModelLabel : mode === 'identityEdit' ? 'Identity Edit V2' : mode === 'image' ? (h3Image ? 'H3-Image · 6 步' : isFlux3 ? 'FLUX 3 Klein · 16 步' : isMoss ? 'MOSS · Spectrum 加速' : 'Krea2 Turbo') : mode === 'imageUpscale' ? models.upscaleModelLabel : mode === 'upscale' ? '高清二采' : 'MiniMax H3'}</span>
      </div>
      {['swap', 'upscale'].includes(mode) && <div className="reference-strip swap-strip">
        <span className={guide ? 'connected' : ''}><Video size={13} />{mode === 'upscale' ? '一采视频' : '源视频'}：{guide?.data.title || '连接左侧上方端口'}</span>
        <span className={identity ? 'connected' : ''}><ImageIcon size={13} />身份图：{identity?.data.title || (mode === 'upscale' ? '可选，连接左侧下方端口' : '连接左侧下方端口')}</span>
      </div>}
      {['imageUpscale', 'identityEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode) && <div className="reference-strip swap-strip"><span className={guide ? 'connected' : ''}><ImageIcon size={13} />{mode === 'characterSheet' ? '单人角色参考' : mode === 'outfitEdit' ? '原始四视图' : mode === 'identityEdit' ? '人物母图' : '输入图片'}：{guide?.data.title || '从图片节点右侧连线到本节点左侧'}</span>{['qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && <span className={identity ? 'connected' : ''}><ImageIcon size={13} />{mode === 'localRealism' ? '自定义遮罩' : mode === 'outfitEdit' ? '穿搭参考' : '妆容 / 风格'}：{identity?.data.title || '可选，连接左侧下方端口'}</span>}</div>}
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
      {mode === 'qwenEdit' && <QwenReferenceEditor refs={refs} prompt={data.prompt || ''} disabled={running || readOnly}
        onPrompt={(prompt) => updateNode(id, { prompt })}
        onMove={(sourceId, direction) => changeQwenReferences(id, sourceId, direction)}
        onRemove={(sourceId) => changeQwenReferences(id, sourceId, 0)} />}
      {!['imageUpscale', 'qwenEdit'].includes(mode) && <PromptEditor
        ref={promptEditorRef}
        value={data.prompt || ''}
        onChange={(prompt) => updateNode(id, { prompt, outfitPreset: null })}
        items={['image', 'identityEdit', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode) ? [] : mentionItems}
        ariaLabel={['image', 'identityEdit', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode) ? '图片提示词' : '视频提示词'}
        disabled={running}
        placeholder={mode === 'characterSheet' ? '输入角色身份、完整穿搭、身材比例和写实程度；四个视角、统一背景、9:16 与拼版自动处理……' : mode === 'outfitEdit' ? '输入选定的服装描述；保持母图身份、比例和各面板景别，按所选高清策略处理后合成……' : mode === 'qwenEdit' ? '明确写出要保持的人物特征，以及只修改的穿搭、局部或场景；输出继承第一张母图的比例……' : mode === 'identityEdit' ? '说明要保持的人物身份，以及要改变的穿搭、姿态或场景……' : mode === 'image' ? '描述人物全身、穿搭、场景、光线和镜头；生成后可连接到视频参考或首尾帧……' : mode === 'swap' ? '留空自动锁定参考人物的面部、发型、体型和整套穿搭，不只换脸；也可补充可见特征……' : mode === 'upscale' ? '留空自动保持人物、穿搭、动作和场景，只补充高清细节；也可输入额外要求……' : mode === 'reference' ? '输入文字或 @ 参考内容，自由组合图、文、音、视频……\n例如：@角色参考 在雨夜街道回头，电影感，环境雨声。' : '描述主体、动作、镜头和声音……'}
      />}
      {mode === 'swap' && <div className="swap-settings">
        <label>换人目标<input value={data.targetDescription || ''} disabled={running} onChange={(e) => updateNode(id, { targetDescription: e.target.value })} placeholder="例如：右侧白色假人；单人可留空" /></label>
        <label>SAM 识别<input value={data.targetQuery || 'person'} disabled={running} onChange={(e) => updateNode(id, { targetQuery: e.target.value })} placeholder="person" /></label>
        <label>目标位置<select aria-label="目标位置" value={data.targetSelection || 'largest'} disabled={running} onChange={(e) => updateNode(id, { targetSelection: e.target.value })}><option value="largest">最大主体</option><option value="leftmost">最左侧</option><option value="rightmost">最右侧</option><option value="index">按编号</option></select></label>
        {(data.targetSelection || 'largest') === 'index' && <label className="target-index">编号<input type="number" min="0" max="63" value={data.targetIndex ?? 0} disabled={running} onChange={(e) => updateNode(id, { targetIndex: Math.max(0, Number(e.target.value)) })} /></label>}
      </div>}
      <div className="creator-params">
        <div className="param-group">
          {!['imageUpscale', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode) && <label className="param-pill" title={mode === 'upscale' ? '高清二采应保持与一采相同的画幅比例' : ''}><Zap size={12} /><select aria-label="画幅比例" value={data.ratio} disabled={running} onChange={(e) => updateNode(id, { ratio: e.target.value })}>{['16:9','9:16','1:1','4:3','3:4','21:9'].map((x) => <option key={x}>{x}</option>)}</select><ChevronDown size={11} /></label>}
          {!imageFamily && <label className="param-pill" title={`输出尺寸 ${outputWidth} × ${outputHeight}；分辨率越高，显存占用和生成时间越长`}><Maximize2 size={12} /><select aria-label="分辨率" value={resolution} disabled={running} onChange={(e) => updateNode(id, { resolution: e.target.value })}>{['480P','720P','1080P'].map((x) => <option key={x} value={x}>{x}</option>)}</select><ChevronDown size={11} /></label>}
          {!['upscale', 'image', 'imageUpscale', 'identityEdit', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode) && <label className="param-pill"><Clock3 size={12} /><select aria-label="视频时长" value={data.duration} disabled={running} onChange={(e) => updateNode(id, { duration: Number(e.target.value) })}>{[5,6,7,8,9,10,11,12,13,14,15].map((x) => <option key={x} value={x}>{x} 秒</option>)}</select><ChevronDown size={11} /></label>}
          {mode === 'outfitEdit' && <><label className="param-pill"><Layers3 size={12} /><select aria-label="四视图模型版本" value={data.outfitModel || 'qwen21'} disabled={running} onChange={(e) => updateNode(id, { outfitModel: e.target.value, ...(e.target.value === 'muse_v4' ? { imageLora: 'none' } : {}), error: null })}><option value="qwen21">Qwen 2.1 标准版 INT8</option><option value="qwen21_turbo">Qwen 2.1 Turbo INT8 · 8 步</option><option value="muse_v4">Muse V4.0 INT8 · Identity V2</option></select><ChevronDown size={11} /></label><label className="param-pill" title="只对各视图独立高清后按母图版面合成；无高清分支不调用修复模型"><Maximize2 size={12} /><select aria-label="四视图高清策略" value={data.outfitUpscale || 'auto'} disabled={running} onChange={(e) => updateNode(id, { outfitUpscale: e.target.value, ...(e.target.value === 'seedvr2_7b' ? { upscaleModel: 'seedvr2_7b' } : {}) })}><option value="auto">旧版 · 低于 1K 才 3B 高清</option><option value="off">不做高清修复</option><option value="seedvr2_7b">逐视图 SeedVR2 7B INT8</option></select><ChevronDown size={11} /></label>{data.outfitModel === 'muse_v4' ? <label className="param-pill"><Zap size={12} /><select aria-label="Muse V4 采样步数" value={data.museSteps || 16} disabled={running} onChange={(e) => updateNode(id, { museSteps: Number(e.target.value) })}><option value={8}>8 步 · 预览</option><option value={16}>16 步 · 标准</option><option value={20}>20 步 · 对照</option></select><ChevronDown size={11} /></label> : <label className="param-pill" title="Qwen 2.1 专用写实角色 LoRA；改变基座版本后需比较身份保留效果"><Sparkles size={12} /><select aria-label="换装写实强度" value={data.imageLora === 'qwen21Realism' ? String(data.loraStrength ?? 0.6) : 'off'} disabled={running} onChange={(e) => updateNode(id, e.target.value === 'off' ? { imageLora: 'none' } : { imageLora: 'qwen21Realism', loraStrength: Number(e.target.value) })}><option value="off">原版写实</option><option value={0.45}>写实 LoRA · 0.45</option><option value={0.6}>写实 LoRA · 0.6</option><option value={0.7}>写实 LoRA · 0.7</option><option value={0.8}>写实 LoRA · 0.8</option></select><ChevronDown size={11} /></label>}</>}
          {mode === 'image' && <><label className="param-pill" title="选择本地文生图模型"><Layers3 size={12} /><select aria-label="生图模型" value={data.imageModel || 'krea2'} disabled={running || readOnly} onChange={(e) => updateNode(id, { imageModel: e.target.value, ...(['flux3_klein', 'h3_image'].includes(e.target.value) ? { imageLora: 'none' } : {}), error: null })}><option value="krea2">Krea2 · 快速生图</option><option value="moss">MOSS · 角色与场景</option><option value="h3_image">MiniMax H3 Image INT8</option><option value="flux3_klein">FLUX 3 Image Klein INT8</option></select><ChevronDown size={11} /></label>{!isMoss && !isFlux3 && !h3Image && <label className="param-pill"><Sparkles size={12} /><select aria-label="图片风格" value={data.imageLora || 'none'} disabled={running} onChange={(e) => updateNode(id, { imageLora: e.target.value })}><option value="none">无 LoRA</option><option value="realism">写实增强</option><option value="asian">亚洲人物</option><option value="fantasy">奇幻现实</option><option value="watercolor">柔和水彩</option><option value="retroAnime">复古动漫</option></select><ChevronDown size={11} /></label>}</>}
          {h3Image && <label className="param-pill" title="默认约4MP；16MP占用更多显存与时间，24GB显卡建议先用4MP"><Maximize2 size={12} /><select aria-label="H3-Image 输出尺寸" value={data.h3ImageResolution || '4MP'} disabled={running || readOnly} onChange={e => updateNode(id, { h3ImageResolution: e.target.value })}><option value="4MP">约 4MP · 标准</option><option value="16MP">约 16MP · 高显存</option></select><ChevronDown size={11} /></label>}
          {isFlux3 && <label className="param-pill" title="默认约 1MP；2K 与 4K 指长边，尺寸对齐模型；高分辨率占用更多显存与时间"><Maximize2 size={12} /><select aria-label="FLUX 3 输出尺寸" value={data.flux3Resolution || '1MP'} disabled={running || readOnly} onChange={(e) => updateNode(id, { flux3Resolution: e.target.value })}><option value="1MP">约 1MP · 标准</option><option value="2K">2K · 长边 2048</option><option value="4K">4K · 长边 4096</option></select><ChevronDown size={11} /></label>}
          {mode === 'imageUpscale' && <label className="param-pill"><Layers3 size={12} /><select aria-label="高清模型版本" value={data.upscaleModel || 'seedvr2_3b'} disabled={running} onChange={(e) => updateNode(id, { upscaleModel: e.target.value, error: null })}><option value="seedvr2_3b">SeedVR2 3B INT8</option><option value="seedvr2_7b">SeedVR2 7B INT8</option></select><ChevronDown size={11} /></label>}
          {mode === 'imageUpscale' && <label className="param-pill"><Maximize2 size={12} /><select aria-label="图片放大倍数" value={data.imageScale || 1.5} disabled={running} onChange={(e) => updateNode(id, { imageScale: Number(e.target.value) })}><option value={1.5}>1.5× · 约 2K</option><option value={2}>2× · 细节更多</option></select><ChevronDown size={11} /></label>}
          {mode === 'qwenEdit' && <><label className="param-pill"><Layers3 size={12} /><select aria-label="Qwen 模型版本" value={data.qwenModel || 'standard'} disabled={running || readOnly} onChange={(e) => updateNode(id, { qwenModel: e.target.value, ...(['flux3_klein', 'h3_image'].includes(e.target.value) ? { imageLora: 'none' } : {}), error: null })}><option value="standard">Qwen 2.1 标准版 INT8</option><option value="turbo">Qwen 2.1 Turbo INT8</option><option value="h3_image" disabled={Boolean(mask || data.qwenSourceCrop || data.qwenMaskCrop)}>MiniMax H3 Image INT8</option><option value="flux3_klein" disabled={Boolean(mask || data.qwenSourceCrop || data.qwenMaskCrop)} title="局部遮罩与单格裁切请使用 Qwen">FLUX 3 Image Klein INT8</option></select><ChevronDown size={11} /></label>{h3Image ? <span className="param-pill active"><Zap size={12} />6 步 · H3-Image</span> : isFlux3 ? <span className="param-pill active"><Zap size={12} />16 步 · Klein</span> : data.qwenModel === 'turbo' ? <span className="param-pill active" title="官方 Turbo 8 步采样日程"><Zap size={12} />8 步 · Turbo</span> : <label className="param-pill" title="标准版使用 Euler、Simple、CFG 1"><Zap size={12} /><select aria-label="Qwen 采样步数" value={data.qwenSteps || 40} disabled={running || readOnly} onChange={(e) => updateNode(id, { qwenSteps: Number(e.target.value) })}><option value={25}>25 步 · 预览</option><option value={40}>40 步 · 质量</option></select><ChevronDown size={11} /></label>}{!isFlux3 && !h3Image && <label className="param-pill" title="风格化人物转真人时使用任转真 LoRA；普通编辑可关闭以优先保持原图"><Sparkles size={12} /><select aria-label="图生图真人化强度" value={data.imageLora === 'qwen21Realism' ? String(data.loraStrength ?? 0.6) : 'off'} disabled={running || readOnly} onChange={(e) => updateNode(id, e.target.value === 'off' ? { imageLora: 'none' } : { imageLora: 'qwen21Realism', loraStrength: Number(e.target.value) })}><option value="off">原模型</option><option value={0.45}>真人化 LoRA · 0.45</option><option value={0.6}>真人化 LoRA · 0.6</option><option value={0.8}>真人化 LoRA · 0.8</option></select><ChevronDown size={11} /></label>}</>}
          {mode === 'characterSheet' && <><label className="param-pill" title="四个视图分别使用相同的 Qwen 2.1 标准版采样质量"><Zap size={12} /><select aria-label="四视图采样步数" value={data.qwenSteps || 40} disabled={running} onChange={(e) => updateNode(id, { qwenSteps: Number(e.target.value) })}><option value={25}>4 × 25 步 · 预览</option><option value={40}>4 × 40 步 · 质量</option></select><ChevronDown size={11} /></label><label className="param-pill" title="风格化人物转真人时可启用；四个视图使用相同强度"><Sparkles size={12} /><select aria-label="四视图真人化强度" value={data.imageLora === 'qwen21Realism' ? String(data.loraStrength ?? 0.6) : 'off'} disabled={running} onChange={(e) => updateNode(id, e.target.value === 'off' ? { imageLora: 'none' } : { imageLora: 'qwen21Realism', loraStrength: Number(e.target.value) })}><option value="off">原模型</option><option value={0.45}>真人化 LoRA · 0.45</option><option value={0.6}>真人化 LoRA · 0.6</option><option value={0.8}>真人化 LoRA · 0.8</option></select><ChevronDown size={11} /></label></>}
          {mode === 'localRealism' && <><label className="param-pill" title="按原图视角选择对应皮肤区域；身体视图使用肤色与区域双重限制"><Crosshair size={12} /><select aria-label="原图视角" value={data.localMaskMode || 'front'} disabled={running} onChange={(e) => updateNode(id, { localMaskMode: e.target.value })}><option value="front">正面近景</option><option value="side">侧面近景</option><option value="back_body">背面全身</option><option value="front_body">正面全身</option></select><ChevronDown size={11} /></label><label className="param-pill" title="仅对皮肤区域采样，之后回贴原图"><Zap size={12} /><select aria-label="局部修复步数" value={data.localRealismSteps || 25} disabled={running} onChange={(e) => updateNode(id, { localRealismSteps: Number(e.target.value) })}><option value={20}>20 步 · 轻修</option><option value={25}>25 步 · 标准</option><option value={30}>30 步 · 精修</option><option value={40}>40 步 · 完整重绘</option></select><ChevronDown size={11} /></label><label className="param-pill" title="局部裁切区域的生成分辨率；最终始终回贴原始尺寸，1536 适合 4K 母图细节对照"><Maximize2 size={12} /><select aria-label="局部修复精度" value={data.localRealismSize || 768} disabled={running} onChange={(e) => updateNode(id, { localRealismSize: Number(e.target.value) })}><option value={768}>局部 768</option><option value={1024}>局部 1024</option><option value={1536}>局部 1536 · 4K 母图</option></select><ChevronDown size={11} /></label><label className="param-pill" title="低强度保留原图结构并轻度增加肤质；1.0 为完整重采样，可能产生接缝"><Zap size={12} /><select aria-label="局部重绘强度" value={data.localRealismDenoise ?? 1} disabled={running} onChange={(e) => updateNode(id, { localRealismDenoise: Number(e.target.value) })}><option value={0.2}>轻修 · 0.20</option><option value={0.35}>自然 · 0.35</option><option value={0.5}>加强 · 0.50</option><option value={1}>完整重采样 · 1.00</option></select><ChevronDown size={11} /></label><label className="param-pill" title="0 最保守；增大后可能碰到五官边缘"><Crosshair size={12} /><select aria-label="皮肤遮罩外扩" value={data.localMaskExpand ?? 0} disabled={running} onChange={(e) => updateNode(id, { localMaskExpand: Number(e.target.value) })}><option value={0}>遮罩不外扩</option><option value={8}>外扩 8 px</option><option value={16}>外扩 16 px</option></select><ChevronDown size={11} /></label><label className="param-pill" title="仅在皮肤遮罩内使用 Qwen 2.1 写实 LoRA；0.45 优先保持人物身份"><Sparkles size={12} /><select aria-label="局部写实强度" value={data.imageLora === 'qwen21Realism' ? String(data.loraStrength ?? 0.45) : 'off'} disabled={running} onChange={(e) => updateNode(id, e.target.value === 'off' ? { imageLora: 'none' } : { imageLora: 'qwen21Realism', loraStrength: Number(e.target.value) })}><option value="off">原模型</option><option value={0.35}>写实 LoRA · 0.35</option><option value={0.45}>写实 LoRA · 0.45</option><option value={0.6}>写实 LoRA · 0.6</option><option value={0.8}>写实 LoRA · 0.8</option></select><ChevronDown size={11} /></label></>}
          {['qwenEdit', 'characterSheet', 'localRealism'].includes(mode) ? null : ['image', 'identityEdit', 'outfitEdit'].includes(mode) ? <span className="param-pill active" title={`${mode === 'outfitEdit' ? `各视图保持原始宽高比；${models.outfitModelLabel}；${models.outfitHdLabel}` : `输出 ${outputWidth} × ${outputHeight}`} ${mode === 'identityEdit' ? '；参考强度 4；自由重构' : ''}`}><Zap size={12} />{mode === 'outfitEdit' ? `${models.outfitSteps} 步 · 原版面合成` : mode === 'identityEdit' ? 'V2 · 强度 4' : h3Image ? '6 步 · H3-Image' : isFlux3 ? '16 步 · Klein' : isMoss ? '25 步 · Spectrum' : '8 步 Turbo'}</span> : mode === 'imageUpscale' ? <span className="param-pill active" title={`${models.upscaleModelLabel} 一步扩散，Lab 保真校色`}><Zap size={12} />1 步 · 保真</span> : mode === 'upscale' ? <span className="param-pill active" title="导演台高清分支参数：4 步 768P Turbo LoRA、Euler、Beta、3 步、0.2 降噪"><Zap size={12} />4 步 Turbo · 3 步二采</span> : mode === 'swap' ? <span className="param-pill active" title="Akatz 官方参数：FL2V Turbo、ER-SDE、Normal、CFG 1"><Zap size={12} />v1.5 · 8 步</span> : <button className={`param-pill turbo-pill ${data.turbo ? 'active' : ''}`} disabled={running} title={data.turbo ? 'Turbo 适合快速看构图；角色或动作参考不准确时请切换标准模式' : '标准模式使用 beta 调度，参考身份与动作更稳定'} onClick={() => updateNode(id, { turbo: !data.turbo })}><Zap size={12} />{data.turbo ? `${mode === 'reference' ? 4 : 8} 步 Turbo` : '标准 20 步'}</button>}
          {mode === 'reference' && <button className={`param-pill ${data.refImageSize === 'max' ? 'active' : ''}`} onClick={() => updateNode(id, { refImageSize: data.refImageSize === 'max' ? 'match' : 'max' })} title="高保真参考更慢，但保留更多主体细节"><Layers3 size={12} />{data.refImageSize === 'max' ? '高保真' : '均衡'}</button>}
          {mode === 'swap' && <span className="param-pill active" title="SAM3.1 遮罩直接作用于源视频 latent，而非生成后回填"><Crosshair size={12} />潜空间保护</span>}
        </div>
        <button className="node-share-button nodrag" disabled={running} aria-label="上传此节点" title="上传此节点到节点库" onClick={() => openNodeShare(id)}><Upload size={14} /></button>
        {running ? <button className="send-button cancel" onClick={() => cancelNode(id)} title="取消生成"><Square size={15} fill="currentColor" /></button> : <button className="send-button node-generate" onClick={() => generateNode(id)} disabled={!serverOnline} title={mode === 'imageUpscale' ? '本地高清放大' : '本地生成'}><ArrowUp size={17} /></button>}
      </div>
      <div className="creator-footnote"><span>{h3Image ? 'H3-Image · 6步 · 直接使用提示词；24GB显卡建议4MP。编辑时图1决定比例，最多10张参考；不支持Qwen遮罩与LoRA。' : mode === 'characterSheet' ? '正面头像 + 45° 头像 + 无头背面全身 + 无头正面全身；统一浅灰背景；四张原生 9:16；依次保存四张单图后拼接，画布交付最终整图；不做高清化' : mode === 'outfitEdit' ? (outfitLayout === 'legacy' ? '旧版兼容：只换两张身体图并保留近景原图' : `逐面板换装 · ${models.outfitHdLabel}；近景不拉远、全身不补头；保持母图原尺寸与版面`) : mode === 'qwenEdit' ? (isFlux3 ? '最多10张参考，图1决定比例；自动扩写提示词；局部遮罩与裁切请使用 Qwen。' : '最多10张参考；图1决定画幅。点击缩略图引用，在提示词中自由说明结构、场景、画风等用途。') : mode === 'identityEdit' ? 'Krea2 + Identity Edit V2；单图身份编辑，可换装或换姿态；结果可继续连接图片高清' : mode === 'image' ? (isFlux3 ? '自动扩写提示词 · 16 步生成；高分辨率建议先确认 1MP 构图。' : isMoss ? 'MOSS 从零生成新角色和场景；25 步 Spectrum 加速；模型依赖会在提交前检查' : '人物建议写明“全身、完整穿搭”；结果可直接连视频参考或首尾帧') : mode === 'imageUpscale' ? '只放大图片，不重新设计人物和场景；默认 1.5 倍，按需运行' : mode === 'swap' ? '仅运行一采角色替换；需要高清时，再连接独立高清二采节点' : mode === 'upscale' ? '默认 720P；画幅需与一采一致；Sage 加速；保留原音轨' : mode === 'reference' ? `已连接 ${refs.length} 个素材 · 本地上限 9 图 / 3 视频 / 3 音频` : mode === 'frames' ? '从图片节点连接首帧、尾帧；留空图片时按提示词生成视频' : '无需参考素材，直接通过文字生成'}</span><b>本地免费</b></div>
    </NodeToolbar>
  </div>;
}

function ImageProcessCanvasNode(props) {
  const actions = useContext(NodeContext);
  return <ImageProcessNode {...props} actions={actions} title={<NodeTitle id={props.id} data={props.data} kind="generator" />} toolbar={<NodeActions id={props.id} data={props.data} selected={props.selected} />} />;
}
function ArtDirectorCanvasNode(props) {
  const actions = useContext(NodeContext);
  return <ArtDirectorNode {...props} actions={actions} title={<NodeTitle id={props.id} data={props.data} kind="generator" />} toolbar={<NodeActions id={props.id} data={props.data} selected={props.selected} />} />;
}
const nodeTypes = { artDirector: React.memo(ArtDirectorCanvasNode), note: React.memo(NoteNode), media: React.memo(MediaNode), generator: React.memo(GeneratorNode), prompt: React.memo(PromptOptimizerNode), imageProcess: React.memo(ImageProcessCanvasNode) };

function CanvasInner({ onSimpleMode, onLauncher, project, onProjectChange, onReload }) {
  const saved = useMemo(() => {
    const canvas = migrateCanvas(project.canvas, project.id);
    return { ...canvas, nodes: hydrateProjectMedia(canvas.nodes, project.id), viewport: readViewport(project.id, project.canvas.viewport) };
  }, [project.id]);
  const [nodes, setNodes, onNodesChange] = useNodesState(saved.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved.edges || []);
  const [projectName, setProjectName] = useState(project.name);
  const [projects, setProjects] = useState(() => [projectSummary(project)]);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [projectConnectionError, setProjectConnectionError] = useState('');
  const [creativeOpen, setCreativeOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [workflowInspection, setWorkflowInspection] = useState(null);
  const [referenceLibrary, setReferenceLibrary] = useState(null);
  const [referenceLibraryTab, setReferenceLibraryTab] = useState(null);
  const [nodeLibraryOpen, setNodeLibraryOpen] = useState(false);
  const [nodeLibraryMounted, setNodeLibraryMounted] = useState(false);
  const [workflowLibraryOpen, setWorkflowLibraryOpen] = useState(false);
  const [pureRefSelection, setPureRefSelection] = useState(null);
  const pureRefFileRef = useRef(null);
  const pureRefBusyRef = useRef(false);
  const [dependencyRequest, setDependencyRequest] = useState(null);
  const [nodeShare, setNodeShare] = useState(null);
  const [sharePacket, setSharePacket] = useState(null);
  const catalogBusyRef = useRef(false);
  const catalogRequestRef = useRef(null);
  const catalogSaveRetriesRef = useRef(new Map());
  const libraryModalOpen = Boolean(pureRefSelection || referenceLibrary || workflowLibraryOpen || dependencyRequest || nodeShare);
  const referenceImportBusyRef = useRef(false);
  const videoImportBusyRef = useRef(null);
  useEffect(() => () => { videoImportBusyRef.current = null; }, []);
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
  const mediaAttemptsRef = useRef(new Map());
  const mediaUploadTailRef = useRef(Promise.resolve());
  const nameRef = useRef(projectName);
  nameRef.current = projectName;
  const viewportRef = useRef(saved.viewport);
  const interactionRef = useRef(false);
  const [saveState, setSaveState] = useState(project.readOnly ? '只读' : '已保存');
  const accessRecoveryRef = useRef(null);
  if (!accessRecoveryRef.current) accessRecoveryRef.current = createProjectAccessRecovery({
    restore: restoreProjectAccess, getCurrent: () => projectRef.current, onError: setProjectConnectionError,
  });
  const restoreCurrentProjectAccess = useCallback((options) => accessRecoveryRef.current(options), []);
  useEffect(() => { setProjectConnectionError(''); }, [project.id]);
  const { server, metrics, checkServer, onStatusClick, starting, notice: localConnectionNotice, dismissNotice, setConnectionNotice: setLocalConnectionNotice, connectionEpoch } = useLocalConnection({ onReconnect: restoreCurrentProjectAccess });
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
  const pendingRegistrationsRef = useRef(new Map());
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const filesRef = useRef({});
  const fileIdentitiesRef = useRef({});
  const generationAttemptsRef = useRef(new GenerationAttempts());
  const localImageJobsRef = useRef(new Map());
  const [localImageJobsVersion, setLocalImageJobsVersion] = useState(0);
  const isImageProcessBusy = useCallback((id) => localImageJobsRef.current.has(id), []);
  useEffect(() => () => { localImageJobsRef.current.forEach((controller) => controller.abort()); }, []);
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
    if (!nodes.some((node) => node.dragging || node.resizing)) historyRef.current.observe(nodes, edges);
  }, [nodes, edges]);
  useEffect(() => {
    if (project.readOnly) return undefined;
    const labels = { saved: '已保存', dirty: '有未保存修改', saving: '保存中', error: '保存失败' };
    const controller = new AutoSaveController({
      name: project.name,
      canvas: canvasSnapshot(nodesRef.current, edgesRef.current, viewportRef.current),
      write: async ({ name, canvas }) => {
        const next = await saveProject(project.id, revisionRef.current, name, canvas);
        revisionRef.current = next.revision;
        setProjects((rows) => rows.map((row) => row.id === next.id ? projectSummary(next) : row));
        setProjectError('');
      },
      onStateChange: (state) => setSaveState(labels[state] || '已保存'),
      onError: (error) => setProjectError(error.code === 'REVISION_CONFLICT' || error.status === 409
        ? '项目版本已更新（可能来自 Agent 或其他页面）。本次提交已保存为冲突副本；后续修改保留在本页，自动保存已暂停。正在运行的生成不受影响，请保留本页并核对差异后再重新打开项目。'
        : error.message || '项目保存失败，请保留本页后重试。'),
    });
    autoSaveRef.current = controller;
    return () => { controller.dispose(); autoSaveRef.current = null; };
  }, [project.id, project.readOnly]);
  useEffect(() => {
    autoSaveRef.current?.observe(projectName, { nodes, edges, viewport: project.canvas.viewport }, {
      defer: interactionRef.current || nodes.some((node) => node.dragging || node.resizing) || mediaWritesRef.current.size > 0,
    });
  }, [nodes, edges, projectName]);
  const persistProject = useCallback((retry = false) => {
    if (project.readOnly || !autoSaveRef.current) return Promise.resolve();
    return flushProjectAfterMedia({
      mediaWrites: mediaWritesRef.current,
      observeAndFlush: () => {
        // A slow upload may be the only dirty change. Always sample after it
        // commits, even when AutoSaveController had no pending snapshot before.
        autoSaveRef.current.observe(nameRef.current, { nodes: nodesRef.current, edges: edgesRef.current, viewport: project.canvas.viewport }, {
          defer: interactionRef.current || nodesRef.current.some((node) => node.dragging || node.resizing) || mediaWritesRef.current.size > 0,
        });
        return autoSaveRef.current.flush({ retry });
      },
    });
  }, [project.readOnly]);
  const retryProjectSave = useCallback(() => retryCurrentProjectSave({
    getContext: () => ({ projectId: projectRef.current.id, readOnly: projectRef.current.readOnly,
      switching: switchingRef.current, controller: autoSaveRef.current, revision: revisionRef.current }),
    restore: restoreCurrentProjectAccess, persist: persistProject,
  }), [restoreCurrentProjectAccess, persistProject]);
  const saveHandoff = useCallback(async (data) => {
    await persistProject();
    const current = { ...projectRef.current, revision: revisionRef.current };
    const next = await updateProjectHandoff(current, data);
    updateProjectDocument(next);
    setProjectError('');
    return next;
  }, [persistProject, updateProjectDocument]);
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
  const loadedQueueJobIdsRef = useRef(new Set(saved.nodes.flatMap((node) => (
    node.type === 'generator' && isActiveTaskStatus(node.data?.status) && node.data.queueJobId ? [node.data.queueJobId] : []
  ))));
  const seenQueueJobIdsRef = useRef(new Set());
  const hasActiveTask = () => canvasHasActiveTask(nodesRef.current, {
    pureRefBusy: pureRefBusyRef.current,
    videoImportBusy: Boolean(videoImportBusyRef.current),
    localImageJobs: localImageJobsRef.current.size,
  });
  const downloadLocalSnapshot = () => {
    const snapshot = { ...projectRef.current, revision: revisionRef.current, name: nameRef.current,
      canvas: canvasSnapshot(nodesRef.current, edgesRef.current, viewportRef.current) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `canvas-recovery-${project.id}-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const reloadProject = async () => {
    if (hasActiveTask() || mediaWritesRef.current.size) return;
    downloadLocalSnapshot();
    if (!window.confirm('已请求下载当前画布 JSON 快照（不含素材）。请确认已保存该文件，再载入服务器最新版本；未同步修改只保留在此快照中。')) return;
    try { onReload(await openProject(project.id)); }
    catch (error) { setProjectError(error.message); }
  };
  const prepareProjectSwitch = async (id, name, { allowReadOnly = false } = {}) => {
    if (referenceLibrary) throw new Error('请关闭参考库后再切换项目。');
    if (libraryModalOpen || catalogBusyRef.current) throw new Error('请完成节点导入并关闭当前窗口后再切换项目。');
    if (project.readOnly && !allowReadOnly) throw new Error('当前画布为只读，不能通过 Agent 切换项目。');
    if (switchingRef.current) throw new Error('正在切换项目，请稍后重试。');
    if (hasActiveTask()) throw new Error('任务进行中，请等待完成后再新建或切换项目。');
    switchingRef.current = true; setProjectBusy(true);
    try {
      await persistProject();
      if (hasActiveTask()) throw new Error('任务进行中，请等待完成后再切换项目。');
      const target = id ? null : await createProject(name, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
      return await openProject(id || target.id, { fallbackToReadOnly: false });
    } catch (error) { switchingRef.current = false; setProjectBusy(false); throw error; }
  };
  const abandonProjectSwitch = async (target) => {
    try { if (target.id !== project.id) await closeProject(target.id); }
    finally { switchingRef.current = false; setProjectBusy(false); }
  };
  const commitProjectSwitch = async (active) => {
    try {
      if (active.id === project.id) return;
      await closeProject(project.id);
      onProjectChange(active);
    } catch (error) { await abandonProjectSwitch(active); setProjectError(error.message || '切换失败，当前画布已保留。'); throw error; }
    finally { switchingRef.current = false; setProjectBusy(false); }
  };
  const changeProject = async (id, name) => {
    try { await commitProjectSwitch(await prepareProjectSwitch(id, name, { allowReadOnly: true })); return true; }
    catch (error) { setProjectError(error.message || '切换失败，当前画布已保留。'); return false; }
  };
  useEffect(() => () => clearCanvasThumbnails(), []);

  const updateNode = useCallback((id, patch) => {
    if (switchingRef.current || project.readOnly) return;
    setNodes((items) => {
      const previous = items.find((node) => node.id === id);
      if (previous?.data.mode === 'qwenEdit' && typeof patch.prompt === 'string') patch = { ...patch, prompt: bindQwenPrompt(patch.prompt, qwenCanvasReferences(previous, items, edgesRef.current)) };
      const renamed = previous && patch.title && patch.title !== previous.data.title;
      return items.map((node) => {
        if (node.id === id) return { ...node, data: { ...node.data, ...patch } };
        if (renamed && node.type === 'generator' && node.data.prompt?.includes(`@${previous.data.title}`)) {
          return { ...node, data: { ...node.data, prompt: node.data.prompt.split(`@${previous.data.title}`).join(`@${patch.title}`) } };
        }
        return node;
      });
    });
  }, [setNodes, project.readOnly]);

  useEffect(() => {
    if (project.readOnly) return;
    setNodes((items) => {
      if (!items.some((node) => resolvedLegacyShareError(node.data))) return items;
      return items.map((node) => resolvedLegacyShareError(node.data) ? { ...node, data: { ...node.data, error: '' } } : node);
    });
  }, [project.id, project.readOnly, setNodes]);

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

  const lockedQwenInput = useCallback((edge) => {
    const target = nodesRef.current.find((node) => node.id === edge.target);
    if (isMaskNode(target)) return edgesRef.current.some((out) => out.source === target.id && out.targetHandle === 'mask' && ['uploading', 'queued', 'running', 'finishing'].includes(nodesRef.current.find((node) => node.id === out.target)?.data.status));
    return target?.data.mode === 'qwenEdit' && ['references', 'guide', 'identity', 'mask'].includes(edge.targetHandle)
      && (['uploading', 'queued', 'running', 'finishing'].includes(target.data.status)
        || (target.data.qwenSourceCrop && qwenCanvasReferences(target, nodesRef.current, edgesRef.current)[0]?.id === edge.source));
  }, []);
  const handleEdgesChange = useCallback((changes) => {
    let blocked = false;
    const allowed = changes.filter((change) => {
      if (change.type !== 'remove') return true;
      if (project.readOnly || switchingRef.current) return false;
      if (edgesRef.current.some((edge) => edge.id === change.id && lockedQwenInput(edge))) { blocked = true; return false; }
      return true;
    });
    if (blocked) setProjectError('这条连线正在被生成使用或设有单格裁切，暂时不能断开。');
    onEdgesChange(allowed);
  }, [onEdgesChange, project.readOnly, lockedQwenInput]);
  const disconnectEdge = useCallback((id) => handleEdgesChange([{ id, type: 'remove' }]), [handleEdgesChange]);

  const removeNode = useCallback((id) => {
    if (switchingRef.current || project.readOnly) return;
    if (edgesRef.current.some((edge) => edge.source === id && lockedQwenInput(edge))) { setProjectError('此图片正在被生成使用或设有单格裁切，请先完成生成或清除裁切再删除。'); return; }
    const node = nodesRef.current.find((item) => item.id === id);
    localImageJobsRef.current.get(id)?.abort();
    if ((node?.data.queueJobId || node?.data.promptId) && ['uploading', 'queued', 'running', 'finishing'].includes(node.data.status)) cancelGeneration(node.data).catch(() => {});
    setNodes((items) => items.filter((item) => item.id !== id));
    setEdges((items) => items.filter((edge) => edge.source !== id && edge.target !== id));
    delete filesRef.current[id];
    delete fileIdentitiesRef.current[id];
    generationAttemptsRef.current.cancel(id);
    // A deleted node's pending asset still advances revision; keep the save barrier until it settles.
    mediaAttemptsRef.current.delete(id);
    // Keep immutable media records: this deletion may fail its project revision
    // check, and another committed canvas can still reference the same record.
  }, [setNodes, setEdges, project.readOnly, lockedQwenInput]);

  const togglePin = useCallback((id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (node) updateNode(id, { pinned: !node.data.pinned });
  }, [updateNode]);

  const saveCanvasMedia = useCallback((write, onSaved, nodeId = null) => {
    if (switchingRef.current || project.readOnly) return;
    // Keep the previous committed reference until the immutable replacement is
    // fully written. A full disk or failed request must not blank the old media.
    const mediaStorageId = uid('media');
    autoSaveRef.current?.suspend();
    // Asset uploads also advance project revision: finish the content PUT first,
    // then serialize this page's uploads and observe once the whole batch settles.
    const idle = autoSaveRef.current?.waitForIdle() || Promise.resolve();
    const pending = Promise.all([idle, mediaUploadTailRef.current]).then(() => write(revisionRef.current, mediaStorageId));
    mediaUploadTailRef.current = pending.catch(() => {});
    mediaWritesRef.current.set(mediaStorageId, pending);
    if (nodeId) mediaAttemptsRef.current.set(nodeId, mediaStorageId);
    setSaveState('保存中');
    return pending.then((result) => {
      revisionRef.current = Math.max(revisionRef.current, result.revision);
      if (nodeId && (mediaAttemptsRef.current.get(nodeId) !== mediaStorageId || !nodesRef.current.some((node) => node.id === nodeId))) return;
      return onSaved(result, mediaStorageId);
    }, (error) => {
      if (nodeId && mediaAttemptsRef.current.get(nodeId) !== mediaStorageId) return;
      setSaveState('保存失败');
      setProjectError(error.message || '素材保存失败，已保留原素材，请释放磁盘空间后重试。');
      return { ok: false, error };
    }).finally(() => {
      mediaWritesRef.current.delete(mediaStorageId);
      autoSaveRef.current?.observe(nameRef.current, { nodes: nodesRef.current, edges: edgesRef.current, viewport: project.canvas.viewport }, { defer: mediaWritesRef.current.size > 0 || interactionRef.current });
    });
  }, [setNodes, project.id, project.readOnly]);

  const saveCanvasAsset = useCallback((file, onSaved, nodeId = null) => saveCanvasMedia((revision, mediaStorageId) => saveProjectFile(project.id, mediaStorageId, file, revision), onSaved, nodeId), [saveCanvasMedia, project.id]);

  const chooseMedia = useCallback((id, file, sourceGallery = null, extraData = {}) => {
    if (switchingRef.current || project.readOnly) return;
    const mediaNode = nodesRef.current.find((item) => item.id === id);
    if (isMaskNode(mediaNode)) {
      const guide = canvasMaskGuide(id, nodesRef.current, edgesRef.current);
      if (!guide) throw new Error('请先连接遮罩底图。');
      const busy = edgesRef.current.some((edge) => edge.source === id && edge.targetHandle === 'mask' && ['uploading', 'queued', 'running', 'finishing'].includes(nodesRef.current.find((item) => item.id === edge.target)?.data.status));
      if (busy) throw new Error('生成期间不能更改遮罩。');
      extraData = { ...extraData, maskSourceId: guide.id, maskSourceKey: maskSourceKey(guide) };
    }
    return saveCanvasAsset(file, (result, mediaStorageId) => {
      filesRef.current[id] = file;
      const patch = hydrateProjectMedia([{ type: 'media', data: { ...extraData, name: file.name, mediaStorageId, assetPath: result.asset.path, sourceGallery, remoteName: null, localFile: true, output: false, resultUrl: null, tgaAssetPath: null } }], project.id)[0].data;
      fileIdentitiesRef.current[id] = mediaCacheIdentity({ ...nodesRef.current.find((node) => node.id === id)?.data, ...patch });
      const nextNodes = nodesRef.current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node);
      nodesRef.current = nextNodes; setNodes(nextNodes);
      return { ok: true, assetPath: result.asset.path };
    }, id);
  }, [saveCanvasAsset, setNodes, project.id, project.readOnly]);

  const openPureRefImport = (file, position = null) => {
    if (project.readOnly || switchingRef.current || libraryModalOpen || pureRefBusyRef.current || autoSaveRef.current?.failure) {
      setProjectError('请先处理当前窗口或画布保存状态，再导入 PureRef。'); return;
    }
    pureRefBusyRef.current = true;
    setPureRefSelection({ file, origin: position || screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) });
    setAddMenu(null);
  };

  const getReferences = useCallback((id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    const mode = node?.data.mode || 'reference';
    if (mode === 'qwenEdit') return qwenCanvasReferences(node, nodesRef.current, edgesRef.current);
    return edgesRef.current.filter((edge) => edge.target === id).map((edge) => {
      const source = nodesRef.current.find((item) => item.id === edge.source);
      return source?.type === 'media' ? { ...source, data: { ...source.data, slot: edge.targetHandle } } : null;
    }).filter(Boolean).filter((source) => mode === 'customWorkflow' ? source.data.kind === 'image' && Boolean(customInput(node.data, source.data.slot)) : mode === 'reference' ? source.data.slot === 'references' : mode === 'frames' ? ['first', 'last'].includes(source.data.slot) && source.data.kind === 'image' : ['imageUpscale', 'identityEdit', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode) ? source.data.kind === 'image' && (source.data.slot === 'guide' || (['qwenEdit', 'outfitEdit', 'localRealism'].includes(mode) && source.data.slot === 'identity')) : mode === 'videoSuperResolution' ? source.data.slot === 'guide' && source.data.kind === 'video' : ['swap', 'upscale'].includes(mode) ? (source.data.slot === 'guide' && source.data.kind === 'video') || (source.data.slot === 'identity' && source.data.kind === 'image') : false);
  }, []);

  const getMaskGuide = useCallback((id) => canvasMaskGuide(id, nodesRef.current, edgesRef.current), []);
  const getQwenMask = useCallback((id) => qwenCanvasMask(id, nodesRef.current, edgesRef.current), []);

  const getMentionItems = useCallback((id) => {
    const target = nodesRef.current.find((node) => node.id === id);
    return target?.data.mode === 'qwenEdit' ? qwenCanvasReferences(target, nodesRef.current, edgesRef.current) : nodesRef.current.filter((node) => node.type === 'media' && node.id !== id && node.data.title);
  }, []);
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
    // The current backend optimizer only implements H3 video prompting.
    if (target.data.mode === 'qwenEdit') { updateNode(id, { status: 'error', error: '当前提示词优化器仅支持 H3 视频。请在图生图节点内用图1、图2直接编写图片编辑要求。' }); return; }
    if (['uploading', 'queued', 'running', 'finishing'].includes(target.data.status)) { updateNode(id, { status: 'error', error: '生成期间不能修改提示词，请等待完成。' }); return; }
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
      const customFiles = source?.data.mode === 'customWorkflow' ? extensionMedia(history?.[promptId], source.data.workflowOutputs || source.data.workflowDefinition?.outputs) : null;
      const isImage = customFiles ? customFiles[0]?.kind !== 'video' : ['image', 'imageUpscale', 'identityEdit', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(source?.data.mode);
      const outputEntry = source?.data.mode === 'customWorkflow' ? declaredHistory(history?.[promptId], source.data.workflowOutputs || source.data.workflowDefinition?.outputs) : history?.[promptId];
      const files = customFiles || (isImage ? extractImages(outputEntry) : extractVideos(outputEntry));
      if (!files.length) throw new Error(`任务已结束，但没有找到${isImage ? '图片' : '视频'}输出。`);
      const singleOutfit = source?.data.mode === 'outfitEdit' && (source?.data.outfitPanel || source?.data.panelId);
      const preferredImage = files.find((file) => source?.data.mode === 'characterSheet' ? file.filename?.startsWith('H3_CharacterSheet_') : source?.data.mode === 'outfitEdit' ? file.filename?.startsWith(singleOutfit ? `H3_OutfitHD_${singleOutfit}_` : 'H3_OutfitQuad_') : source?.data.mode === 'qwenEdit' ? file.filename?.startsWith(isH3Image(source.data) ? 'H3_Image_Edit_' : 'H3_Qwen21Edit_') : source?.data.mode === 'identityEdit' ? file.filename?.startsWith('H3_IdentityV2_') : source?.data.mode === 'imageUpscale' ? file.filename?.startsWith('H3_Image_HD') : source?.data.mode === 'image' && source?.data.imageModel === 'moss' ? file.filename?.startsWith('H3_MOSS_Image_') : file.filename?.startsWith('H3_Image_'));
      const result = customFiles ? customFiles[0] : isImage ? preferredImage || files[0] : selectCompletedVideo(source?.data.mode, files);
      const resultModels = describeNodeModels(source?.data);
      const outfitTitle = singleOutfit ? `${resolveOutfitPanels(source.data).find((panel) => panel.id === singleOutfit)?.label || singleOutfit} · ${result.filename?.startsWith(`H3_OutfitSingle_${singleOutfit}_`) ? '原生尺寸 · 未高清' : '独立高清'}` : `四视图 · 单图按需高清${(source?.data.outfitLayout || 'legacy') === 'legacy' ? '拼接' : '原版面合成'}`;
      const title = isH3Image(source?.data) ? (source.data.mode === 'qwenEdit' ? 'H3-Image 编辑' : 'H3-Image 生图') : source?.data.mode === 'characterSheet' ? '角色四视图生成' : source?.data.mode === 'outfitEdit' ? outfitTitle : source?.data.mode === 'qwenEdit' ? '图生图' : source?.data.mode === 'localRealism' ? '局部写实修复' : source?.data.mode === 'identityEdit' ? '母图编辑 V2' : source?.data.mode === 'image' ? (source?.data.imageModel === 'moss' ? 'MOSS 生图' : 'Krea2 生图') : source?.data.mode === 'imageUpscale' ? '图片高清' : source?.data.mode === 'swap' ? '换人一采' : source?.data.mode === 'upscale' ? '高清二采' : '成片';
      const resultIndex = edgesRef.current.filter((edge) => edge.source === id && edge.targetHandle === 'preview').length;
      const resultPosition = findFreePosition(nodesRef.current, { x: (source?.position.x || 0) + 540, y: (source?.position.y || 0) + resultIndex * 340 }, 'media');
      const mediaNode = {
        id: uid(isImage ? 'image' : 'video'), type: 'media', position: resultPosition,
        data: { ...result, kind: isImage ? 'image' : 'video', output: true, title: `${source?.data.title || title}${['outfitEdit', 'qwenEdit', 'imageUpscale'].includes(source?.data.mode) ? ` · ${source.data.mode === 'outfitEdit' ? `${resultModels.outfitModelLabel} · ${resultModels.outfitHdLabel}` : source.data.mode === 'qwenEdit' ? resultModels.qwenModelLabel : resultModels.upscaleModelLabel}` : ''} · 成品 ${resultIndex + 1}`, name: result.filename, prompt: source?.data.prompt, sourcePromptId: promptId, sourceQueueJobId: source?.data.queueJobId || null, sourceGeneratorId: id },
      };
      const registerTake = async () => {
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
      };
      const { pinMedia, patch, deferredRegistration } = await resolveCanvasCompletion({
        shotId: source?.data.shotId, pinResultToCanvas: source?.data.pinResultToCanvas, output: result,
        persistProject, registerTake,
      });
      if (deferredRegistration) pendingRegistrationsRef.current.set(promptId, { id, mediaId: mediaNode.id, registerTake, running: false });
      if (patch.takePending) {
        mediaNode.data = { ...mediaNode.data, shotId: source.data.shotId, takePending: true, title: `${mediaNode.data.title} · 待登记 Take` };
      }
      setNodes((items) => items.map((node) => node.id === id ? {
        ...node,
        data: {
          ...node.data, ...patch, promptId,
          runs: [{ promptId, status: 'done', stage: patch.takePending ? patch.stage : `${title}已输出`, time: new Date().toLocaleString('zh-CN') }, ...(node.data.runs || [])].slice(0, 12),
        },
      } : node).concat(pinMedia ? [mediaNode] : []));
      if (pinMedia) setEdges((items) => addEdge({ id: `edge-${id}-${mediaNode.id}`, source: id, target: mediaNode.id, sourceHandle: isImage ? 'image' : 'video', targetHandle: 'preview' }, items));
      if (pinMedia && customFiles?.length > 1) {
        const extraNodes = customFiles.slice(1).map((file, index) => ({
          id: uid(file.kind), type: 'media', position: { x: resultPosition.x, y: resultPosition.y + (index + 1) * 340 },
          data: { ...file, output: true, title: `${source.data.title} · ${file.extensionOutputId} ${index + 2}`, name: file.filename, sourcePromptId: promptId, sourceQueueJobId: source.data.queueJobId || null, sourceGeneratorId: id },
        }));
        setNodes((items) => items.concat(extraNodes));
        setEdges((items) => items.concat(extraNodes.map((item) => ({ id: `edge-${id}-${item.id}`, source: id, target: item.id, sourceHandle: item.data.kind, targetHandle: 'preview' }))));
      }
    } catch (error) {
      completedJobsRef.current.delete(promptId);
      updateNode(id, { status: 'error', error: error.message, stage: '读取结果失败' });
    }
  }, [setNodes, setEdges, updateNode, persistProject, updateProjectDocument, project.id]);

  useEffect(() => {
    if (interactionRef.current || mediaWritesRef.current.size || nodes.some((node) => node.dragging || node.resizing)) return;
    if ([...pendingRegistrationsRef.current.values()].some((pending) => pending.running)) return;
    for (const [promptId, pending] of pendingRegistrationsRef.current) {
      if (pending.running) continue;
      pending.running = true;
      (async () => {
        try {
          await persistProject();
          await pending.registerTake();
          pendingRegistrationsRef.current.delete(promptId);
          setNodes((items) => items.map((node) => node.id === pending.mediaId
            ? { ...node, data: { ...node.data, takePending: false, title: node.data.title.replace(/ · 待登记 Take$/, '') } }
            : node.id === pending.id && node.data.promptId === promptId
              ? { ...node, data: { ...node.data, takePending: false, stage: '已加入 Take 栈' } } : node));
        } catch (error) {
          if (error.code === 'SAVE_DEFERRED') pending.running = false;
          else {
            pendingRegistrationsRef.current.delete(promptId);
            setProjectError(`成品已保留，Take 尚未登记：${error.message}`);
          }
        }
      })();
      break; // One registration at a time; a successful state update drives the next.
    }
  }, [nodes, edges, saveState, persistProject, setNodes]);

  const syncQueueJob = useCallback(async (job) => {
    if (!job || job.projectId !== project.id || !job.nodeId) return;
    const node = nodesRef.current.find((item) => item.id === job.nodeId && item.type === 'generator');
    const action = queueJobAction(node, job);
    if (action?.type === 'complete') await completeGeneration(node.id, action.promptId, action.history, action.attempt);
    else if (action?.type === 'patch') updateNode(node.id, action.patch);
  }, [completeGeneration, project.id, updateNode]);

  useEffect(() => {
    const events = openQueueEvents({
      onSnapshot(snapshot) {
        const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
        jobs.forEach((job) => { void syncQueueJob(job); });
        const patches = absentQueueJobPatches(nodesRef.current, jobs, {
          loadedJobIds: loadedQueueJobIdsRef.current, seenJobIds: seenQueueJobIdsRef.current,
        });
        for (const job of jobs) if (['queued', 'running', 'finishing'].includes(job.status)) seenQueueJobIdsRef.current.add(job.id);
        if (!patches.length) return;
        for (const patch of patches) loadedQueueJobIdsRef.current.delete(patch.jobId);
        setNodes((items) => patchNodes(items, patches));
      },
      onJobEvent(job) {
        if (job?.id && ['queued', 'running', 'finishing'].includes(job.status)) seenQueueJobIdsRef.current.add(job.id);
        void syncQueueJob(job);
      },
      // EventSource reconnects automatically; the next snapshot restores state.
    });
    return () => events.close();
  }, [syncQueueJob, setNodes]);

  useEffect(() => {
    const pending = nodesRef.current.filter((node) => node.type === 'generator' && isActiveTaskStatus(node.data?.status) && node.data?.promptId && !node.data?.queueJobId);
    if (!pending.length) return undefined;
    const pendingIds = new Map(pending.map((node) => [node.id, node.data.promptId]));
    let stopped = false;
    (async () => {
      const [queue, history] = await Promise.all([
        comfyFetch('/queue').catch(() => null),
        getHistory(100).catch(() => null),
      ]);
      if (stopped || !queue || !history || typeof history !== 'object') return;
      const patches = absentPromptPatches(nodesRef.current, {
        livePromptIds: comfyQueuePromptIds(queue), historyIds: new Set(Object.keys(history)),
      }).filter((item) => pendingIds.get(item.id) && nodesRef.current.find((node) => node.id === item.id)?.data?.promptId === pendingIds.get(item.id));
      if (!stopped && patches.length) setNodes((items) => patchNodes(items, patches.filter((item) => items.find((node) => node.id === item.id)?.data?.promptId === pendingIds.get(item.id))));
    })();
    return () => { stopped = true; };
  }, [project.id, setNodes]);

  useEffect(() => {
    const watch = new Map();
    for (const node of nodesRef.current) {
      if (!isActiveTaskStatus(node.data?.status)) continue;
      const request = exportJobRequest(node);
      if (request) watch.set(node.id, request);
    }
    if (!watch.size) return undefined;
    let stopped = false;
    const tick = async () => {
      const due = [];
      for (const [id, request] of watch) {
        const node = nodesRef.current.find((item) => item.id === id);
        if (!node || !isActiveTaskStatus(node.data?.status) || exportJobRequest(node)?.id !== request.id) { watch.delete(id); continue; }
        due.push([id, request]);
      }
      if (!due.length) return;
      const patches = [];
      await Promise.all(due.map(async ([id, request]) => {
        try {
          const response = await fetch(request.url, { credentials: 'same-origin', cache: 'no-store' });
          if (stopped) return;
          const job = response.ok ? await response.json().catch(() => null) : null;
          const node = nodesRef.current.find((item) => item.id === id);
          if (!node || exportJobRequest(node)?.id !== request.id) return;
          const patch = exportLookupPatch(node, classifyExportJob(response.status, job));
          if (!patch) return;
          patches.push({ id, jobId: request.id, patch });
          watch.delete(id);
        } catch { /* The export may still be running; retry on the next pass. */ }
      }));
      if (!stopped && patches.length) {
        setNodes((items) => patchNodes(items, patches.filter((item) => {
          const node = items.find((entry) => entry.id === item.id);
          return node && isActiveTaskStatus(node.data?.status) && exportJobRequest(node)?.id === item.jobId;
        })));
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [project.id, setNodes]);

  useEffect(() => {
    const socket = openProgressSocket(clientId, {
      onProgress(data) {
        const patch = promptProgressPatch(data);
        for (const node of promptEventTargets(nodesRef.current, data?.prompt_id)) {
          if (['done', 'cancelled'].includes(node.data?.status) || queueOwnsStage(node)) continue;
          updateNode(node.id, patch);
        }
      },
      onExecuting(data) {
        const patch = promptExecutingPatch(data);
        for (const node of promptEventTargets(nodesRef.current, data?.prompt_id)) {
          if (['done', 'cancelled'].includes(node.data?.status)) continue;
          if (patch.done) {
            if (queueOwnsCompletion(node)) continue;
            updateNode(node.id, { status: patch.status, stage: patch.stage, progress: patch.progress });
            setTimeout(() => completeGeneration(node.id, data.prompt_id), 700);
          } else if (!queueOwnsStage(node)) updateNode(node.id, { status: patch.status, stage: patch.stage });
        }
      },
      onExecutionError(data) {
        for (const node of promptEventTargets(nodesRef.current, data?.prompt_id)) updateNode(node.id, { status: 'error', error: data?.exception_message || '生成执行失败', stage: '生成失败' });
      },
      onInterrupted(data) {
        for (const node of promptEventTargets(nodesRef.current, data?.prompt_id)) updateNode(node.id, { status: 'cancelled', stage: '已取消', progress: 0 });
      },
    });
    return () => socket.close();
  }, [clientId, completeGeneration, updateNode, connectionEpoch]);

  useEffect(() => {
    let checking = false;
    const reconcileFinishedJobs = async () => {
      if (checking) return;
      const pending = nodesRef.current.filter(shouldReconcileCompletion);
      if (!pending.length) return;
      checking = true;
      try {
        const history = await getHistory(100);
        for (const node of pending) {
          const current = nodesRef.current.find((item) => item.id === node.id);
          if (!current || current.data.promptId !== node.data.promptId || !shouldReconcileCompletion(current)) continue;
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

  const refreshLibrary = useCallback(async () => {
    try {
      const history = await getHistory(100);
      const items = [];
      for (const [promptId, entry] of Object.entries(history || {})) for (const file of extractVideos(entry)) if (file.filename?.includes('H3_Workbench')) items.push({ ...file, promptId, title: file.filename });
      setHistoryItems(items.reverse());
    } catch { setHistoryItems([]); }
  }, []);
  useEffect(() => { if (libraryOpen) refreshLibrary(); }, [libraryOpen, refreshLibrary]);

  const artRunRef = useRef(null);
  const getImageProcessState = useCallback((id) => {
    try {
      const snapshot = imageProcessSnapshot(id, nodesRef.current, edgesRef.current);
      snapshot.refs = snapshot.refs.map((ref) => ({ ...ref, data: { ...ref.data, url: ref.data.assetPath ? assetUrl(project.id, ref.data.assetPath) : ref.data.url, rawUrl: ref.data.rawAssetPath ? assetUrl(project.id, ref.data.rawAssetPath) : null } }));
      snapshot.tgaUrl = snapshot.node.data.processedTgaAssetPath ? assetUrl(project.id, snapshot.node.data.processedTgaAssetPath) : null;
      return snapshot;
    } catch (error) { return { error: error.message }; }
  }, [project.id]);

  const getImageProcessMask = useCallback((id) => {
    const edge = edgesRef.current.find((item) => item.target === id && item.targetHandle === 'mask');
    const source = nodesRef.current.find((item) => item.id === edge?.source);
    if (!source) return null;
    const path = isImageProcess(source) ? source.data.processedAssetPath : source.data.assetPath;
    return { ...source, data: { ...source.data, url: path ? assetUrl(project.id, path) : source.data.url } };
  }, [project.id]);

  const runImageProcess = useCallback(async (id, { tga = false, download = false } = {}) => {
    if (switchingRef.current || project.readOnly || localImageJobsRef.current.has(id)) return;
    if (autoSaveRef.current?.failure) { updateNode(id, { status: 'error', error: '请先处理当前项目的保存错误。' }); return; }
    const controller = new AbortController();
    localImageJobsRef.current.set(id, controller);
    setLocalImageJobsVersion((version) => version + 1);
    let outputId;
    let snapshot;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (projectRef.current.id !== project.id || imageProcessSnapshot(id, nodesRef.current, edgesRef.current).signature !== snapshot.signature) throw new Error('输入或参数已改变，已停止本次输出，请重新运行。');
    };
    try {
      updateNode(id, { status: 'running', stage: '正在处理原始尺寸', error: null });
      await Promise.all([...mediaWritesRef.current.values()]);
      snapshot = getImageProcessState(id);
      if (snapshot.error) throw new Error(snapshot.error);
      const result = await renderImageProcess(snapshot.node.data.mode, snapshot.refs, snapshot.settings, { signal: controller.signal, tga });
      assertCurrent();
      outputId = uid('processed');
      const output = { id: outputId, type: 'media', position: findFreePosition(nodesRef.current, { x: snapshot.node.position.x + 470, y: snapshot.node.position.y }, 'media'),
        data: { kind: 'image', title: `${snapshot.node.data.title} · 输出`, url: '', name: '', sourceProcessId: id, processSignature: snapshot.signature } };
      flushSync(() => {
        const next = [...nodesRef.current, output]; nodesRef.current = next; setNodes(next);
        const nextEdges = [...edgesRef.current, { id: `edge-${id}-${outputId}`, source: id, target: outputId, sourceHandle: 'ref', targetHandle: 'preview' }]; edgesRef.current = nextEdges; setEdges(nextEdges);
        updateNode(id, { stage: '正在保存 PNG', status: 'finishing' });
      });
      const file = new File([result.blob], `${snapshot.node.data.title || 'processed'}.png`, { type: 'image/png' });
      const uploaded = await chooseMedia(outputId, file);
      if (!uploaded?.ok) throw new Error(uploaded?.error?.message || 'PNG 保存失败。');
      assertCurrent();
      let tgaPath = null;
      if (result.tgaBlob) {
        updateNode(id, { stage: '正在保存 TGA' });
        const attachment = await saveCanvasAsset(new File([result.tgaBlob], `${snapshot.node.data.title || 'processed'}.tga`, { type: 'image/x-tga' }), (saved) => ({ ok: true, assetPath: saved.asset.path }));
        if (!attachment?.ok) throw new Error(attachment?.error?.message || 'TGA 保存失败。');
        tgaPath = attachment.assetPath;
        assertCurrent();
      }
      const url = assetUrl(project.id, uploaded.assetPath);
      flushSync(() => {
        updateNode(outputId, { output: true, url, width: result.width, height: result.height, tgaAssetPath: tgaPath });
        updateNode(id, { processedAssetPath: uploaded.assetPath, processedUrl: url, processedSignature: snapshot.signature, processedResultId: outputId, processedTgaAssetPath: tgaPath, status: 'done', stage: tgaPath ? 'PNG + TGA 已输出' : 'PNG 已输出', error: null });
      });
      fileIdentitiesRef.current[outputId] = mediaCacheIdentity(nodesRef.current.find((node) => node.id === outputId).data);
      await persistProject();
      if (download && tgaPath) {
        const link = document.createElement('a'); link.href = assetUrl(project.id, tgaPath); link.download = `${snapshot.node.data.title || 'processed'}.tga`; link.click();
      }
      return { ok: true, resultId: outputId, tgaAssetPath: tgaPath };
    } catch (error) {
      if (outputId && !nodesRef.current.find((node) => node.id === outputId)?.data.assetPath) {
        setNodes((items) => items.filter((node) => node.id !== outputId));
        setEdges((items) => items.filter((edge) => edge.target !== outputId));
      }
      if (nodesRef.current.some((node) => node.id === id)) updateNode(id, { status: 'error', stage: '输出失败', error: error.message });
      return { ok: false, error: error.message };
    } finally {
      if (localImageJobsRef.current.get(id) === controller) {
        localImageJobsRef.current.delete(id);
        setLocalImageJobsVersion((version) => version + 1);
      }
    }
  }, [project.id, project.readOnly, getImageProcessState, chooseMedia, saveCanvasAsset, updateNode, setNodes, setEdges, persistProject]);

  const generateNode = useCallback(async (id) => {
    if (nodesRef.current.find(n => n.id === id)?.type === 'artDirector') return artRunRef.current?.(id);
    if (switchingRef.current || project.readOnly) return;
    const attempt = generationAttemptsRef.current.begin(id);
    const assertCurrent = () => generationAttemptsRef.current.assert(id, attempt);
    let node = nodesRef.current.find((item) => item.id === id);
    if (isImageProcess(node)) return runImageProcess(id);
    if (!['customWorkflow', 'swap', 'upscale', 'imageUpscale', 'videoSuperResolution'].includes(node?.data.mode) && !node?.data.prompt?.trim()) { updateNode(id, { status: 'error', error: '请先输入画面描述。' }); return; }
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
    if (node.data.mode === 'qwenEdit') {
      try { validateQwenReferences(refs); compileQwenPrompt(node.data.prompt, refs); validateCanvasMask(node, nodesRef.current, edgesRef.current); }
      catch (error) { updateNode(id, { status: 'error', error: error.message }); return; }
    }
    if (node.data.mode === 'reference' && !refs.length) { updateNode(id, { status: 'error', error: '全能参考至少需要一个素材；仅用文字生成时，可切换到首尾帧并留空图片。' }); return; }
    if (node.data.mode === 'swap' && (!refs.some((ref) => ref.data.slot === 'guide') || !refs.some((ref) => ref.data.slot === 'identity'))) { updateNode(id, { status: 'error', error: '请连接源视频到上方端口、单人身份图到下方端口。' }); return; }
    if (node.data.mode === 'videoSuperResolution' && !refs.some(ref => ref.data.slot === 'guide' && ref.data.kind === 'video')) { updateNode(id, { status: 'error', error: '请连接源视频后再超分。' }); return; }
    if (node.data.mode === 'upscale' && !refs.some((ref) => ref.data.slot === 'guide')) { updateNode(id, { status: 'error', error: '请把已经生成的一采视频连接到高清二采节点上方端口。' }); return; }
    if (node.data.mode === 'imageUpscale' && !refs.some((ref) => ref.data.slot === 'guide')) { updateNode(id, { status: 'error', error: '请把一张图片连接到图片高清节点左侧端口。' }); return; }
    if (['identityEdit', 'characterSheet', 'localRealism'].includes(node.data.mode) && !refs.some((ref) => ref.data.slot === 'guide')) { updateNode(id, { status: 'error', error: node.data.mode === 'characterSheet' ? '请把一张单人角色参考图连接到角色四视图节点左侧端口。' : '请把一张人物或场景母图连接到图生图节点左侧端口。' }); return; }
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
      const mask = node.data.mode === 'qwenEdit' ? validateCanvasMask(node, nodesRef.current, edgesRef.current) : null;
      for (const mediaNode of [...refs, ...(mask ? [mask] : [])]) {
        const name = await upload(mediaNode);
        assertCurrent();
        references.push({ id: mediaNode.id, kind: mediaNode.data.kind, title: mediaNode.data.title, slot: mediaNode.data.slot, name });
      }
      const seed = node.data.randomSeed ? Math.floor(Math.random() * 2147483647) : Number(isH3Image(node.data) ? node.data.seed ?? 42 : node.data.seed || 42);
      const options = { ...node.data, seed, references };
      updateNode(id, { status: 'queued', stage: '任务已排队', seed });
      let plan = node.data.mode === 'characterSheet' ? buildCharacterSheetQueuePlan(options) : node.data.mode === 'outfitEdit' ? buildOutfitQueuePlan(options) : null;
      let preparedExtension;
      if (node.data.mode === 'customWorkflow') {
        preparedExtension = await prepareExtension(node.data, Object.fromEntries(references.map((ref) => [ref.slot, ref.name])));
        assertCurrent();
        if (Boolean(preparedExtension.workflow) === Boolean(preparedExtension.plan)) throw new Error('工作流准备结果无效：需要一个图片工作流或分阶段计划。');
        plan = preparedExtension.plan || null;
        updateNode(id, { workflowOutputs: preparedExtension.outputs });
      }
      const workflow = preparedExtension ? preparedExtension.workflow || null : plan ? null : node.data.mode === 'qwenEdit' ? buildQwen21EditWorkflow(options)
          : node.data.mode === 'localRealism' ? buildLocalRealismWorkflow(options)
          : node.data.mode === 'identityEdit' ? buildIdentityEditWorkflow(options)
            : node.data.mode === 'image' ? buildImageWorkflow(options)
              : node.data.mode === 'imageUpscale' ? buildImageHdWorkflow(options)
                : node.data.mode === 'swap' ? buildCharacterSwapWorkflow(options)
                  : node.data.mode === 'upscale' ? buildHdRefineWorkflow(options)
                  : node.data.mode === 'videoSuperResolution' ? buildVideoSuperResolutionWorkflow(options)
                    : node.data.mode === 'reference' ? buildReferenceWorkflow(options)
                      : buildWorkflow({ ...options, firstFrame: references.find((ref) => ref.slot === 'first')?.name, lastFrame: references.find((ref) => ref.slot === 'last')?.name });
      if ((node.data.mode === 'image' && node.data.imageModel === 'flux3_klein') || (node.data.mode === 'qwenEdit' && node.data.qwenModel === 'flux3_klein')) {
        updateNode(id, { stage: '正在检查 FLUX 3 Klein 模型与节点依赖' });
        const dependencies = await getFlux3KleinDependencyStatus(workflow);
        assertCurrent();
        if (!dependencies.ready) throw new Error(`FLUX 3 Klein 还缺少：${dependencies.missing.join('、')}。请补齐模型并更新 ComfyUI 后再生成。`);
      }
      if (isH3Image(node.data)) {
        updateNode(id, { stage: '正在检查 H3-Image 模型与节点依赖' });
        const dependencies = await getH3ImageDependencyStatus(workflow);
        assertCurrent();
        if (!dependencies.ready) throw new Error(`H3-Image 还缺少：${dependencies.missing.join('、')}。请在画布连接的 ComfyUI 中安装对应模型，更新到支持 MiniMaxH3ImageConditioning 的版本后再生成；仅在另一个后台安装并不会生效。`);
      }
      if (node.data.mode === 'videoSuperResolution') {
        const dependencies = await getVideoSuperResolutionDependencyStatus(workflow, comfyFetch);
        assertCurrent();
        if (!dependencies.ready) throw new Error(`视频超分缺少本机依赖：${dependencies.missing.join('、')}。请补齐后重试；未提交生成。`);
      }
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
  }, [clientId, getReferences, project.id, project.readOnly, updateNode, runImageProcess]);

  const cancelNode = useCallback(async (id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (localImageJobsRef.current.has(id)) { localImageJobsRef.current.get(id).abort(); return; }
    const cancelledAttempt = generationAttemptsRef.current.cancel(id);
    try {
      await cancelGeneration(node?.data);
      if (generationAttemptsRef.current.isCurrent(id, cancelledAttempt)) updateNode(id, { status: 'cancelled', stage: '已取消', progress: 0, queueJobId: null, promptId: null });
    } catch (error) {
      if (generationAttemptsRef.current.isCurrent(id, cancelledAttempt)) updateNode(id, { status: 'error', error: error.message });
    }
  }, [updateNode]);

  const applyHistory = useCallback((direction) => {
    if (project.readOnly || switchingRef.current || interactionRef.current || nodesRef.current.some((node) => node.dragging || node.resizing)) return false;
    if (mediaWritesRef.current.size) { setProjectError('素材正在保存，请完成后再撤销或重做。'); return false; }
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
    if (!clipboard?.nodes?.length || switchingRef.current || project.readOnly) return false;
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
  }, [fitView, setNodes, setEdges, project.readOnly]);

  useEffect(() => {
    const onCanvasShortcut = (event) => {
      if (imagePreview || workflowInspection || libraryModalOpen || switchingRef.current || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
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
  }, [applyHistory, copySelectedNodes, pasteClipboard, imagePreview, workflowInspection, libraryModalOpen]);

  const addNode = useCallback((type, extra = {}, atPosition = null, shouldFocus = true) => {
    if (project.readOnly) throw new Error('当前画布为只读，不能添加节点。');
    if (switchingRef.current) throw new Error('正在保存并切换项目，请稍后再添加节点。');
    const desired = atPosition || screenToFlowPosition({ x: window.innerWidth * 0.45, y: window.innerHeight * 0.35 });
    const id = uid(type);
    let data;
    if (type === 'generator') data = { ...DEFAULT_GENERATOR, ...extra };
    else if (type === 'artDirector') data = { title: '电子主美 · 图解分析', status: 'idle', brief: '', preserve: '', referencePurposes: {}, ...extra };
    else if (type === 'imageProcess') data = { ...DEFAULT_ADJUSTMENTS, adjustmentType: 'basic', mode: 'colorAdjust', title: '颜色调整', status: 'idle', blendMode: 'normal', opacity: 100, fit: 'cover', maskChannel: 'luminance', maskInvert: false, ...extra };
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
  }, [screenToFlowPosition, setNodes, fitView, project.readOnly]);

  const addQwenMask = useCallback((id) => {
    if (project.readOnly || switchingRef.current) return;
    const target = nodesRef.current.find((node) => node.id === id);
    if (target?.data.mode !== 'qwenEdit' || ['uploading', 'queued', 'running', 'finishing'].includes(target.data.status)) return;
    const existing = getQwenMask(id);
    if (existing) { fitView({ nodes: [{ id: existing.id }], duration: 300, maxZoom: 1 }); return; }
    const guide = qwenCanvasReferences(target, nodesRef.current, edgesRef.current)[0];
    if (!guide?.data.url) { updateNode(id, { error: '请先连接图1作为修改底图。' }); return; }
    const maskId = addNode(...NODE_PRESETS.local_mask, { x: target.position.x - 370, y: target.position.y + 350 });
    setEdges((items) => items.concat([
      { id: `edge-${guide.id}-${maskId}-guide`, source: guide.id, sourceHandle: 'ref', target: maskId, targetHandle: 'guide' },
      { id: `edge-${maskId}-${id}-mask`, source: maskId, sourceHandle: 'mask', target: id, targetHandle: 'mask' },
    ]));
  }, [project.readOnly, addNode, getQwenMask, fitView, setEdges, updateNode]);

  const openReferenceLibrary = useCallback((library = 'refmuse') => {
    if (catalogBusyRef.current) throw new Error('节点正在导入，请先完成依赖检查。');
    if (workflowLibraryOpen) throw new Error('请先关闭本地工作流窗口，再打开参考库。');
    if (referenceImportBusyRef.current) throw new Error('参考图正在导入，请等待保存完成后再切换参考库。');
    if (switchingRef.current) throw new Error('正在切换项目，请稍后打开参考库。');
    if (!Object.hasOwn(REFERENCE_LIBRARIES, library)) throw new Error('未知参考库。');
    flushSync(() => { setNodeLibraryOpen(false); setReferenceLibraryTab(library); setReferenceLibrary(library); });
    return { opened: true, container: 'current-canvas-modal', library, sourceUrl: REFERENCE_LIBRARIES[library].url, remoteContentVerified: false };
  }, [workflowLibraryOpen]);
  const assertExtensionWritable = useCallback(() => {
    if (projectRef.current.readOnly || switchingRef.current || autoSaveRef.current?.conflict) throw new Error('当前画布不可写，请先处理保存冲突或项目切换。');
  }, []);
  const addImportedExtension = useCallback(async (bundle, definitionId, parameters = {}, report = null, existingId = null) => {
    assertExtensionWritable();
    const data = extensionNodeData(bundle, definitionId);
    data.workflowParameters = { ...data.workflowParameters, ...parameters };
    data.dependencyWarning = report && !report.ready ? '工作流依赖未就绪，请点击检查依赖补齐后再运行。' : '';
    const request = catalogRequestRef.current;
    const targetId = existingId || request?.addedId;
    if (targetId) {
      const target = nodesRef.current.find((node) => node.id === targetId);
      if (!target || ['uploading', 'queued', 'running', 'finishing'].includes(target.data.status)) throw new Error('节点已删除或正在运行，请稍后再修改依赖。');
      flushSync(() => updateNode(targetId, { workflowParameters: data.workflowParameters, dependencyWarning: data.dependencyWarning, error: null }));
    } else {
      let addedId;
      flushSync(() => { addedId = addNode('generator', data); });
      if (request) {
        request.addedId = addedId;
        catalogSaveRetriesRef.current.set(`${projectRef.current.id}:${bundle.digest}`, addedId);
      }
    }
    await persistProject(Boolean(targetId));
    catalogSaveRetriesRef.current.delete(`${projectRef.current.id}:${bundle.digest}`);
  }, [assertExtensionWritable, addNode, updateNode, persistProject]);
  const importCatalogNode = useCallback(async (selection) => {
    assertExtensionWritable();
    if (catalogBusyRef.current) throw new Error('另一项节点导入尚未结束，请先完成当前检查。');
    catalogBusyRef.current = true;
    const projectId = projectRef.current.id;
    const operation = { addedId: null, resolve: null, reject: null };
    catalogRequestRef.current = operation;
    try {
      const bundle = await importCatalogExtension(selection);
      assertExtensionWritable();
      if (projectRef.current.id !== projectId) throw new Error('当前项目已改变，尚未添加节点。');
      const retryKey = `${projectId}:${bundle.digest}`;
      const retryId = catalogSaveRetriesRef.current.get(retryKey);
      if (retryId && nodesRef.current.some((node) => node.id === retryId && node.data.extensionDigest === bundle.digest)) {
        // A failed save leaves the original node visible. A new catalog request
        // retries that save instead of inserting a second copy of the package.
        operation.addedId = retryId;
        await persistProject(true);
        catalogSaveRetriesRef.current.delete(retryKey);
        return;
      }
      catalogSaveRetriesRef.current.delete(retryKey);
      const definitionId = bundle.nodes[0]?.definition.nodeDefinitionId;
      if (!definitionId) throw new Error('节点包没有可用节点。');
      let report;
      try { report = await extensionDependencies(bundle.digest, definitionId); } catch { /* The review dialog exposes check errors and retry. */ }
      assertExtensionWritable();
      if (bundle.nodes.length === 1 && report?.ready) await addImportedExtension(bundle, definitionId, {}, report);
      else await new Promise((resolve, reject) => { operation.resolve = resolve; operation.reject = reject; setDependencyRequest({ bundle, report, projectId }); });
    } finally {
      if (catalogRequestRef.current === operation) catalogRequestRef.current = null;
      catalogBusyRef.current = false;
    }
  }, [assertExtensionWritable, addImportedExtension, persistProject]);
  const closeDependencies = useCallback(() => {
    setDependencyRequest(null);
    catalogRequestRef.current?.reject?.(new Error('已取消添加节点。'));
  }, []);
  const checkNodeDependencies = useCallback(async (id) => {
    try {
      assertExtensionWritable();
      if (catalogBusyRef.current || dependencyRequest) throw new Error('请先完成当前依赖检查。');
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node || node.data.mode !== 'customWorkflow') return;
      const bundle = await getExtension(node.data.extensionDigest);
      const selected = bundle.nodes.find((entry) => entry.definition.nodeDefinitionId === node.data.nodeDefinitionId);
      if (!selected) throw new Error('节点定义已缺失。');
      setDependencyRequest({ bundle: { ...bundle, nodes: [selected] }, parameters: node.data.workflowParameters, existingId: id, projectId: projectRef.current.id });
    } catch (error) { updateNode(id, { error: error.message }); }
  }, [assertExtensionWritable, dependencyRequest, updateNode]);
  const openNodeShare = useCallback((id) => {
    try {
      assertExtensionWritable();
      const node = nodesRef.current.find((item) => item.id === id);
      if (!node) throw new Error('节点不存在。');
      if (['uploading', 'queued', 'running', 'finishing'].includes(node.data.status)) throw new Error('请等待当前节点运行结束后再上传。');
      const references = getReferences(id);
      const mask = node.data.mode === 'qwenEdit' ? validateCanvasMask(node, nodesRef.current, edgesRef.current) : null;
      const source = shareSource(node, [...references, ...(mask ? [mask] : [])]);
      updateNode(id, { shareError: '', ...(resolvedLegacyShareError(node.data) ? { error: '' } : {}) });
      const result = [...nodesRef.current].reverse().find((item) => item.data.kind === 'image' && item.data.sourceGeneratorId === id && item.data.url);
      const guide = references.find((item) => item.data.kind === 'image' && (node.data.mode === 'qwenEdit' || item.data.slot === 'guide') && item.data.url);
      const thumbnail = node.data.resultUrl ? { url: node.data.resultUrl, title: '当前生成结果' }
        : result ? { url: result.data.url, title: '最近生成结果' }
          : guide ? { url: guide.data.url, title: '输入参考图（尚无生成结果）' } : null;
      setNodeShare({ source, projectId: projectRef.current.id, nodeId: id, suggestedMetadata: suggestShareMetadata(node, source), thumbnail, title: node.data.title, staged: node.data.mode === 'characterSheet' || node.data.workflowDefinition?.execution?.kind === 'characterSheet' });
    } catch (error) { updateNode(id, { shareError: error.message }); }
  }, [assertExtensionWritable, getReferences, updateNode]);
  useEffect(() => () => { catalogRequestRef.current?.reject?.(new Error('画布已关闭，导入未完成。')); }, []);
  const importReference = useCallback(async (file, library, reference = null) => {
    if (referenceImportBusyRef.current) throw new Error('另一张参考图正在导入。');
    referenceImportBusyRef.current = true;
    try {
    if (project.readOnly || switchingRef.current) throw new Error('当前画布无法导入素材。');
    if (!Object.hasOwn(REFERENCE_LIBRARIES, library) || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择单张 PNG、JPEG 或 WebP 图片。');
    // Decode the local selection before making a node; an extension alone is not an image.
    const bitmap = await createImageBitmap(file); bitmap.close();
    if (project.readOnly || switchingRef.current) throw new Error('当前画布无法导入素材。');
    let id;
    flushSync(() => { id = addNode('image', { title: reference?.title || file.name.replace(/\.[^.]+$/, '') || file.name }, null, false); });
    const uploaded = await chooseMedia(id, file, { library, homepage: REFERENCE_LIBRARIES[library].url, attribution: 'user-selected-library', ...(reference || {}) });
    if (!uploaded?.ok || !nodesRef.current.find((node) => node.id === id)?.data.assetPath) {
      removeNode(id);
      throw uploaded?.error || new Error('素材未保存，请重试。');
    }
    try { await persistProject(); }
    catch (error) { throw new Error(`素材已上传，但画布尚未保存：${error.message || '请关闭参考库后重试画布保存。'}`); }
    } finally { referenceImportBusyRef.current = false; }
  }, [project.readOnly, addNode, chooseMedia, removeNode, persistProject]);

  useEffect(() => {
    const onPaste = (event) => {
      if (project.readOnly || imagePreview || workflowInspection || libraryModalOpen || switchingRef.current) return;
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
  }, [addNode, chooseMedia, imagePreview, workflowInspection, libraryModalOpen, pasteClipboard, screenToFlowPosition, project.readOnly]);

  const attachFilesToGenerator = useCallback((generatorId, files, targetHandle = 'references') => {
    const generator = nodesRef.current.find((node) => node.id === generatorId);
    if (!generator || projectRef.current.readOnly || switchingRef.current || autoSaveRef.current?.conflict || ['uploading', 'queued', 'running', 'finishing'].includes(generator.data.status)) return;
    const videoGuide = generator.data.mode === 'videoSuperResolution' && targetHandle === 'guide';
    if (targetHandle !== 'references' && !videoGuide) return;
    const selected = Array.from(files || []);
    if (videoGuide && (selected.length !== 1 || !selected[0].type.startsWith('video/'))) {
      updateNode(generatorId, { status: 'error', error: '请选择一段视频作为超分输入。' });
      return;
    }
    selected.forEach((file, index) => {
      const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image';
      const position = { x: generator.position.x - 330, y: generator.position.y + index * 215 - 60 };
      const id = addNode(kind, { title: file.name.replace(/\.[^.]+$/, '') }, position);
      chooseMedia(id, file);
      setEdges((items) => addEdge({ id: `edge-${id}-${generatorId}`, source: id, target: generatorId, sourceHandle: 'ref', targetHandle }, videoGuide ? items.filter(edge => edge.target !== generatorId || edge.targetHandle !== 'guide') : items));
    });
  }, [addNode, chooseMedia, setEdges, updateNode]);

  const importVideoReference = useCallback(async (url, downloadNodeId = null) => {
    if (switchingRef.current || projectRef.current.readOnly || autoSaveRef.current?.conflict) throw new Error('当前画布不可写，请先处理保存状态后重试。');
    if (videoImportBusyRef.current) throw new Error('另一段视频正在下载或保存，请完成后再导入。');
    const projectId = projectRef.current.id;
    const source = downloadNodeId ? nodesRef.current.find((node) => node.id === downloadNodeId)
      : nodesRef.current.find((node) => node.type === 'generator' && node.selected) || nodesRef.current.find((node) => node.type === 'generator');
    if (!source) throw new Error(downloadNodeId ? '视频下载节点已不存在。' : '请先在画布中添加一个生成节点。');
    const mode = source.data.mode || 'reference';
    const targetHandle = mode === 'swap' ? 'guide' : 'references';
    const validateTarget = () => {
      const current = nodesRef.current.find((node) => node.id === source.id);
      if (!current) throw new Error('下载入口或目标节点已删除，尚未添加视频。');
      if (downloadNodeId) return { current, videoCount: 0 };
      if (!['reference', 'swap'].includes(mode) || (current.data.mode || 'reference') !== mode) throw new Error('请使用全能参考或角色替换模式，下载期间不要改变目标模式。');
      if (['uploading', 'queued', 'running', 'finishing'].includes(current.data.status)) throw new Error('目标正在生成，请完成后再导入视频。');
      const videoCount = edgesRef.current.filter((edge) => edge.target === current.id && edge.targetHandle === targetHandle)
        .map((edge) => nodesRef.current.find((node) => node.id === edge.source)).filter((node) => node?.data.kind === 'video').length;
      if (videoCount >= (mode === 'swap' ? 1 : 3)) throw new Error(mode === 'swap' ? '角色替换已连接源视频，请先移除原连线再导入。' : '每个全能参考节点最多连接 3 段视频。');
      return { current, videoCount };
    };
    validateTarget();
    const operation = { id: uid('video-import'), projectId };
    videoImportBusyRef.current = operation;
    autoSaveRef.current?.suspend();
    setSaveState('保存中');
    const pending = (async () => {
      const result = await importVideoFromUrl(url);
      if (videoImportBusyRef.current !== operation || projectRef.current.id !== projectId || switchingRef.current || projectRef.current.readOnly || autoSaveRef.current?.conflict) throw new Error('当前画布已改变或不可写，尚未添加视频。');
      const { current, videoCount } = validateTarget();
      const remoteName = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
      const position = downloadNodeId ? { x: current.position.x + 360, y: current.position.y }
        : { x: current.position.x - 340, y: current.position.y + 220 + videoCount * 210 };
      let id;
      flushSync(() => {
        id = addNode('video', { title: result.title || (downloadNodeId ? '下载的视频' : '在线视频参考'), name: result.name, remoteName,
          url: remoteMediaUrl(remoteName), sourceUrl: result.sourceUrl || url, localFile: false }, position);
        if (!downloadNodeId) setEdges((items) => addEdge({ id: `edge-${id}-${current.id}`, source: id, target: current.id, sourceHandle: 'ref', targetHandle }, items));
      });
      return id;
    })();
    mediaWritesRef.current.set(operation.id, pending);
    try {
      const id = await pending;
      // Remove our own barrier before flushing, otherwise the flush awaits itself.
      mediaWritesRef.current.delete(operation.id);
      try { await persistProject(); }
      catch (error) { throw new Error(`视频已下载并保留在画布，但尚未保存：${error.message}。请重试保存，不要重复下载。`); }
      return id;
    } finally {
      mediaWritesRef.current.delete(operation.id);
      if (videoImportBusyRef.current === operation) {
        videoImportBusyRef.current = null;
        autoSaveRef.current?.observe(nameRef.current, { nodes: nodesRef.current, edges: edgesRef.current, viewport: viewportRef.current }, { defer: mediaWritesRef.current.size > 0 || interactionRef.current });
      }
    }
  }, [addNode, setEdges, persistProject]);

  const changeQwenReferences = useCallback((id, sourceId, direction) => {
    if (switchingRef.current || project.readOnly) return;
    const node = nodesRef.current.find((item) => item.id === id);
    if (node?.data.mode !== 'qwenEdit' || ['uploading', 'queued', 'running', 'finishing'].includes(node.data.status)) return;
    const refs = qwenCanvasReferences(node, nodesRef.current, edgesRef.current);
    const order = refs.map((ref) => ref.id), index = order.indexOf(sourceId);
    if (index < 0) return;
    if (direction) {
      const to = index + direction;
      if (to < 0 || to >= order.length) return;
      if (node.data.qwenSourceCrop && (index === 0 || to === 0)) { updateNode(id, { error: '图1已设置单格裁切，请先清除裁切再改变首图。' }); return; }
      [order[index], order[to]] = [order[to], order[index]];
    }
    if (!direction && index === 0 && node.data.qwenSourceCrop) { updateNode(id, { error: '图1已设置单格裁切，请先清除裁切再断开首图。' }); return; }
    updateNode(id, { prompt: bindQwenPrompt(node.data.prompt || '', refs), qwenReferenceOrder: order });
    if (!direction) setEdges((items) => items.filter((edge) => !(edge.target === id && edge.source === sourceId && ['guide', 'identity', 'references'].includes(edge.targetHandle))));
  }, [project.readOnly, setEdges, updateNode]);

  const [connectionNotice, setConnectionNotice] = useState('');
  const [connecting, setConnecting] = useState(false);
  const flowStore = useStoreApi();
  const clickConnection = useRef(null);
  useEffect(() => {
    if (!connectionNotice) return undefined;
    const timer = setTimeout(() => setConnectionNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [connectionNotice]);
  useEffect(() => {
    const cancel = (event) => {
      if (event.key !== 'Escape' || (!connecting && !clickConnection.current)) return;
      flowStore.getState().cancelConnection();
      flowStore.setState({ connectionClickStartHandle: null });
      clickConnection.current = null;
      setConnecting(false); setConnectionNotice('');
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [connecting, flowStore]);
  const connectionPlan = useCallback((connection) => planCanvasConnection(connection, nodesRef.current, edgesRef.current, { readOnly: project.readOnly, switching: switchingRef.current }), [project.readOnly]);
  const onConnect = useCallback((connection) => {
    const plan = connectionPlan(connection);
    if (plan.error) { setConnectionNotice(plan.error); return { error: plan.error }; }
    const { source, target, multiple, existing, resolvedFrom } = plan;
    if (clickConnection.current) clickConnection.current.connected = true;
    if (existing) { setConnectionNotice('此素材已连接。'); return { edgeId: existing.id, ...plan.connection }; }
    const edge = { ...plan.connection, id: `edge-${source.id}-${target.id}-${plan.connection.targetHandle}-${Date.now()}` };
    if (target.data.mode === 'qwenEdit' && edge.targetHandle === 'references') {
      const nextRefs = [...qwenCanvasReferences(target, nodesRef.current, edgesRef.current), source];
      updateNode(target.id, { prompt: bindQwenPrompt(target.data.prompt || '', nextRefs), qwenReferenceOrder: nextRefs.map((ref) => ref.id), error: null });
    }
    setEdges((items) => addEdge(edge, items.filter((item) => multiple || (!(item.target === target.id && item.targetHandle === edge.targetHandle) && !(source.type === 'prompt' && item.source === source.id && item.sourceHandle === 'prompt')))));
    setConnectionNotice(resolvedFrom ? '已连接当前成品素材；重新生成不会替换此参考。' : '');
    return { edgeId: edge.id, ...plan.connection };
  }, [connectionPlan, setEdges, updateNode]);
  const onConnectEnd = useCallback((_event, state) => {
    setConnecting(false);
    if (state.isValid || !state.fromHandle) return;
    const from = state.fromHandle, to = state.toHandle;
    if (!to) { setConnectionNotice('请将连线拖到目标节点的输入圆点；也可以依次点击两个圆点连接。'); return; }
    const source = from.type === 'source' ? from : to;
    const target = from.type === 'target' ? from : to;
    const plan = connectionPlan({ source: source.nodeId, sourceHandle: source.id, target: target.nodeId, targetHandle: target.id });
    setConnectionNotice(plan.error || '请连接一个输出端口和一个输入端口。');
  }, [connectionPlan]);
  const onClickConnectEnd = useCallback((event) => {
    setConnecting(false);
    const from = clickConnection.current;
    clickConnection.current = null;
    if (!from || from.connected) return;
    const element = event.target.closest('.react-flow__handle');
    if (!element) return;
    const to = { nodeId: element.dataset.nodeid, handleId: element.dataset.handleid, handleType: element.classList.contains('source') ? 'source' : 'target' };
    const source = from.handleType === 'source' ? from : to, target = from.handleType === 'target' ? from : to;
    const plan = connectionPlan({ source: source.nodeId, sourceHandle: source.handleId, target: target.nodeId, targetHandle: target.handleId });
    setConnectionNotice(plan.error || '请连接一个输出端口和一个输入端口。');
  }, [connectionPlan]);

  const attachImageProcessInput = useCallback(async (id, slot, file) => {
    assertExtensionWritable();
    if (referenceImportBusyRef.current || localImageJobsRef.current.has(id)) throw new Error('请等待当前处理完成。');
    const target = nodesRef.current.find((node) => node.id === id);
    if (!isImageProcess(target) || !imageProcessPorts(target.data.mode).includes(slot)) throw new Error('输入节点或通道已不存在。');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
    referenceImportBusyRef.current = true;
    let sourceId;
    try {
      flushSync(() => { sourceId = addNode('image', { title: slot === 'mask' ? '混合遮罩' : `${{ red: 'R', green: 'G', blue: 'B', alpha: 'A' }[slot] || slot} 通道贴图` }, { x: target.position.x - 420, y: target.position.y + 400 }, false); });
      const uploaded = await chooseMedia(sourceId, file);
      if (!uploaded?.ok) throw new Error(uploaded?.error?.message || '贴图保存失败。');
      assertExtensionWritable();
      if (!nodesRef.current.some((node) => node.id === id)) throw new Error('处理节点已不存在，贴图已保留为素材。');
      flushSync(() => { onConnect({ source: sourceId, target: id, targetHandle: slot }); });
      if (!edgesRef.current.some((edge) => edge.source === sourceId && edge.target === id && edge.targetHandle === slot)) throw new Error('贴图未连接，素材已保留。');
      await persistProject();
      return { ok: true, nodeId: sourceId };
    } catch (error) {
      if (sourceId && !nodesRef.current.find((node) => node.id === sourceId)?.data.assetPath) removeNode(sourceId);
      throw error;
    } finally { referenceImportBusyRef.current = false; }
  }, [assertExtensionWritable, addNode, chooseMedia, onConnect, persistProject, removeNode]);

  const disconnectImageProcessInput = useCallback((id, slot) => {
    assertExtensionWritable();
    if (localImageJobsRef.current.has(id) || referenceImportBusyRef.current) return;
    setEdges((items) => items.filter((edge) => !(edge.target === id && edge.targetHandle === slot)));
  }, [assertExtensionWritable, setEdges]);

  const attachImageProcessMask = useCallback((id, file) => attachImageProcessInput(id, 'mask', file), [attachImageProcessInput]);
  const disconnectImageProcessMask = useCallback((id) => disconnectImageProcessInput(id, 'mask'), [disconnectImageProcessInput]);

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
    const heightOf = (node) => node.type === 'artDirector' ? 1450 : node.type === 'imageProcess' ? 1000 : node.type === 'generator' ? 360 : node.type === 'prompt' ? 390 : node.type === 'note' ? 250 : 260;
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
    if (project.readOnly || switchingRef.current) return;
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
    if (node.data.output && node.data.filename) return outputFileLocation(node.data);
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
      const inspectable = canInspectNode(node);
      setNodeMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 238)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - (inspectable ? 200 : 135))),
        nodeId: node.id, title: node.data.title || '节点', file: nodeFileLocation(node), inspectable, status: 'idle', error: null,
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
  const artDirector = useArtDirector({ project, projectRef, switchingRef, nodes, edges, nodesRef, edgesRef, setNodes, setEdges, updateNode, addNode, chooseMedia, saveCanvasAsset, persistProject, localImageJobsRef, setLocalImageJobsVersion, mediaWritesRef, assetUrl, findFreePosition, uid, onConnect });
  artRunRef.current = (id) => { const state = artDirector.getArtDirectorState(id); return state.node?.data.analysis?.sourceVersion === state.signature ? artDirector.exportArtBoard(id) : artDirector.runArtAnalysis(id); };
  const context = useMemo(() => ({ ...artDirector, updateNode, removeNode, chooseMedia, togglePin, generateNode, cancelNode, serverOnline: server.online, getReferences, getMaskGuide, getMentionItems, getPromptTarget, optimizePromptNode, attachFilesToGenerator, importVideoReference, openImagePreview: setImagePreview, openNodeShare, checkNodeDependencies, changeQwenReferences, addQwenMask, getQwenMask, disconnectEdge, viewTier, runImageProcess, isImageProcessBusy, getImageProcessState, getImageProcessMask, attachImageProcessInput, disconnectImageProcessInput, attachImageProcessMask, disconnectImageProcessMask, readOnly: project.readOnly }), [artDirector, updateNode, removeNode, chooseMedia, togglePin, generateNode, cancelNode, server.online, getReferences, getMaskGuide, getMentionItems, getPromptTarget, optimizePromptNode, attachFilesToGenerator, importVideoReference, openNodeShare, checkNodeDependencies, changeQwenReferences, addQwenMask, getQwenMask, disconnectEdge, viewTier, edges, nodes, runImageProcess, isImageProcessBusy, localImageJobsVersion, getImageProcessState, getImageProcessMask, attachImageProcessInput, disconnectImageProcessInput, attachImageProcessMask, disconnectImageProcessMask, project.readOnly]);
  const inspectNode = useCallback((nodeId, stage) => new Promise((resolve, reject) => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) { reject(new Error('找不到要查看的节点。')); return; }
    const request = { nonce: crypto.randomUUID(), nodeId, title: node.data.title, stage, resolve, reject };
    try { request.query = inspectionQuery(project.id, node, edgesRef.current); }
    catch (error) { request.error = error.message; }
    setWorkflowInspection(request);
  }), [project.id]);
  const moveNodes = (moves) => {
    if (project.readOnly || switchingRef.current) throw new Error('当前画布不可编辑。');
    const next=moveSpecifiedNodes(nodesRef.current,moves);
    historyRef.current.observe(nodesRef.current,edgesRef.current);
    nodesRef.current=next;setNodes(next);historyRef.current.observe(next,edgesRef.current);
    return moves.map(({nodeId})=>next.find(n=>n.id===nodeId));
  };
  useCanvasMcp({
    nodesRef, edgesRef, projectName, projectId: project.id, readOnly: project.readOnly, server,
    actions: { moveNodes, addNode, createExtensionNode: async (digest, nodeDefinitionId, position, focus) => {
      if (workflowLibraryOpen || switchingRef.current || project.readOnly) throw new Error('请关闭本地工作流窗口，并确认当前画布可写后再添加节点。');
      const bundle = await getExtension(digest);
      if (switchingRef.current || project.readOnly) throw new Error('当前画布不可写。');
      return addNode('generator', extensionNodeData(bundle, nodeDefinitionId), position, focus);
    }, updateNode, removeNode, onConnect, generateNode, cancelNode, tidyCanvas, focusNode, inspectNode, openReferenceLibrary, persistProject, retryProjectSave,
      prepareProjectSwitch, commitProjectSwitch, abandonProjectSwitch,
      importAsset: async (nodeId, assetPath, name, sourceProjectId) => {
        if (switchingRef.current || project.readOnly) throw new Error('当前项目无法导入素材。');
        const file = await readProjectFile({ id: sourceProjectId || project.id }, nodeId, assetPath);
        if (!file) throw new Error('当前项目素材不存在。');
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node || node.type !== 'media' || !file.type.startsWith(`${node.data.kind}/`)) throw new Error('素材类型与当前节点不匹配。');
        const imported = await chooseMedia(nodeId, new File([file], name || file.name, { type: file.type }));
        if (!imported?.ok) throw new Error(imported?.error?.message || '素材导入失败。');
        await persistProject();
      },
    },
  });
  const connectionPresentation = localConnectionPresentation(server, starting);
  const dropCanvasFiles = (e) => {
    e.preventDefault();
    if (project.readOnly || switchingRef.current) return;
    const dropped = [...(e.dataTransfer.files || [])];
    if (dropped.filter(file => /\.pur$/i.test(file.name)).length > 1) { setProjectError('请每次导入一个 PureRef 文件。'); return; }
    dropped.forEach((file, index) => {
      const position = screenToFlowPosition({ x: e.clientX + index * 25, y: e.clientY + index * 25 });
      if (/\.pur$/i.test(file.name)) { openPureRefImport(file, position); return; }
      const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image';
      const id = addNode(kind, { title: file.name.replace(/\.[^.]+$/, '') }, position); chooseMedia(id, file);
    });
  };
  const pinnedNodes = nodes.filter((node) => node.data.pinned);
  const vramPercent = metrics.vramTotal ? Math.min(100, Math.max(0, metrics.vramUsed / metrics.vramTotal * 100)) : 0;
  const cpuPercent = Number.isFinite(metrics.cpuPercent) ? Math.min(100, Math.max(0, metrics.cpuPercent)) : 0;
  return <NodeContext.Provider value={context}>
    <div className="neo-app">
      <header className="neo-header" inert={libraryModalOpen ? true : undefined}>
        {onLauncher && <button className="launcher-return" disabled={projectBusy || hasActiveTask()} onClick={async () => {
          if (switchingRef.current) return;
          switchingRef.current = true; setProjectBusy(true);
          try { await persistProject(); await closeProject(project.id); onLauncher(); }
          catch (error) { setProjectError(error.message || '保存或关闭失败，当前项目已保留。'); }
          finally { switchingRef.current = false; setProjectBusy(false); }
        }} title="返回项目启动器"><FolderOpen size={15} /><span>项目</span></button>}
        <CanvasProjectMenu current={project} projects={projects} name={projectName} onNameChange={setProjectName}
          saveState={saveState} error={[projectError, projectConnectionError].filter(Boolean).join('\n')} busy={projectBusy || project.readOnly} locked={hasActiveTask()}
          onRetry={() => retryProjectSave().catch(() => {})} onSnapshot={downloadLocalSnapshot} onReload={reloadProject}
          conflicted={Boolean(autoSaveRef.current?.conflict)}
          onRefresh={refreshProjects} onOpen={(id) => changeProject(id)} onCreate={(name) => changeProject(null, name)} />
        <div className="neo-header-right">
          <div className="neo-header-actions">
            <button onClick={() => openReferenceLibrary(referenceLibraryTab || 'refmuse')}><Library size={15} /><span>Refmuse参考库</span></button>
            <button onClick={() => {
              if (referenceImportBusyRef.current || catalogBusyRef.current || switchingRef.current) return;
              setReferenceLibrary(null); setNodeLibraryMounted(true); setNodeLibraryOpen((value) => !value);
              setCreativeOpen(false); setHandoffOpen(false); setWorkflowInspection(null); setImagePreview(null); setLibraryOpen(false); setPinOpen(false); setAddMenu(null); setNodeMenu(null);
            }}><Layers3 size={15} /><span>节点库</span></button>
            <button className={creativeOpen ? 'active' : ''} onClick={() => setCreativeOpen(!creativeOpen)} title="角色、镜头与审片"><Film size={15} /><span>创作</span></button>
            <button className={handoffOpen ? 'active' : ''} disabled={project.readOnly} onClick={() => setHandoffOpen(true)} title="保存目标、验收结论并切换 Agent"><Link2 size={15} /><span>接力{project.settings?.handoff?.status === 'paused' ? ' · 已暂停' : ''}</span></button>
            <button className={`server-status ${connectionPresentation.connected ? 'online' : ''}`} onClick={onStatusClick} title={server.label} aria-busy={starting}><i />{connectionPresentation.text}</button>
            <button onClick={async () => { if (!switchingRef.current && !hasActiveTask()) { try { await persistProject(); onSimpleMode(); } catch { /* Keep the unsaved canvas open. */ } } }} title="切换简易模式"><MousePointer2 size={15} /></button>
            <button onClick={() => window.open('http://127.0.0.1:8188','_blank')} title="打开 ComfyUI 高级节点"><MoreHorizontal size={17} /></button>
          </div>
        </div>
      </header>
      {localConnectionNotice && <div className="local-connection-notice" role="status"><span>{localConnectionNotice}</span>{server.backendOnline && <><button onClick={onStatusClick}>重新检查</button><button onClick={async () => {
        try { const { blob, name } = await downloadDoctorLogs(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
        catch (error) { setLocalConnectionNotice(error.message || '诊断日志下载失败，请稍后重试。'); }
      }}>下载诊断日志</button></>}<button onClick={dismissNotice} aria-label="关闭连接提示"><X size={14} /></button></div>}
      {projectBusy && <div className="project-switching" role="status"><LoaderCircle className="spin" size={18} />正在保存并打开画布…</div>}
      {project.readOnly && <div className="project-switching readonly" role="status">此项目正在另一个窗口中编辑，当前以只读方式打开。</div>}
      <main className={`neo-canvas-wrap canvas-view-${viewTier}${connecting ? ' canvas-connecting' : ''}`} style={{ '--canvas-handle-size': `${Math.min(72, Math.max(24, 24 / (zoom / 100)))}px` }} inert={projectBusy || libraryModalOpen ? true : undefined}
        onDragOver={(e) => e.preventDefault()}
        onPointerDownCapture={(event) => { if (event.button === 0 && !event.target.closest('.add-node-menu,.node-context-menu')) { setAddMenu(null); setNodeMenu(null); } }}
        onContextMenuCapture={openContextMenu}
        onDropCapture={event => { if ([...(event.dataTransfer.files || [])].some(file => /\.pur$/i.test(file.name))) { event.stopPropagation(); dropCanvasFiles(event); } }}
        onDrop={dropCanvasFiles}
        onDoubleClickCapture={openAddMenu}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onlyRenderVisibleElements
          nodesDraggable={!project.readOnly} nodesConnectable={!project.readOnly} edgesFocusable={!project.readOnly}
          onNodesChange={(changes) => {
            if (changes.some((change) => change.dragging === true || change.resizing === true)) { interactionRef.current = true; autoSaveRef.current?.suspend(); }
            if (changes.some((change) => change.dragging === false || change.resizing === false)) interactionRef.current = false;
            onNodesChange(changes.filter((change) => change.type !== 'remove' || !edgesRef.current.some((edge) => edge.source === change.id && lockedQwenInput(edge))));
          }} onEdgesChange={handleEdgesChange} onConnect={onConnect}
          isValidConnection={(connection) => !connectionPlan(connection).error} onConnectEnd={onConnectEnd}
          onConnectStart={() => { setConnecting(true); setConnectionNotice(''); }}
          onClickConnectStart={(_event, handle) => { setConnecting(true); clickConnection.current = handle; setConnectionNotice('请选择目标端口，或按 Escape 取消连接。'); }} onClickConnectEnd={onClickConnectEnd}
          connectionRadius={24 / Math.max(0.12, zoom / 100)} connectOnClick nodeDragThreshold={5} nodeClickDistance={5} connectionDragThreshold={3}
          onEdgeClick={(event, edge) => { if (event.altKey) { event.preventDefault(); event.stopPropagation(); disconnectEdge(edge.id); } }}
          deleteKeyCode={project.readOnly || workflowInspection || libraryModalOpen ? null : ['Backspace', 'Delete']}
          defaultViewport={saved.viewport} fitView={!saved.viewport}
          fitViewOptions={{ padding: 0.16, maxZoom: 0.85 }}
          minZoom={0.12} maxZoom={1.8} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
          panOnDrag={[1]} panOnScroll={false} selectionOnDrag selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode={['Shift']}
          snapToGrid={snapEnabled} snapGrid={[22, 22]}
          onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))}
          onMoveEnd={(_, viewport) => { viewportRef.current = viewport; saveViewport(project.id, viewport); }}
          defaultEdgeOptions={{ style: { stroke: '#77777e', strokeWidth: 1.6 }, type: 'default' }}
          connectionLineType={ConnectionLineType.Bezier}
          connectionLineStyle={{ stroke: '#eeeeee', strokeWidth: 1.8 }}
          proOptions={{ hideAttribution: true }}
        >
          {gridVisible && <Background variant={BackgroundVariant.Dots} gap={22} size={1.15} color="#3a3a3e" />}
          {miniMapVisible && <MiniMap pannable zoomable nodeColor={(node) => node.type === 'generator' ? '#9999a5' : node.data?.kind === 'audio' ? '#9c83a8' : '#65656d'} maskColor="#111113dc" />}
        </ReactFlow>
        {connectionNotice && <div className="canvas-connection-notice" role="status">{connectionNotice}</div>}
        {!nodes.length && !project.readOnly && <button className="empty-canvas" onClick={(e) => setAddMenu({ x: e.clientX, y: e.clientY, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) })}><Plus size={28} /><strong>双击画布开始创作</strong><span>或点击右下角添加节点</span></button>}
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
        <div className="canvas-bottom-right">
        <div className="canvas-dock">
          <button className="dock-add" disabled={project.readOnly} onClick={(e) => setAddMenu({ x: window.innerWidth / 2 - 110, y: Math.max(8, window.innerHeight - 550), flow: screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) })} title="添加元素"><Plus size={19} /></button>
          <button className={libraryOpen ? 'active' : ''} onClick={() => { setLibraryOpen(!libraryOpen); setPinOpen(false); }} title="本地作品"><FolderOpen size={17} /></button>
          <button onClick={() => { setLibraryOpen(true); refreshLibrary(); }} title="生成历史"><History size={17} /></button>
          <button onClick={tidyCanvas} title="整理画布 · 平滑连线"><Layers3 size={17} /></button>
          <button onClick={() => fitView({ duration: 350, padding: 0.15 })} title="适应画布"><Crosshair size={17} /></button>
          <button className={snapEnabled ? 'active' : ''} aria-pressed={snapEnabled} onClick={() => { const next = !snapEnabled; setSnapEnabled(next); localStorage.setItem(SNAP_KEY, String(next)); }} title="自动吸附"><Magnet size={16} /></button>
          <button onClick={async () => { if (!switchingRef.current && !hasActiveTask()) { try { await persistProject(); onSimpleMode(); } catch { /* Keep the unsaved canvas open. */ } } }} title="工作台设置与简易模式"><Settings2 size={17} /></button>
          <button className={pinOpen ? 'active' : ''} onClick={() => { setPinOpen(!pinOpen); setLibraryOpen(false); }} title={`Pin 节点 ${pinnedNodes.length}`}><Pin size={16} /></button>
        </div>
          <div className="hardware-monitor" aria-label="硬件状态" title={`${server.label} · 系统内存 ${formatGb(metrics.ramUsed)} / ${formatGb(metrics.ramTotal)} GB · 每 3 秒刷新`}>
            <button className={`memory-cleanup ${memoryCleanup}`} disabled={!server.online || memoryCleanup === 'busy'} onClick={clearMemory} title="仅在无运行或排队任务时卸载 ComfyUI 模型并释放显存"><MemoryStick size={14} /><span>{memoryCleanup === 'busy' ? '清理中' : memoryCleanup === 'done' ? '已释放' : '清理显存'}</span></button>
            <div className="hardware-metric" title={`${metrics.gpuName || 'GPU'}${metrics.gpuIndex != null ? `（设备 ${metrics.gpuIndex}）` : ''} · 整卡显存占用与计算利用率，包含其他程序`}>
              <span><MemoryStick size={12} />GPU{Number.isFinite(metrics.gpuPercent) ? ` ${Math.round(metrics.gpuPercent)}%` : ' 显存'}</span>
              <strong>{formatGb(metrics.vramUsed)} <small>/ {formatGb(metrics.vramTotal)} GB</small></strong>
              <div className="hardware-bar"><i style={{ width: `${vramPercent}%` }} /></div>
            </div>
            <div className="hardware-metric cpu-metric">
              <span><Cpu size={12} />CPU</span>
              <strong>{Number.isFinite(metrics.cpuPercent) ? `${Math.round(metrics.cpuPercent)}%` : '--'}</strong>
              <div className="hardware-bar"><i style={{ width: `${cpuPercent}%` }} /></div>
            </div>
            <div className="hardware-metric ram-metric">
              <span>RAM</span>
              <strong>{formatGb(metrics.ramUsed)} <small>/ {formatGb(metrics.ramTotal)} GB</small></strong>
              <div className="hardware-bar"><i style={{ width: `${metrics.ramTotal ? Math.min(100, Math.max(0, metrics.ramUsed / metrics.ramTotal * 100)) : 0}%` }} /></div>
            </div>
          </div>
        </div>
        {addMenu && <div className="add-node-menu" role="menu" aria-label="添加节点" style={{ left: addMenu.x, top: addMenu.y }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} onDoubleClick={(e) => e.stopPropagation()}>
          <div className="add-menu-title">添加节点 · 右键画布 <button onClick={() => setAddMenu(null)} aria-label="关闭添加节点菜单"><X size={13} /></button></div>
          <div className="add-menu-title">官方节点</div>
          <button onClick={() => addNode('generator', {}, addMenu.flow)}><i><WandSparkles size={17} /></i><span>视频生成<small>MiniMax H3 · 全能参考 / 首尾帧</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'image', title: '文生图' }, addMenu.flow)}><i><ImageIcon size={17} /></i><span>文生图<small>Krea2 / MOSS · 新人物与场景 · 约 1MP</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'image', title: 'H3-Image · 文生图', imageModel: 'h3_image', imageLora: 'none', h3ImageResolution: '4MP', ratio: '1:1' }, addMenu.flow)}><i><WandSparkles size={17} /></i><span>H3-Image 文生图<small>MiniMax · 6 步 · 4MP / 16MP</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'qwenEdit', title: 'H3-Image · 多图编辑', qwenModel: 'h3_image', imageLora: 'none', h3ImageResolution: '4MP' }, addMenu.flow)}><i><WandSparkles size={17} /></i><span>H3-Image 多图编辑<small>连接参考图片 · 图1决定比例</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'qwenEdit', title: '图生图', randomSeed: true, qwenSteps: 40, qwenRefResolution: 1024 }, addMenu.flow)}><i><WandSparkles size={17} /></i><span>图生图<small>千问 2.1 · 多图参考 · 标准 / Turbo</small></span><Plus size={13} /></button>
          <button onClick={() => addNode(...NODE_PRESETS.local_mask, addMenu.flow)}><i><Crosshair size={17} /></i><span>局部遮罩修改<small>绘制修改范围 · 连接图生图遮罩输入</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'imageUpscale', title: '图片高清', imageScale: 1.5, randomSeed: false }, addMenu.flow)}><i><Maximize2 size={17} /></i><span>图片高清<small>可选 SeedVR2 3B / 7B · 调整放大倍率</small></span><Plus size={13} /></button>
          <button disabled={project.readOnly} onClick={() => pureRefFileRef.current?.click()}><i><Upload size={17} /></i><span>导入 PureRef 图片<small>.pur 内嵌图片 → 普通图片节点 · 网格排列</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('artDirector', {}, addMenu.flow)}><i><Crosshair size={17} /></i><span>电子主美 · 图解分析<small>作品 + 可选参考 → 可编辑辅助线与详细解析 PNG</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('imageProcess', { mode: 'colorAdjust', title: '颜色调整' }, addMenu.flow)}><i><Settings2 size={17} /></i><span>图片调色<small>曲线 · 波峰色阶 · 曝光 · HSL · 色彩平衡等</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('imageProcess', { mode: 'imageBlend', title: '图像混合' }, addMenu.flow)}><i><Layers3 size={17} /></i><span>图像混合<small>底图 + 叠加图 · 14 种混合模式 · 可选遮罩</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('imageProcess', { mode: 'channelPack', title: 'RGBA 通道合并', packPreview: 'rgb' }, addMenu.flow)}><i><Layers3 size={17} /></i><span>RGBA 通道合并<small>四张灰度贴图 → RGBA · 32 位 TGA 导出</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('generator', { mode: 'upscale', title: '视频高清二采', resolution: '720P', randomSeed: false }, addMenu.flow)}><i><Sparkles size={17} /></i><span>视频高清二采<small>独立运行 · 3D Latent 放大 · 4 步 Turbo</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('image', {}, addMenu.flow)}><i><ImageIcon size={17} /></i><span>图片素材<small>角色、场景、风格参考</small></span><Plus size={13} /></button>
          <button onClick={() => addNode(...NODE_PRESETS.video_download, addMenu.flow)}><i><ArrowDownToLine size={17} /></i><span>视频链接下载<small>粘贴分享链接 · 下载到画布</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('video', {}, addMenu.flow)}><i><Video size={17} /></i><span>视频素材<small>动作、运镜或内容参考</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('audio', {}, addMenu.flow)}><i><Music2 size={17} /></i><span>音频素材<small>音色、配乐或声音参考</small></span><Plus size={13} /></button>
          <button onClick={() => addNode('note', {}, addMenu.flow)}><i><Type size={17} /></i><span>文本备注<small>分镜与创作设定</small></span><Plus size={13} /></button>
          <div className="add-menu-title">视频增强 · 本地模型</div>
          <button onClick={() => addNode('generator', { mode: 'videoSuperResolution', title: '视频超分', videoUpscaleModel: 'rtx', videoUpscaleScale: 2, rtxQuality: 'ULTRA', rtxStrength: 1, randomSeed: false }, addMenu.flow)}><i><Maximize2 size={17} /></i><span>视频超分<small>RTX VFX / SeedVR2 · 完整时长与原声</small></span><Plus size={13} /></button>
          <button disabled title="官方 HyperFlow 必需双时间模型与逐步终点条件；本机尚无经过验证的兼容运行时。普通 LoRA 转换不能替代。"><i><Sparkles size={17} /></i><span>2K 精修 · Open-H3 IC<small>兼容适配未完成 · 暂不可运行</small></span></button>
          <div className="add-menu-title">第三方工具</div>
          {LOCAL_NODE_TOOLS.filter((tool) => NODE_PRESETS[tool.preset]).map((tool) => <button key={tool.preset} onClick={() => addNode(...NODE_PRESETS[tool.preset], addMenu.flow)}><i><WandSparkles size={17} /></i><span>{tool.label}<small>{tool.description}</small></span><Plus size={13} /></button>)}
          <button onClick={() => { setAddMenu(null); setWorkflowLibraryOpen(true); }}><i><Library size={17} /></i><span>已安装的节点工具<small>选择从节点库下载或本地导入的工作流</small></span><Plus size={13} /></button>
        </div>}
        {nodeMenu && <div className="add-node-menu node-context-menu" role="menu" aria-label="节点操作"
          style={{ left: nodeMenu.x, top: nodeMenu.y }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onDoubleClick={(event) => event.stopPropagation()}>
          <div className="add-menu-title">{nodeMenu.title}
            <button onClick={() => setNodeMenu(null)} aria-label="关闭节点菜单"><X size={13} /></button>
          </div>
          {nodeMenu.inspectable && <button onClick={() => {
            const nodeId = nodeMenu.nodeId;
            setNodeMenu(null);
            void inspectNode(nodeId).catch(() => {});
          }}>
            <i><WandSparkles size={17} /></i>
            <span>进入 ComfyUI<small>查看这个节点的内部工作流</small></span>
          </button>}
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
      {handoffOpen && <HandoffDialog project={project} onClose={() => setHandoffOpen(false)} onSaved={saveHandoff} />}
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
      <input ref={pureRefFileRef} hidden type="file" accept=".pur" aria-label="选择 PureRef 文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) openPureRefImport(file, addMenu?.flow); }} />
      {pureRefSelection && <PureRefImport file={pureRefSelection.file}
        getContext={() => ({ projectId: projectRef.current.id, owner: autoSaveRef.current, readOnly: projectRef.current.readOnly, switching: switchingRef.current, conflict: Boolean(autoSaveRef.current?.failure), nodeCount: nodesRef.current.length })}
        upload={(image, session, signal) => saveCanvasMedia(revision => copyPureRefResource(session, image, project.id, revision, signal), (saved, mediaStorageId) => ({ ok: true, assetPath: saved.asset.path, mediaStorageId }))}
        beginBatch={() => {
          const key = uid('pur-import'); let finish;
          const pending = new Promise(resolve => { finish = resolve; });
          autoSaveRef.current?.suspend(); mediaWritesRef.current.set(key, pending);
          return () => { mediaWritesRef.current.delete(key); finish(); autoSaveRef.current?.observe(nameRef.current, { nodes: nodesRef.current, edges: edgesRef.current, viewport: viewportRef.current }, { defer: mediaWritesRef.current.size > 0 }); };
        }}
        publish={images => {
          const added = pureRefImageNodes(images, { existing: nodesRef.current, origin: pureRefSelection.origin, uid, assetUrl: relative => assetUrl(project.id, relative) });
          flushSync(() => { const next = [...nodesRef.current, ...added]; nodesRef.current = next; setNodes(next); });
          setTimeout(() => fitView({ nodes: added.slice(0, 6).map(({ id }) => ({ id })), duration: 300, padding: .2, maxZoom: 1 }), 50);
          return added.map(node => node.id);
        }} persist={persistProject}
        onClose={() => { pureRefBusyRef.current = false; setPureRefSelection(null); }} />}
      {imagePreview && <ImageLightbox preview={imagePreview} onClose={() => setImagePreview(null)} closeRef={previewCloseRef} />}
      {workflowInspection && <WorkflowInspector key={workflowInspection.nonce} request={workflowInspection} onClose={() => setWorkflowInspection(null)} />}
      {workflowLibraryOpen && <WorkflowLibrary onClose={() => setWorkflowLibraryOpen(false)} onAdd={async (bundle, definitionId) => { if (project.readOnly || switchingRef.current) throw new Error('当前画布不可写。'); flushSync(() => addNode('generator', extensionNodeData(bundle, definitionId))); await persistProject(); }} />}
      {nodeLibraryMounted && <NodeLibrary open={nodeLibraryOpen} onClose={() => { if (!catalogBusyRef.current) setNodeLibraryOpen(false); }} onOpenLocal={() => { if (!catalogBusyRef.current) { setNodeLibraryOpen(false); setWorkflowLibraryOpen(true); } }} onImport={importCatalogNode} sharePacket={sharePacket} onShareSent={(requestId) => setSharePacket((value) => value?.requestId === requestId ? null : value)} />}
      {dependencyRequest && <WorkflowDependencies request={dependencyRequest} onClose={closeDependencies} onAdd={async (bundle, definitionId, parameters, report) => {
        if (dependencyRequest.projectId !== projectRef.current.id) throw new Error('项目已改变，请重新检查。');
        await addImportedExtension(bundle, definitionId, parameters, report, dependencyRequest.existingId);
        setDependencyRequest(null); catalogRequestRef.current?.resolve?.();
      }} />}
      {nodeShare && <WorkflowShare {...nodeShare} onClose={() => setNodeShare(null)} onSend={async (packet) => { setReferenceLibrary(null); setNodeLibraryMounted(true); setNodeLibraryOpen(true); setSharePacket(packet); setNodeShare(null); }} />}
      {referenceLibraryTab && <ReferenceLibrary library={referenceLibraryTab} open={Boolean(referenceLibrary)} onLibraryChange={openReferenceLibrary} readOnly={project.readOnly} onImport={importReference} onClose={() => setReferenceLibrary(null)} />}
    </div>
  </NodeContext.Provider>;
}

export default function CanvasWorkbench({ initialProject = null, onActiveProjectChange, ...props }) {
  const [project, setProject] = useState(initialProject);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const acceptProject = useCallback((next) => {
    setProject(next);
    onActiveProjectChange?.(next);
  }, [onActiveProjectChange]);
  const load = useCallback(() => {
    setError('');
    initializeProjects(initialCanvas).then(acceptProject).catch((reason) => setError(reason.message || '项目存储无法打开。'));
  }, [acceptProject]);
  useEffect(() => { if (!initialProject) load(); }, [initialProject, load]);
  if (!project) return <div className="neo-app project-loading"><FolderOpen size={26} /><strong>{error ? '项目暂时无法打开' : '正在打开本地项目'}</strong><p role={error ? 'alert' : 'status'}>{error || '正在读取已保存的画布…'}</p>{error && <button onClick={load}>重试</button>}</div>;
  return <ReactFlowProvider key={`${project.id}:${reloadKey}`}><CanvasInner {...props} project={project} onProjectChange={acceptProject} onReload={(next) => { acceptProject(next); setReloadKey((value) => value + 1); }} /></ReactFlowProvider>;
}
