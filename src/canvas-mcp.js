import { useEffect, useRef } from 'react';
import { validateWorkflowParameters } from './workflow-extensions.js';
import { startCurrentCanvasPage, createProjectPageTools } from './canvas-current-page.js';
import { validateCharacterSheetAngleSeed, validateQwenCacheDevice, validateQwenSourceCrop } from './workbench-api.js';
import { qwenCanvasReferences, bindQwenPrompt, displayQwenPrompt } from './qwen-references.js';
import { availableNodePresets } from './local-node-tools.js';

export const NODE_PRESETS = {
  image_asset: ['image', {}],
  local_mask: ['image', { mediaRole: 'mask', title: '局部遮罩修改' }],
  video_asset: ['video', {}],
  video_download: ['note', { title: '视频链接下载', noteRole: 'videoDownload' }],
  audio_asset: ['audio', {}],
  note: ['note', {}],
  prompt_optimizer: ['prompt', {}],
  reference_video: ['generator', { mode: 'reference', title: '视频生成' }],
  character_swap: ['generator', { mode: 'swap', title: '精准角色替换' }],
  text_video: ['generator', { mode: 'text', title: '文生视频' }],
  frames_video: ['generator', { mode: 'frames', title: '视频生成' }],
  krea_image: ['generator', { mode: 'image', title: '文生图', imageModel: 'krea2' }],
  moss_image: ['generator', { mode: 'image', title: '文生图', imageModel: 'moss' }],
  identity_edit: ['generator', { mode: 'identityEdit', title: '母图编辑 V2', ratio: '16:9', refBoost: 4, groundingPx: 1024, refPosition: 'beside (right of target)' }],
  qwen_edit: ['generator', { mode: 'qwenEdit', title: '图生图', randomSeed: true, qwenSteps: 40, qwenRefResolution: 1024 }],
  qwen_turbo_edit: ['generator', { mode: 'qwenEdit', title: 'Qwen 2.1 Turbo INT8 · 图生图', qwenModel: 'turbo', randomSeed: false, seed: 281306, qwenRefResolution: 1024 }],
  realism_edit: ['generator', { mode: 'qwenEdit', title: '真人化 · 漫转真', prompt: '将图中的风格化人物转换为真实摄影中的真人，保留人物身份特征、发型发色、姿势、景别和构图；真实自然的皮肤纹理、五官结构与摄影光影，不要 CG、3D 渲染、插画或塑料皮肤。', imageLora: 'qwen21Realism', loraStrength: 0.8, randomSeed: true, qwenSteps: 40, qwenRefResolution: 1024 }],
  character_sheet: ['generator', { mode: 'characterSheet', title: '角色四视图生成', randomSeed: false, seed: 281306, qwenSteps: 40, qwenRefResolution: 1536 }],
  local_realism: ['generator', { mode: 'localRealism', title: '局部写实修复', prompt: '只增强选中皮肤的自然纹理、细小毛孔和真实光影；保持人物身份、五官、妆容、表情及其他区域不变。', localRealismSteps: 25, localRealismSize: 768, localMaskExpand: 0, localMaskBlend: 16, randomSeed: false, seed: 78001 }],
  outfit_edit: ['generator', { mode: 'outfitEdit', title: '无抠图换装', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, qwenRefResolution: 1536 }],
  outfit_qwen21_turbo: ['generator', { mode: 'outfitEdit', title: 'Qwen 2.1 Turbo INT8 · 四视图 · 无高清', outfitModel: 'qwen21_turbo', outfitUpscale: 'off', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, qwenRefResolution: 1536 }],
  outfit_qwen21_turbo_7b: ['generator', { mode: 'outfitEdit', title: 'Qwen 2.1 Turbo INT8 · 四视图 + SeedVR2 7B', outfitModel: 'qwen21_turbo', outfitUpscale: 'seedvr2_7b', upscaleModel: 'seedvr2_7b', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, qwenRefResolution: 1536 }],
  outfit_muse_v4: ['generator', { mode: 'outfitEdit', title: 'Muse V4.0 INT8 · 四视图 · 无高清', outfitModel: 'muse_v4', outfitUpscale: 'off', outfitLayout: 'mixedGrid', randomSeed: false, seed: 281306, museSteps: 16 }],
  image_upscale: ['generator', { mode: 'imageUpscale', title: '图片高清', imageScale: 1.5, randomSeed: false }],
  image_upscale_7b: ['generator', { mode: 'imageUpscale', title: 'SeedVR2 7B INT8 · 图片高清', upscaleModel: 'seedvr2_7b', imageScale: 1.5, randomSeed: false }],
  video_upscale: ['generator', { mode: 'upscale', title: '视频高清二采', resolution: '720P', randomSeed: false }],
};

const EDITABLE_SETTINGS = new Set([
  'workflowParameters', 'ratio', 'resolution', 'duration', 'turbo', 'seed', 'randomSeed', 'refImageSize', 'characterSheetAngleSeed',
  'qwenSteps', 'qwenRefResolution', 'localRealismSteps', 'localRealismSize', 'localRealismDenoise', 'localMaskMode', 'localMaskExpand', 'localMaskBlend', 'imageModel', 'imageLora', 'loraStrength', 'imageScale',
  'qwenModel', 'qwenCacheDevice', 'qwenSourceCrop', 'qwenMaskCrop', 'outfitModel', 'upscaleModel', 'outfitUpscale', 'outfitHdScale', 'museSteps',
  'outfitPreset', 'outfitPanel', 'outfitLayout', 'outfitPanels', 'outfitDenoise', 'targetQuery', 'targetDescription', 'targetSelection', 'targetIndex',
]);

export function describeNodeModels(data = {}) {
  const outfitModel = data.outfitModel || 'qwen21';
  const outfitModelLabel = outfitModel === 'muse_v4' ? 'Muse V4.0 INT8 + Identity V2' : outfitModel === 'qwen21_turbo' ? 'Qwen 2.1 Turbo INT8' : 'Qwen 2.1 标准版 INT8';
  const outfitHdLabel = data.outfitUpscale === 'off' ? '不做高清修复' : data.outfitUpscale === 'seedvr2_7b' ? '逐视图 SeedVR2 7B INT8' : '低于 1K 才 SeedVR2 3B';
  return {
    outfitModelLabel, outfitHdLabel,
    outfitSteps: outfitModel === 'muse_v4' ? Number(data.museSteps || 16) : outfitModel === 'qwen21_turbo' ? 8 : Number(data.qwenSteps || 40),
    qwenModelLabel: data.qwenModel === 'turbo' ? 'Qwen 2.1 Turbo INT8' : 'Qwen 2.1 标准版 INT8',
    qwenSteps: data.qwenModel === 'turbo' ? 8 : Number(data.qwenSteps || 40),
    upscaleModelLabel: data.upscaleModel === 'seedvr2_7b' ? 'SeedVR2 7B INT8' : 'SeedVR2 3B INT8',
  };
}

export function validateModelSettings(settings, mode) {
  if ('qwenMaskCrop' in settings && (typeof settings.qwenMaskCrop !== 'boolean' || (mode !== undefined && mode !== 'qwenEdit'))) throw new Error('局部放大重绘仅支持图生图的布尔开关。');
  if ('qwenCacheDevice' in settings) {
    validateQwenCacheDevice(settings.qwenCacheDevice);
    if (mode !== undefined && !['qwenEdit', 'characterSheet'].includes(mode)) throw new Error('qwenCacheDevice 仅适用于 Qwen 图生图或角色四视图。');
  }
  if ('characterSheetAngleSeed' in settings) validateCharacterSheetAngleSeed(settings.characterSheetAngleSeed);
  if ('qwenSourceCrop' in settings) validateQwenSourceCrop(settings.qwenSourceCrop);
  const values = { qwenModel: ['standard', 'turbo'], outfitModel: ['qwen21', 'qwen21_turbo', 'muse_v4'], upscaleModel: ['seedvr2_3b', 'seedvr2_7b'], outfitUpscale: ['auto', 'off', 'seedvr2_7b'] };
  for (const [key, allowed] of Object.entries(values)) {
    if (key in settings && !allowed.includes(settings[key])) throw new Error(`不支持的 ${key}：${settings[key]}`);
  }
  if ('outfitHdScale' in settings && (!Number.isFinite(settings.outfitHdScale) || settings.outfitHdScale < 1 || settings.outfitHdScale > 4)) throw new Error('outfitHdScale 必须在 1–4 之间。');
  if ('museSteps' in settings && (!Number.isInteger(settings.museSteps) || settings.museSteps < 8 || settings.museSteps > 20)) throw new Error('museSteps 必须是 8–20 之间的整数。');
}

function nodeSummary(node, includeContent = true) {
  if (!node) return null;
  return {
    id: node.id,
    type: node.type,
    title: node.data.title || '',
    kind: node.data.kind,
    ...(node.data.mediaRole === 'mask' ? { mediaRole: 'mask', maskSourceId: node.data.maskSourceId } : {}),
    mode: node.data.mode,
    ...(node.data.mode === 'customWorkflow' ? { extensionDigest: node.data.extensionDigest, nodeDefinitionId: node.data.nodeDefinitionId, workflowDefinition: node.data.workflowDefinition, workflowParameters: node.data.workflowParameters } : {}),
    status: node.data.status,
    stage: node.data.stage,
    progress: node.data.progress,
    promptId: node.data.promptId,
    queueJobId: node.data.queueJobId,
    ...(includeContent ? { prompt: node.data.prompt, text: node.data.text } : {}),
    ...(node.data.mode === 'outfitEdit' ? { outfitLayout: node.data.outfitLayout || 'legacy', outfitPanel: node.data.outfitPanel || node.data.panelId || null, outfitPanels: node.data.outfitPanels || null } : {}),
    ...(['outfitEdit', 'qwenEdit', 'characterSheet', 'imageUpscale'].includes(node.data.mode) ? {
      qwenModel: node.data.qwenModel || 'standard', outfitModel: node.data.outfitModel || 'qwen21',
      outfitUpscale: node.data.outfitUpscale || 'auto', upscaleModel: node.data.upscaleModel || 'seedvr2_3b',
      models: describeNodeModels(node.data),
    } : {}),
    name: node.data.name || node.data.filename,
    position: node.position,
    selected: Boolean(node.selected),
    pinned: Boolean(node.data.pinned),
    hasMedia: Boolean(node.data.url || node.data.resultUrl),
  };
}

function edgeSummary(edge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  };
}

function defaultTargetHandle(target, source) {
  if (source?.type === 'prompt') return 'prompt';
  if (target?.data.mediaRole === 'mask') return 'guide';
  if (source?.data.mediaRole === 'mask' && target?.data.mode === 'qwenEdit') return 'mask';
  const mode = target?.data.mode || 'reference';
  if (['reference', 'qwenEdit'].includes(mode)) return 'references';
  if (mode === 'frames') return source?.data.slot === 'last' ? 'last' : 'first';
  if (['swap', 'upscale'].includes(mode)) return source?.data.kind === 'video' ? 'guide' : 'identity';
  if (['imageUpscale', 'identityEdit', 'qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode)) return 'guide';
  throw new Error('这个生成模式不接受素材连线。');
}

async function waitFor(read, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('等待画布状态更新超时。');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const nodeIdProperty = { type: 'string', description: '画布节点的完整 ID，可从 canvas_get_state 获取。' };

function mcpNode(latest, id) {
  const node = latest.current.nodesRef.current.find((item) => item.id === id);
  if (!node) throw new Error(`找不到节点：${id}`);
  return node;
}

export async function generateNodeForMcp(latest, { nodeId, wait = false, timeoutMs = 300000 }, waitImpl = waitFor) {
  const initial = mcpNode(latest, nodeId);
  if (['uploading', 'queued', 'running', 'finishing'].includes(initial.data.status)) throw new Error('节点已经在生成，请使用 canvas_wait_for_node 等待，避免重复提交。');
  const before = initial.data.queueJobId;
  await latest.current.actions.generateNode(nodeId);
  const submitted = await waitImpl(() => {
    const node = mcpNode(latest, nodeId);
    if (node.data.status === 'error') throw new Error(node.data.error || '生成提交失败。');
    return node.data.queueJobId && node.data.queueJobId !== before ? node : null;
  }, 30000);
  if (!wait) return { node: nodeSummary(submitted) };
  const finished = await waitImpl(() => {
    const node = mcpNode(latest, nodeId);
    if (node.data.queueJobId !== submitted.data.queueJobId) return null;
    if (['done', 'error', 'cancelled'].includes(node.data.status)) return node;
    return null;
  }, timeoutMs, 500);
  if (finished.data.status !== 'done') throw new Error(finished.data.error || `生成结束状态：${finished.data.status}`);
  const resultEdges = latest.current.edgesRef.current.filter((edge) => edge.source === nodeId && edge.targetHandle === 'preview');
  const resultEdge = resultEdges.find((edge) => mcpNode(latest, edge.target).data.sourcePromptId === submitted.data.promptId) || resultEdges.at(-1);
  const resultNode = resultEdge ? mcpNode(latest, resultEdge.target) : null;
  return { node: nodeSummary(finished), resultNode: nodeSummary(resultNode) };
}

export async function waitForNodeForMcp(latest, { nodeId, timeoutMs = 300000 }, waitImpl = waitFor) {
  const initial = mcpNode(latest, nodeId);
  const promptId = initial.data.promptId;
  const queueJobId = initial.data.queueJobId;
  if (!promptId && !queueJobId) throw new Error('这个节点还没有提交生成任务。');
  const finished = await waitImpl(() => {
    const node = mcpNode(latest, nodeId);
    const sameJob = queueJobId ? node.data.queueJobId === queueJobId : node.data.promptId === promptId;
    return sameJob && ['done', 'error', 'cancelled'].includes(node.data.status) ? node : null;
  }, timeoutMs, 500);
  const resultEdge = latest.current.edgesRef.current.find((edge) => edge.source === nodeId && edge.targetHandle === 'preview');
  return { node: nodeSummary(finished), resultNode: resultEdge ? nodeSummary(mcpNode(latest, resultEdge.target)) : null };
}

export function useCanvasMcp({ nodesRef, edgesRef, projectName, projectId, readOnly = false, server, actions }) {
  const latest = useRef(null);
  latest.current = { nodesRef, edgesRef, projectName, projectId, readOnly, server, actions };

  useEffect(() => {
    const context = document.modelContext;
    const controller = new AbortController();
    const getNode = (id) => {
      const node = latest.current.nodesRef.current.find((item) => item.id === id);
      if (!node) throw new Error(`找不到节点：${id}`);
      return node;
    };
    const respond = (callback) => async (args = {}) => {
      try {
        const result = await callback(args);
        return JSON.stringify({ ok: true, ...result });
      } catch (error) {
        return JSON.stringify({ ok: false, error: error?.message || String(error) });
      }
    };
    const tools = [
      {
        name: 'canvas_get_state',
        description: '读取当前 H3 画布的真实节点 ID、连线和生成状态。默认省略长提示词以避免大画布占用过多上下文；需要提示词时设 includePrompt 为 true，也可用 nodeId 只读取一个节点。',
        inputSchema: schema({
          nodeId: { type: 'string', description: '可选，只返回这个节点及其相关连线。' },
          includePrompt: { type: 'boolean', description: '是否包含完整提示词和备注，默认 false。' },
        }),
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: respond(async ({ nodeId, includePrompt = false }) => {
          const nodes = nodeId ? [getNode(nodeId)] : latest.current.nodesRef.current;
          const ids = new Set(nodes.map((node) => node.id));
          return {
            projectName: latest.current.projectName,
            server: latest.current.server,
            nodeCount: latest.current.nodesRef.current.length,
            nodes: nodes.map((node) => {
              const summary = nodeSummary(node, includePrompt);
              if (node.data.mode !== 'qwenEdit') return summary;
              const references = qwenCanvasReferences(node, latest.current.nodesRef.current, latest.current.edgesRef.current);
              return { ...summary, maskNodeId: latest.current.edgesRef.current.find((edge) => edge.target === node.id && edge.targetHandle === 'mask')?.source || null, referenceNodeIds: references.map((ref) => ref.id), referenceCount: references.length,
                ...(includePrompt ? { prompt: displayQwenPrompt(node.data.prompt, references) } : {}) };
            }),
            edges: latest.current.edgesRef.current.filter((edge) => !nodeId || ids.has(edge.source) || ids.has(edge.target)).map(edgeSummary),
          };
        }),
      },
      {
        name: 'canvas_open_reference_library',
        description: '在当前画布内打开衣装、姿势或 Refmuse 参考库。不下载、不生成、不改项目。返回容器及首页来源，不能确认外站内容加载成功。',
        inputSchema: schema({ library: { type: 'string', enum: ['costume', 'pose', 'refmuse'] } }, ['library']),
        annotations: { readOnlyHint: true },
        execute: respond(async ({ library }) => latest.current.actions.openReferenceLibrary(library)),
      },
      {
        name: 'canvas_inspect_node',
        description: '在当前画布内打开节点的 ComfyUI 工作流查看副本；可指定 stage。读取真实任务记录，不生成、不保存参数，只有图导入确认后才返回 opened。',
        inputSchema: schema({ nodeId: nodeIdProperty, stage: { type: 'string', description: '可选阶段，如 front_portrait、three_quarter_portrait、back_body、front_body、stitch。' } }, ['nodeId']),
        annotations: { readOnlyHint: true },
        execute: respond(async ({ nodeId, stage }) => {
          getNode(nodeId);
          return latest.current.actions.inspectNode(nodeId, stage);
        }),
      },
      {
        name: 'canvas_create_extension',
        description: '从已导入的本地工作流包创建单个生成节点，固定摘要与节点定义；通过当前页面保存。',
        inputSchema: schema({ digest: { type: 'string' }, nodeDefinitionId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, focus: { type: 'boolean' } }, ['digest', 'nodeDefinitionId']),
        execute: respond(async ({ digest, nodeDefinitionId, x, y, focus = false }) => {
          const id = await latest.current.actions.createExtensionNode(digest, nodeDefinitionId, Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null, focus);
          return { node: nodeSummary(await waitFor(() => latest.current.nodesRef.current.find((node) => node.id === id))) };
        }),
      },
      {
        name: 'canvas_create_node',
        description: '在当前可见画布创建一个真实节点，使用与用户界面相同的节点和持久化逻辑。可用于准备图生图、视频、素材或备注测试。',
        inputSchema: schema({
          preset: { type: 'string', enum: Object.keys(availableNodePresets(NODE_PRESETS)), description: '当前已启用的节点预设。图生图用 qwen_edit，素材用 image_asset；本机实验工具仅在本机注册后可用。' },
          title: { type: 'string', description: '可选节点标题。' },
          prompt: { type: 'string', description: '可选初始提示词。' },
          text: { type: 'string', description: '备注节点的可选正文。' },
          x: { type: 'number', description: '可选画布世界坐标 X。' },
          y: { type: 'number', description: '可选画布世界坐标 Y。' },
          focus: { type: 'boolean', description: '是否移动视口到新节点，默认 false。' },
        }, ['preset']),
        execute: respond(async ({ preset, title, prompt, text, x, y, focus = false }) => {
          const definition = availableNodePresets(NODE_PRESETS)[preset];
          if (!definition) throw new Error(`未知节点预设：${preset}`);
          const [type, defaults] = definition;
          const extra = { ...defaults };
          if (title !== undefined) extra.title = title;
          if (prompt !== undefined) extra.prompt = prompt;
          if (text !== undefined) extra.text = text;
          const position = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
          const id = latest.current.actions.addNode(type, extra, position, focus);
          const node = await waitFor(() => latest.current.nodesRef.current.find((item) => item.id === id));
          return { node: nodeSummary(node) };
        }),
      },
      {
        name: 'canvas_update_node',
        description: '修改当前画布节点的标题、提示词、备注或受支持的生成参数。只允许白名单参数，不会绕过节点校验。',
        inputSchema: schema({
          nodeId: nodeIdProperty,
          title: { type: 'string' },
          prompt: { type: 'string' },
          text: { type: 'string' },
          settings: { type: 'object', description: '自定义工作流使用 workflowParameters 对象，键来自 workflowDefinition.parameters.properties；仅支持声明的标量参数。内置节点可选参数包含 qwenModel（standard/turbo）、qwenCacheDevice（auto/cpu，仅 Qwen 图生图和角色四视图，默认 auto；cpu 使用 default 精度参考缓存）、outfitModel（qwen21/qwen21_turbo/muse_v4）、outfitUpscale（auto/off/seedvr2_7b）、upscaleModel（seedvr2_3b/seedvr2_7b）、outfitHdScale、museSteps，以及 ratio、resolution、duration、turbo、seed、characterSheetAngleSeed（45° 头像独立种子，默认 2096285145，非负安全整数）、randomSeed、refImageSize、qwenSteps、qwenRefResolution、imageLora、loraStrength、imageScale、outfitPreset、outfitPanel、outfitLayout、outfitPanels、outfitDenoise、targetQuery、targetDescription、targetSelection、targetIndex。outfitLayout 支持 legacy、mixedGrid、equalGrid、horizontal、custom；custom 时 outfitPanels 为 4 个含 id、role、view、x、y、width、height 的面板，坐标使用 0–1 比例。' },
        }, ['nodeId']),
        execute: respond(async ({ nodeId, title, prompt, text, settings = {} }) => {
          const current = getNode(nodeId);
          if (['uploading', 'queued', 'running', 'finishing'].includes(current.data.status)) throw new Error('节点正在生成，请先完成或取消后再修改。');
          const unknown = Object.keys(settings).filter((key) => !EDITABLE_SETTINGS.has(key));
          if (unknown.length) throw new Error(`不支持的参数：${unknown.join(', ')}`);
          validateModelSettings(settings, current.data.mode ?? '');
          const patch = { ...settings };
          if ('workflowParameters' in settings) patch.workflowParameters = validateWorkflowParameters(current.data, settings.workflowParameters);
          if (title !== undefined) patch.title = title;
          if (prompt !== undefined) { patch.prompt = current.data.mode === 'qwenEdit' ? bindQwenPrompt(prompt, qwenCanvasReferences(current, latest.current.nodesRef.current, latest.current.edgesRef.current)) : prompt; patch.outfitPreset = null; }
          if (text !== undefined) patch.text = text;
          latest.current.actions.updateNode(nodeId, patch);
          const node = await waitFor(() => {
            const current = getNode(nodeId);
            return Object.entries(patch).every(([key, value]) => current.data[key] === value) ? current : null;
          });
          return { node: nodeSummary(node) };
        }),
      },
      {
        name: 'canvas_connect_nodes',
        description: '在当前画布连接两个真实节点。素材到千问图生图默认使用 references（最多10张），其他单图编辑使用 guide，到全能参考默认使用 references，提示词节点默认使用 prompt；无效类型会被现有画布规则拒绝。',
        inputSchema: schema({
          sourceId: nodeIdProperty,
          targetId: nodeIdProperty,
          targetHandle: { type: 'string', description: '目标端口。自定义工作流必须指定定义中的输入 id；内置节点通常留空自动判断。' },
        }, ['sourceId', 'targetId']),
        execute: respond(async ({ sourceId, targetId, targetHandle }) => {
          const source = getNode(sourceId);
          const target = getNode(targetId);
          const handle = target.data.mode === 'qwenEdit' && source.type !== 'prompt' && source.data.mediaRole !== 'mask' && ['guide', 'identity', undefined].includes(targetHandle) ? 'references' : targetHandle || defaultTargetHandle(target, source);
          const connected = latest.current.actions.onConnect({ source: sourceId, target: targetId, sourceHandle: source.type === 'prompt' ? 'prompt' : source.data.mediaRole === 'mask' ? 'mask' : 'ref', targetHandle: handle });
          if (connected?.error) throw new Error(connected.error);
          const edge = await waitFor(() => {
            return latest.current.edgesRef.current.find((item) => connected?.edgeId ? item.id === connected.edgeId : item.source === sourceId && item.target === targetId && item.targetHandle === handle) || null;
          }, 2500);
          return { edge: edgeSummary(edge) };
        }),
      },
      {
        name: 'canvas_generate_node',
        description: '从当前画布节点发起真实本地生成。素材上传、工作流构建、进度、结果文件和自动创建结果节点均走现有画布流程。默认只提交；需要等待成片时把 wait 设为 true。',
        inputSchema: schema({
          nodeId: nodeIdProperty,
          wait: { type: 'boolean', description: '是否等待生成结束，默认 false。' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 1500000, description: 'wait 为 true 时的等待上限，默认 300000 毫秒。' },
        }, ['nodeId']),
        execute: respond(async ({ nodeId, wait = false, timeoutMs = 300000 }) => generateNodeForMcp(latest, { nodeId, wait, timeoutMs })),
      },
      {
        name: 'canvas_wait_for_node',
        description: '只读等待当前画布上已经提交的任务进入完成、失败或取消状态，并返回自动生成结果节点。不会重复提交任务。',
        inputSchema: schema({
          nodeId: nodeIdProperty,
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 1500000, description: '等待上限，默认 300000 毫秒。' },
        }, ['nodeId']),
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: respond(async ({ nodeId, timeoutMs = 300000 }) => waitForNodeForMcp(latest, { nodeId, timeoutMs })),
      },
      {
        name: 'canvas_delete_node',
        description: '从当前画布删除指定节点及其连线；运行中的任务会按现有界面逻辑取消。用于清理 Agent 创建的临时测试节点。',
        inputSchema: schema({ nodeId: nodeIdProperty }, ['nodeId']),
        execute: respond(async ({ nodeId }) => {
          getNode(nodeId);
          latest.current.actions.removeNode(nodeId);
          await waitFor(() => !latest.current.nodesRef.current.some((node) => node.id === nodeId) || null);
          return { deletedNodeId: nodeId };
        }),
      },
      {
        name: 'canvas_focus_node',
        description: '将当前画布视口居中到指定真实节点，不移动节点、不修改内容，也不会重新生成。',
        inputSchema: schema({ nodeId: nodeIdProperty }, ['nodeId']),
        execute: respond(async ({ nodeId }) => {
          const node = getNode(nodeId);
          latest.current.actions.focusNode(nodeId);
          return { focusedNodeId: nodeId, title: node.data.title };
        }),
      },
      {
        name: 'canvas_tidy',
        description: '使用当前画布的自动整理功能重排全部节点并保留连线，然后适应视口。会移动节点位置，不会修改提示词或生成内容。',
        inputSchema: schema(),
        execute: respond(async () => {
          latest.current.actions.tidyCanvas();
          return { message: '已整理当前画布。' };
        }),
      },
    ];
    tools.push(...createProjectPageTools({
      prepare: (id, name) => latest.current.actions.prepareProjectSwitch(id, name),
      commit: (target) => latest.current.actions.commitProjectSwitch(target),
      abandon: (target) => latest.current.actions.abandonProjectSwitch(target),
    }));
    tools.push({
      name: 'canvas_import_asset',
      description: '在当前页面素材节点复用已保存素材，可用 sourceProjectId 指定来源项目；通过原生上传与版本保存复制到当前项目。',
      inputSchema: schema({ nodeId: nodeIdProperty, assetPath: { type: 'string' }, name: { type: 'string' }, sourceProjectId: { type: 'string' } }, ['nodeId', 'assetPath']),
      execute: respond(async ({ nodeId, assetPath, name, sourceProjectId }) => {
        const node = getNode(nodeId);
        if (node.type !== 'media' || !/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(assetPath)) throw new Error('需要当前项目的有效素材路径和素材节点。');
        if (sourceProjectId && !/^prj_[a-zA-Z0-9_-]+$/.test(sourceProjectId)) throw new Error('来源项目 ID 无效。');
        await latest.current.actions.importAsset(nodeId, assetPath, name, sourceProjectId);
        return { node: nodeSummary(getNode(nodeId)) };
      }),
    });
    for (const tool of tools) {
      const original = tool.execute;
      tool.execute = async (args = {}, executionOptions) => {
        const mutation = !['canvas_get_state', 'canvas_wait_for_node', 'canvas_focus_node', 'canvas_inspect_node', 'canvas_open_reference_library'].includes(tool.name);
        if (mutation && latest.current.readOnly) return JSON.stringify({ ok: false, error: '当前画布为只读。' });
        const result = JSON.parse(await original(args, executionOptions));
        if (mutation && result.ok && !['canvas_create_project', 'canvas_open_project'].includes(tool.name)) {
          try { await latest.current.actions.persistProject?.(); }
          catch (error) { return JSON.stringify({ ...result, ok: false, error: error.message, localChangesRetained: true }); }
        }
        return JSON.stringify(result);
      };
      if (context?.registerTool) Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch((error) => {
        console.warn(`[WebMCP] ${tool.name} 注册失败`, error);
      });
    }
    // A backgrounded tab is still the user's current canvas. Visibility is
    // handled by the single-page bridge lease, not by document.visibilityState:
    // the user may switch to another app while this same canvas keeps running.
    const stop = startCurrentCanvasPage({ tools, getPage: () => ({ projectId: latest.current.projectId,
      readOnly: latest.current.readOnly, visible: !latest.current.readOnly }) });
    return () => { stop(); controller.abort(); };
  }, [projectId, readOnly]);
}
