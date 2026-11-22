// Single-subject integration of Alissonerdx's Fro099 normal-map workflow.
// Guide preparation and diffusion are separate runs so the guide is reviewable.
export const CHARACTER_SWAP_MAP_MODELS = Object.freeze({
  moge: 'moge_3_vitl_fp16.safetensors',
  dmad: 'minimax_h3_DMAD_8step_full_lora_avg_rank_58_bf16.safetensors',
  adapter: 'minimax_h3_character_swap_v1.0_preprocessor_map_fro099.safetensors',
});

export function resolveCharacterSwapMapDimensions(ratio, resolution, resolveDimensions) {
  const fallback = resolveDimensions(ratio || '9:16', resolution || '480P');
  const match = String(ratio || '9:16').match(/^(\d+):(\d+)$/);
  if (!match) return fallback;
  const a = Number(match[1]); const b = Number(match[2]);
  const short = Math.min(...fallback);
  return a <= b ? [short, Math.round(short * b / a / 32) * 32] : [Math.round(short * a / b / 32) * 32, short];
}

export function validateCharacterSwapMapSettings(settings, mode) {
  const keys = ['characterSwapMethod', 'characterSwapStage', 'mapGuideApproved'];
  if (!keys.some(key => key in settings)) return;
  if (mode !== undefined && mode !== 'swap') throw new Error('法线角色替换参数仅适用于角色替换节点。');
  if ('characterSwapMethod' in settings && !['standard', 'preprocessorMap'].includes(settings.characterSwapMethod)) throw new Error('不支持的角色替换方法。');
  if ('characterSwapStage' in settings && !['guide', 'generate'].includes(settings.characterSwapStage)) throw new Error('不支持的法线替换阶段。');
  if ('mapGuideApproved' in settings && typeof settings.mapGuideApproved !== 'boolean') throw new Error('法线引导确认必须为布尔值。');
}

export function buildCharacterSwapMapWorkflow(options, baseModels, swapModels, resolveDimensions, durationToFrames) {
  validateCharacterSwapMapSettings(options, 'swap');
  const stage = options.characterSwapStage || 'guide';
  const references = options.references || [];
  const guide = references.find(ref => ref.slot === 'guide' && ref.kind === 'video');
  const identities = references.filter(ref => ref.slot === 'identity' && ref.kind === 'image');
  if (!guide) throw new Error(stage === 'guide' ? '请把真人原片连接到源视频端口，先制作法线引导。' : '请把已检查的红色法线引导视频连接到源视频端口。');
  if (stage === 'generate' && identities.length !== 1) throw new Error('法线替换需要一张单人身份参考；请只连接一张图片。');
  if (stage === 'generate' && options.mapGuideApproved !== true) throw new Error('请先检查整段法线引导：红色只覆盖目标人物，手臂和边缘跟踪正确，再勾选确认。');
  const [width, height] = resolveCharacterSwapMapDimensions(options.ratio, options.resolution, resolveDimensions);
  const length = durationToFrames(options.duration || 5);
  const graph = {
    source: { class_type: 'LoadVideo', inputs: { file: guide.name } },
    components: { class_type: 'GetVideoComponents', inputs: { video: ['source', 0] } },
    prepare: { class_type: 'H3MapPrepareFrames', inputs: { images: ['components', 0], source_fps: ['components', 2], width, height, length } },
    source_audio: { class_type: 'TrimAudioDuration', inputs: { audio: ['components', 1], start_index: 0, duration: length / 24 } },
  };
  if (stage === 'guide') {
    Object.assign(graph, {
      sam: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: swapModels.samCheckpoint } },
      subject: { class_type: 'CLIPTextEncode', inputs: { clip: ['sam', 1], text: options.targetQuery || 'person' } },
      first_frame: { class_type: 'ImageFromBatch', inputs: { image: ['prepare', 0], batch_index: 0, length: 1 } },
      detect: { class_type: 'SAM3_Detect', inputs: { model: ['sam', 0], image: ['first_frame', 0], conditioning: ['subject', 0], threshold: 0.35, refine_iterations: 2, individual_masks: true } },
      select: { class_type: 'H3RelaySelectMask', inputs: { masks: ['detect', 0], selection: options.targetSelection || 'largest', index: Number(options.targetIndex || 0) } },
      track: { class_type: 'SAM3_VideoTrack', inputs: { model: ['sam', 0], images: ['prepare', 0], initial_mask: ['select', 0], conditioning: ['subject', 0], detection_threshold: 0.5, max_objects: 1, detect_interval: 1 } },
      mask: { class_type: 'SAM3_TrackToMask', inputs: { track_data: ['track', 0], object_indices: '' } },
      recover: { class_type: 'H3RelayRecoverMasks', inputs: { masks: ['mask', 0], images: ['prepare', 0], source_frames: length, model: ['sam', 0], conditioning: ['subject', 0], selection: ['select', 1], recover_empty_frames: true } },
      moge: { class_type: 'LoadMoGeModel', inputs: { model_name: CHARACTER_SWAP_MAP_MODELS.moge } },
      geometry: { class_type: 'MoGeInference', inputs: { moge_model: ['moge', 0], image: ['prepare', 0], resolution_level: 5, fov_x_degrees: 0, batch_size: 1, force_projection: true, apply_mask: true, refine_steps: 3 } },
      normals: { class_type: 'MoGeRender', inputs: { moge_geometry: ['geometry', 0], output: 'normal_directx' } },
      hybrid: { class_type: 'H3MapSinglePersonGuide', inputs: { images: ['prepare', 0], normals: ['normals', 0], masks: ['recover', 0], edge_feather: 0.01 } },
      video: { class_type: 'CreateVideo', inputs: { images: ['hybrid', 0], fps: 24, audio: ['source_audio', 0] } },
      save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: 'video/H3_CharacterSwap_MapGuide', format: 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 10 } },
    });
    return graph;
  }
  Object.assign(graph, {
    validate_guide: { class_type: 'H3MapValidateGuide', inputs: { images: ['prepare', 0], approved: true } },
    model: { class_type: 'UNETLoader', inputs: { unet_name: baseModels.referenceUnet, weight_dtype: 'default' } },
    shift: { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['model', 0], shift_video: 12, shift_audio: 3 } },
    dmad: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['shift', 0], lora_name: CHARACTER_SWAP_MAP_MODELS.dmad, strength_model: 1 } },
    adapter: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['dmad', 0], lora_name: CHARACTER_SWAP_MAP_MODELS.adapter, strength_model: 1 } },
    text: { class_type: 'CLIPLoader', inputs: { clip_name: swapModels.clip, type: 'minimax', device: 'cpu' } },
    text_memory: { class_type: 'H3RelayTextMemory', inputs: { clip: ['text', 0] } },
    video_vae: { class_type: 'VAELoader', inputs: { vae_name: swapModels.videoVae } },
    reference: { class_type: 'LoadImage', inputs: { image: identities[0].name } },
    conditioning: { class_type: 'BFSH3KeyframeConditioning', inputs: {
      clip: ['text_memory', 0], vae: ['video_vae', 0], model: ['adapter', 0], guide_video: ['validate_guide', 0],
      width, height, length, picture_1: ['reference', 0], mode: 'normal map guide',
      keyframe_until: 0.7, keyframe_until_drops: 'keyframes only', prompt_override: '',
    } },
    sampling_memory: { class_type: 'H3RelaySamplingMemory', inputs: { model: ['conditioning', 0], latent: ['conditioning', 2], conditioning: ['conditioning', 1], activation_memory_gib: 17 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: Number(options.seed ?? 42) } },
    guider: { class_type: 'CFGGuider', inputs: { model: ['sampling_memory', 0], positive: ['conditioning', 1], negative: ['conditioning', 1], cfg: 1 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'lcm' } },
    schedule: { class_type: 'BasicScheduler', inputs: { model: ['sampling_memory', 0], scheduler: 'simple', steps: 8, denoise: 1 } },
    sample: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['schedule', 0], latent_image: ['conditioning', 2] } },
    separate: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['separate', 0], vae: ['video_vae', 0] } },
    video: { class_type: 'CreateVideo', inputs: { images: ['decode', 0], fps: 24, audio: ['source_audio', 0] } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: 'video/H3_CharacterSwap_Map', format: 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 16 } },
  });
  return graph;
}
