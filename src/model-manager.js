export function formatModelBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

export function usageTierMeta(tier, usage30d = 0, installed = true) {
  if (!installed) {
    return { label: '未下载', tone: 'neutral', detail: '尚未下载到本机模型目录' };
  }
  if (tier === 'high') {
    return { label: '高频使用', tone: 'high', detail: `近 30 天使用 ${usage30d} 次` };
  }
  if (tier === 'normal') {
    return { label: '正常使用', tone: 'normal', detail: `近 30 天使用 ${usage30d} 次` };
  }
  return { label: '长期闲置', tone: 'idle', detail: '近 30 天未使用' };
}

export function recommendationMeta(recommendation) {
  return ({
    keep_locked: { label: '已锁定 · 保留当前版本', tone: 'locked' },
    locked_update_held: { label: '有新版本 · 已锁定暂不覆盖', tone: 'locked-warn' },
    recommend_update: { label: '高频/在用 · 建议更新', tone: 'update' },
    recommend_cleanup: { label: '长期闲置 · 可清理腾空间', tone: 'cleanup' },
    keep: { label: '在用 · 保留', tone: 'normal' },
    available: { label: '可一键下载', tone: 'neutral' },
    manual: { label: '需手动安装', tone: 'neutral' },
  })[recommendation] || { label: '保留', tone: 'neutral' };
}

export function canDeleteModel(item) {
  if (!item?.installed || item.locked) return false;
  return !['downloading', 'verifying'].includes(item.status);
}

export function canDownloadOrUpdateModel(item) {
  if (!item?.hasDownloadUrl || item.locked) return false;
  if (['downloading', 'verifying'].includes(item.status)) return false;
  return !item.installed || Boolean(item.updateAvailable);
}

export function summarizeModels(models = []) {
  const installed = models.filter((item) => item.installed);
  const idleUnlocked = installed.filter((item) => item.usageTier === 'idle' && !item.locked);
  return {
    totalInstalledCount: installed.length,
    totalInstalledBytes: installed.reduce((sum, item) => sum + (item.actualBytes || 0), 0),
    lockedCount: installed.filter((item) => item.locked).length,
    highCount: installed.filter((item) => item.usageTier === 'high').length,
    normalCount: installed.filter((item) => item.usageTier === 'normal').length,
    idleCount: installed.filter((item) => item.usageTier === 'idle').length,
    idleReclaimableCount: idleUnlocked.length,
    idleReclaimableBytes: idleUnlocked.reduce((sum, item) => sum + (item.actualBytes || 0), 0),
    updateAvailableCount: installed.filter((item) => item.updateAvailable).length,
    activeDownloadsCount: models.filter((item) => ['downloading', 'verifying'].includes(item.status)).length,
  };
}

const REC_WEIGHT = {
  recommend_cleanup: 0,
  recommend_update: 1,
  locked_update_held: 2,
  keep_locked: 3,
  keep: 4,
  available: 5,
  manual: 6,
};

export function filterAndSortModels(models = [], { query = '', filter = 'all', group = 'all', sort = 'size_desc' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const filtered = models.filter((item) => {
    if (filter === 'installed' && !item.installed) return false;
    if (filter === 'idle' && !(item.installed && item.usageTier === 'idle')) return false;
    if (filter === 'locked' && !item.locked) return false;
    if (filter === 'updates' && !item.updateAvailable) return false;
    if (filter === 'missing' && item.installed) return false;
    if (group !== 'all' && item.group !== group) return false;
    if (!needle) return true;
    return [item.title, item.name, item.path, item.group, item.license]
      .some((text) => String(text || '').toLowerCase().includes(needle));
  });

  const bytesOf = (item) => (item.installed ? item.actualBytes : item.expectedBytes) || 0;
  return [...filtered].sort((a, b) => {
    if (sort === 'size_desc') {
      const diff = bytesOf(b) - bytesOf(a);
      return diff || a.name.localeCompare(b.name);
    }
    if (sort === 'usage_asc') {
      if (Boolean(a.installed) !== Boolean(b.installed)) return a.installed ? -1 : 1;
      const diff = (a.usage30d || 0) - (b.usage30d || 0);
      return diff || bytesOf(b) - bytesOf(a) || a.name.localeCompare(b.name);
    }
    if (sort === 'usage_desc') {
      const diff = (b.usage30d || 0) - (a.usage30d || 0);
      return diff || bytesOf(b) - bytesOf(a) || a.name.localeCompare(b.name);
    }
    if (sort === 'recommendation') {
      const wa = REC_WEIGHT[a.recommendation] ?? 99;
      const wb = REC_WEIGHT[b.recommendation] ?? 99;
      return wa - wb || bytesOf(b) - bytesOf(a) || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });
}

export const CAPABILITY_CATEGORIES = Object.freeze([
  { id: 'all', code: '00', label: '全部模型' },
  { id: 'video', code: '01', label: '视频生成' },
  { id: 'image', code: '02', label: '文生图' },
  { id: 'edit', code: '03', label: '修图与换装' },
  { id: '3d', code: '04', label: '3D 生成' },
  { id: 'upscale', code: '05', label: '高清放大' },
  { id: 'lora', code: '06', label: '风格 LoRA' },
  { id: 'other', code: '07', label: '其他主模型' },
]);

export const AUXILIARY_CATEGORIES = new Set(['vae', 'text_encoders', 'clip', 'clip_vision', 'controlnet']);

const AUX_ROLE_LABELS = Object.freeze({
  vae: 'VAE 解码器',
  text_encoders: '文本 / 多模态编码器',
  clip: 'CLIP 编码器',
  clip_vision: '视觉特征编码器',
  controlnet: 'ControlNet 控制网',
});

const AUX_WORKFLOW_HINTS = [
  ['wan_2.1_vae', ['Wan 2.1 视频工作流']],
  ['krea2realvae', ['Krea2 写实出图工作流']],
  ['qwen_2.5_vl_7b', ['Qwen 2.5 VL 图像理解 / 编辑工作流']],
  ['clip_vision_h', ['图生视频 / 风格参考工作流']],
  ['trellis_2_', ['Pixal3D 图生 3D 引擎']],
  ['dino_v3_', ['Pixal3D 图生 3D 引擎']],
  ['qwen3vl_32b', ['MiniMax H3 视频引擎', 'H3-Image 高精生图']],
  ['minimax_h3', ['MiniMax H3 视频引擎']],
  ['qwen3vl_4b', ['FLUX 3 Klein 图像引擎', 'Krea2 快速概念出图']],
];

const CATEGORY_LABEL = Object.fromEntries(CAPABILITY_CATEGORIES.map((c) => [c.id, c.label]));

export const CAPABILITY_PRESETS = Object.freeze([
  {
    id: 'h3_video',
    category: 'video',
    brand: 'minimax',
    brandLabel: 'MINIMAX',
    coverUrl: '/model-covers/h3_video.jpg',
    illustration: 'video',
    specTag: '24 FPS · H3 VIDEO',
    title: 'MiniMax H3 视频引擎',
    subtitle: '用于画布文生视频、全能参考生视频与首尾帧生成（含 INT8 / GGUF 轻量版）。',
    files: [
      'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      'diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
      'diffusion_models/MiniMax-H3-FL2VA-Q3_K_M.gguf',
      'diffusion_models/MiniMax-H3-Ref2VA-Q3_K_M.gguf',
      'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
      'vae/minimax_h3_audio_vae_fp32.safetensors',
      'vae/minimax_h3_video_vae_int8_convrot.safetensors',
      'loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
      'loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
      'loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    ],
  },
  {
    id: 'h3_video_upscale',
    category: 'upscale',
    brand: 'minimax',
    brandLabel: 'MINIMAX',
    coverUrl: '/model-covers/h3_video_upscale.jpg',
    illustration: 'upscale',
    specTag: '3D LATENT · 2×',
    title: 'H3 视频二采放大',
    subtitle: '提升 H3 生成视频的清晰度与纹理细节，保留原音轨与动作连贯性。',
    files: [
      'latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors',
    ],
  },
  {
    id: 'h3_image',
    category: 'image',
    brand: 'minimax',
    brandLabel: 'MINIMAX',
    coverUrl: '/model-covers/h3_image.jpg',
    illustration: 'image',
    specTag: '4MP–16MP · H3-IMG',
    title: 'H3-Image 高精生图',
    subtitle: '适合复杂中文语义理解、角色概念图、多图构图参考与高分辨率输出。',
    files: [
      'diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors',
      'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
      'vae/minimax_h3_image_vae_fp16.safetensors',
    ],
  },
  {
    id: 'flux3_klein',
    category: 'image',
    brand: 'flux',
    brandLabel: 'FLUX.3',
    coverUrl: '/model-covers/flux3_klein.jpg',
    illustration: 'image',
    specTag: 'FLUX 3 · KLEIN',
    title: 'FLUX 3 Klein 图像引擎',
    subtitle: '轻量写实出图与多参考修图引擎，适合概念场景设计、材质感与多图融合。',
    files: [
      'diffusion_models/flux3-image-klein-int8-convrot.safetensors',
      'text_encoders/qwen3vl_4b_int8_convrot.safetensors',
      'text_encoders/qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors',
      'vae/flux2-vae.safetensors',
    ],
  },
  {
    id: 'krea2',
    category: 'image',
    brand: 'krea',
    brandLabel: 'KREA 2',
    coverUrl: '/model-covers/krea2.jpg',
    illustration: 'image',
    specTag: '8 STEPS · FAST',
    title: 'Krea2 快速概念出图',
    subtitle: '8 步快速出图，适合探索分镜草图、角色设定与叠加多种画风 LoRA。',
    files: [
      'diffusion_models/Krea2-MuseByStable_v30Turbo_fp8.safetensors',
      'diffusion_models/krea2_turbo_fp8_scaled.safetensors',
      'diffusion_models/museByStableYogi_v40INT8Extended.safetensors',
      'text_encoders/qwen3vl_4b_fp8_scaled.safetensors',
      'vae/qwen_image_vae.safetensors',
    ],
  },
  {
    id: 'moss_image',
    category: 'image',
    brand: 'moss',
    brandLabel: 'MOSS',
    coverUrl: '/model-covers/moss_image.jpg',
    illustration: 'image',
    specTag: 'MOSS · SFT',
    title: 'MOSS 风格出图',
    subtitle: '擅长构图表现、光影质感与多主体画面生成。',
    files: [
      'diffusion_models/Moss_image/moss_image_sft_int8_convrot.safetensors',
      'text_encoders/qwen3.5_9b_int8_convrot.safetensors',
      'vae/flux2-vae_small.safetensors',
    ],
  },
  {
    id: 'qwen21_edit',
    category: 'edit',
    brand: 'qwen',
    brandLabel: 'QWEN 2.1',
    coverUrl: '/model-covers/qwen21_edit.jpg',
    illustration: 'edit',
    specTag: 'INPAINT · EDIT',
    title: '千问 2.1 修图与局部重绘',
    subtitle: '支撑涂抹遮罩局部改图、人物皮肤精修与多图指令编辑（含标准/Turbo）。',
    files: [
      'diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
      'diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors',
      'diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors',
      'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
      'vae/qwen_image_2.1_vae_bf16.safetensors',
    ],
  },
  {
    id: 'character_swap_quad',
    category: 'edit',
    brand: 'minimax',
    brandLabel: 'H3 · SWAP',
    coverUrl: '/model-covers/character_swap_quad.jpg',
    illustration: 'character',
    specTag: 'SWAP · QUADVIEW',
    title: '角色替换与四视图套件',
    subtitle: '用于视频源片逐帧人物替换、SAM 自动抠图以及角色三/四视图生成。',
    files: [
      'checkpoints/sam3.1_multiplex_fp16.safetensors',
      'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      'vae/minimax_h3_video_vae_fp16.safetensors',
      'loras/h3_character_swap_v1.5.safetensors',
      'loras/Krea2-四视图QuadView_krea2_v1.safetensors',
      'loras/krea2_identity_edit_v2.safetensors',
    ],
  },
  {
    id: 'pixal3d',
    category: '3d',
    brand: 'pixal3d',
    brandLabel: 'PIXAL 3D',
    coverUrl: '/model-covers/pixal3d.jpg',
    illustration: '3d',
    specTag: 'IMG → 3D MESH',
    title: 'Pixal3D 图生 3D 引擎',
    subtitle: '单张参考图生成高精度 3D 几何模型与材质基础，用于画布 3D 资产管线。',
    files: [
      'diffusion_models/pixal3d_int8_convrot.safetensors',
      'vae/trellis_2_shape_vae_bf16.safetensors',
      'vae/trellis_2_texture_vae_bf16.safetensors',
      'clip_vision/dino_v3_L_naf_fp32.safetensors',
    ],
  },
  {
    id: 'seedvr2_upscale',
    category: 'upscale',
    brand: 'seedvr',
    brandLabel: 'SEEDVR2',
    coverUrl: '/model-covers/seedvr2_upscale.jpg',
    illustration: 'upscale',
    specTag: 'SEEDVR2 · 4K',
    title: 'SeedVR2 图片与画面高清',
    subtitle: '对低分辨率图片或成品帧做无损感高清放大，包含 3B 轻量档与 7B 精细档。',
    files: [
      'diffusion_models/seedvr2_3b_int8_convrot.safetensors',
      'diffusion_models/seedvr2_7b_int8_convrot.safetensors',
      'vae/seedvr2_ema_vae_fp16.safetensors',
    ],
  },
]);

function cleanDisplayName(rawName = '') {
  const withoutExt = String(rawName).replace(/\.(safetensors|ckpt|pt|pth|bin|onnx|gguf)$/i, '');
  const stripped = withoutExt.replace(/^krea2[-_\s]+/i, '');
  return (stripped || withoutExt).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function describeStandaloneModel(item) {
  const lowPath = String(item.path || '').toLowerCase();
  const cleanTitle = cleanDisplayName(item.name || item.title);

  if (item.category === 'loras') {
    const isStyleFolder = lowPath.includes('风格');
    const isFuncFolder = lowPath.includes('功能');
    const subTag = isStyleFolder ? '风格 LoRA' : isFuncFolder ? '功能 LoRA' : '通用 LoRA';
    return {
      category: 'lora',
      brand: 'lora',
      brandLabel: lowPath.includes('krea2') ? 'KREA LORA' : 'LORA',
      coverUrl: item.previewUrl || null,
      illustration: 'lora',
      specTag: subTag,
      title: cleanTitle,
      subtitle: item.previewUrl
        ? `用于叠加画面风格与特征微调（${subTag}）。`
        : '暂无封面预览图，可列入夜间本地生图补封面清单。',
    };
  }

  if (item.category === 'upscale_models' || item.category === 'latent_upscale_models') {
    return {
      category: 'upscale',
      brand: 'upscale',
      brandLabel: 'UPSCALE',
      coverUrl: item.previewUrl || '/model-covers/seedvr2_upscale.jpg',
      illustration: 'upscale',
      specTag: 'UPSCALE · WEIGHT',
      title: item.title || cleanTitle,
      subtitle: '独立高清放大模型权重，用于在工作流中提升输出分辨率。',
    };
  }

  if (lowPath.includes('krea2') || lowPath.includes('musebystable')) {
    return {
      category: 'image',
      brand: 'krea',
      brandLabel: 'KREA 2',
      coverUrl: item.previewUrl || '/model-covers/krea2.jpg',
      illustration: 'image',
      specTag: 'KREA 2 · 衍生主模型',
      title: cleanTitle,
      subtitle: 'Krea2 系列社区微调文生图主模型，兼容 Krea2 生态 LoRA。',
    };
  }

  if (lowPath.includes('minimax') && lowPath.includes('h3')) {
    return {
      category: 'video',
      brand: 'minimax',
      brandLabel: 'MINIMAX',
      coverUrl: item.previewUrl || '/model-covers/h3_video.jpg',
      illustration: 'video',
      specTag: 'H3 · VIDEO',
      title: item.title || cleanTitle,
      subtitle: 'MiniMax H3 视频生成权重变体。',
    };
  }

  return {
    category: 'other',
    brand: 'custom',
    brandLabel: 'LOCAL MODEL',
    coverUrl: item.previewUrl || null,
    illustration: 'custom',
    specTag: String(item.category || 'MODEL').toUpperCase(),
    title: item.title || cleanTitle,
    subtitle: '本机模型目录扫描到的独立主模型，用于自定义 ComfyUI 工作流。',
  };
}

function finalizeCard(cardMeta, files, allCardRefsByPath) {
  const installedFiles = files.filter((f) => f.installed);
  const installed = installedFiles.length > 0;
  const fullyInstalled = files.length > 0 && installedFiles.length === files.length;
  const actualBytes = installedFiles.reduce((s, f) => s + (f.actualBytes || 0), 0);
  const expectedBytes = files.reduce((s, f) => s + (f.expectedBytes || f.actualBytes || 0), 0);
  const lockedCount = installedFiles.filter((f) => f.locked).length;
  const locked = installed && lockedCount === installedFiles.length;
  const partiallyLocked = installed && lockedCount > 0 && lockedCount < installedFiles.length;
  const usage30d = files.reduce((max, f) => Math.max(max, f.usage30d || 0), 0);
  const usageCount = files.reduce((max, f) => Math.max(max, f.usageCount || 0), 0);
  const usageTier = !installed ? 'idle' : usage30d >= 10 ? 'high' : usage30d >= 1 ? 'normal' : 'idle';
  const lastUsedAt = files
    .map((f) => f.lastUsedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const updateAvailable = installedFiles.some((f) => f.updateAvailable);
  const downloading = files.some((f) => ['downloading', 'verifying'].includes(f.status));
  const downloadableFiles = files.filter((f) => canDownloadOrUpdateModel(f));
  const missingDownloadFiles = downloadableFiles.filter((f) => !f.installed);

  const localSidecarUrl = files.find((f) => f.previewUrl)?.previewUrl || null;
  const resolvedCoverUrl = localSidecarUrl || cardMeta.coverUrl || null;

  // Protect shared files used by any OTHER installed capability card.
  const exclusiveDeletableFiles = installedFiles.filter((f) => {
    if (!canDeleteModel(f)) return false;
    const refs = allCardRefsByPath.get(f.path) || [];
    const usedByOtherInstalled = refs.some((other) => other.id !== cardMeta.id && other.installed);
    return !usedByOtherInstalled;
  });
  const sharedInstalledCount = installedFiles.filter((f) => {
    const refs = allCardRefsByPath.get(f.path) || [];
    return refs.some((other) => other.id !== cardMeta.id && other.installed);
  }).length;
  const reclaimableBytes = exclusiveDeletableFiles.reduce((s, f) => s + (f.actualBytes || 0), 0);

  return {
    ...cardMeta,
    coverUrl: resolvedCoverUrl,
    hasRealCover: Boolean(resolvedCoverUrl),
    needsCover: !resolvedCoverUrl,
    categoryLabel: CATEGORY_LABEL[cardMeta.category] || '其他主模型',
    files,
    primaryPath: files[0]?.path || '',
    installed,
    fullyInstalled,
    installedCount: installedFiles.length,
    totalCount: files.length,
    actualBytes,
    expectedBytes,
    locked,
    partiallyLocked,
    lockedCount,
    usage30d,
    usageCount,
    usageTier,
    lastUsedAt,
    updateAvailable,
    downloading,
    downloadableFiles,
    missingDownloadFiles,
    exclusiveDeletableFiles,
    sharedInstalledCount,
    reclaimableBytes,
  };
}

export function buildCapabilityCards(models = []) {
  const byPath = new Map(models.map((item) => [item.path, item]));
  const assignedPaths = new Set();
  const rawCards = [];

  for (const preset of CAPABILITY_PRESETS) {
    const matched = preset.files.map((p) => byPath.get(p)).filter(Boolean);
    if (!matched.length) continue;
    matched.forEach((item) => assignedPaths.add(item.path));
    rawCards.push({ meta: preset, files: matched });
  }

  for (const item of models) {
    if (assignedPaths.has(item.path)) continue;
    // Auxiliary components (VAE / text encoders / CLIP / ControlNet) live in the dedicated workflow table, not cards.
    if (AUXILIARY_CATEGORIES.has(item.category)) continue;
    const desc = describeStandaloneModel(item);
    rawCards.push({
      meta: {
        id: `single:${item.path}`,
        category: desc.category,
        brand: desc.brand,
        brandLabel: desc.brandLabel,
        coverUrl: desc.coverUrl,
        illustration: desc.illustration,
        specTag: desc.specTag,
        title: desc.title,
        subtitle: desc.subtitle,
      },
      files: [item],
    });
  }

  // Track which cards are installed so shared dependencies are preserved during cleanup.
  const cardInstallState = rawCards.map(({ meta, files }) => ({
    id: meta.id,
    installed: files.some((f) => f.installed),
    files,
  }));
  const allCardRefsByPath = new Map();
  for (const entry of cardInstallState) {
    for (const file of entry.files) {
      if (!allCardRefsByPath.has(file.path)) allCardRefsByPath.set(file.path, []);
      allCardRefsByPath.get(file.path).push({ id: entry.id, installed: entry.installed });
    }
  }

  return rawCards.map(({ meta, files }) => finalizeCard(meta, files, allCardRefsByPath));
}

export function buildAuxiliaryComponents(models = []) {
  const presetWorkflowsByPath = new Map();
  for (const preset of CAPABILITY_PRESETS) {
    for (const relPath of preset.files) {
      if (!presetWorkflowsByPath.has(relPath)) presetWorkflowsByPath.set(relPath, []);
      const list = presetWorkflowsByPath.get(relPath);
      if (!list.includes(preset.title)) list.push(preset.title);
    }
  }

  const auxItems = models
    .filter((item) => AUXILIARY_CATEGORIES.has(item.category))
    .map((item) => {
      const workflows = [...(presetWorkflowsByPath.get(item.path) || [])];
      const lowPath = String(item.path || '').toLowerCase();
      for (const [needle, hinted] of AUX_WORKFLOW_HINTS) {
        if (lowPath.includes(needle)) {
          for (const wf of hinted) {
            if (!workflows.includes(wf)) workflows.push(wf);
          }
        }
      }
      if (!workflows.length) workflows.push('本地自定义 ComfyUI 工作流');
      return {
        ...item,
        roleLabel: AUX_ROLE_LABELS[item.category] || '辅助组件',
        usedByWorkflows: workflows,
        sharedCount: workflows.length,
      };
    });

  return auxItems.sort((a, b) => {
    if (Boolean(a.installed) !== Boolean(b.installed)) return a.installed ? -1 : 1;
    const sizeDiff = ((b.installed ? b.actualBytes : b.expectedBytes) || 0) - ((a.installed ? a.actualBytes : a.expectedBytes) || 0);
    return sizeDiff || a.name.localeCompare(b.name);
  });
}

export function filterAndSortCards(cards = [], { query = '', category = 'all', statusFilter = 'all', sort = 'size_desc' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const filtered = cards.filter((card) => {
    if (category !== 'all' && card.category !== category) return false;
    if (statusFilter === 'installed' && !card.installed) return false;
    if (statusFilter === 'idle' && !(card.installed && card.usageTier === 'idle')) return false;
    if (statusFilter === 'locked' && !card.locked && !card.partiallyLocked) return false;
    if (statusFilter === 'updates' && !card.updateAvailable) return false;
    if (statusFilter === 'missing' && card.installed) return false;
    if (statusFilter === 'needs_cover' && !card.needsCover) return false;
    if (!needle) return true;
    if ([card.title, card.subtitle, card.categoryLabel, card.specTag, card.brandLabel].some((t) => String(t || '').toLowerCase().includes(needle))) {
      return true;
    }
    return card.files.some((f) => [f.name, f.path, f.title].some((t) => String(t || '').toLowerCase().includes(needle)));
  });

  const bytesOf = (card) => (card.installed ? card.actualBytes : card.expectedBytes) || 0;
  return [...filtered].sort((a, b) => {
    if (sort === 'size_desc') {
      if (Boolean(a.installed) !== Boolean(b.installed)) return a.installed ? -1 : 1;
      return bytesOf(b) - bytesOf(a) || a.title.localeCompare(b.title, 'zh-CN');
    }
    if (sort === 'usage_asc') {
      if (Boolean(a.installed) !== Boolean(b.installed)) return a.installed ? -1 : 1;
      return (a.usage30d || 0) - (b.usage30d || 0) || bytesOf(b) - bytesOf(a);
    }
    if (sort === 'usage_desc') {
      return (b.usage30d || 0) - (a.usage30d || 0) || bytesOf(b) - bytesOf(a);
    }
    return a.title.localeCompare(b.title, 'zh-CN');
  });
}
