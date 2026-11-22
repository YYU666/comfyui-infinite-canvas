import sourceLock from '../models/official-sources.lock.json' with { type: 'json' };
import ledger from '../models/licenses.json' with { type: 'json' };
import h3Image from '../models/h3-image-sources.json' with { type: 'json' };
import klein from '../models/flux3-klein.json' with { type: 'json' };
import notices from '../models/license-notices.json' with { type: 'json' };
import { IMAGE_MODEL, IMAGE_LORAS, MOSS_IMAGE_MODEL, QWEN21_EDIT_MODEL, VERSIONED_IMAGE_MODELS, MODEL_INFO, IDENTITY_EDIT_MODEL, CHARACTER_SWAP_MODELS, HD_REFINE_MODEL, HD_REFINE_TURBO } from './workbench-api.js';
import { H3_IMAGE_MODEL } from './h3-image.js';
import { FLUX3_KLEIN_MODEL } from './flux3-klein.js';

const records = new Map(ledger.files.map(row => [row.path, row]));
for (const row of sourceLock.files) if (!records.has(row.path)) records.set(row.path, row);
for (const row of h3Image.files) records.set(row.path, { ...row, ...notices.h3Image });
for (const row of klein.files) records.set(row.path, { ...row, license: klein.license.name, licenseUrl: klein.license.url });

export function modelLicense(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  const record = records.get(normalized);
  if (!record) return { path: normalized, license: '许可待核实', licenseUrl: null, restrictions: '精确权重尚无已核实许可记录，请查作者原文；不推定可商用或再分发。' };
  const notice = record.license?.includes('H3') ? (record.license.includes('H3-Image') ? notices.h3Image : notices.h3Video) : {};
  return { ...notice, ...record, ...(/^(MiniMax H3|MiniMax-H3)/.test(record.license) ? { licenseUrl: notice.licenseUrl } : {}), territoryLicenseUrl: notice.licenseUrl, path: normalized };
}

// List the actual selected base/encoder/VAE/optional LoRA rather than treating the
// workbench code license as permission to use every model in a recipe.
export function nodeModelPaths(data = {}) {
  const paths = [];
  const add = (category, name) => { if (name) paths.push(`${category}/${name}`.replaceAll('\\', '/')); };
  const image = (model) => { add('diffusion_models', model.unet); add('text_encoders', model.clip); add('vae', model.vae); };
  const mode = data.mode || 'reference';
  if (mode === 'mossPose') {
    image(MOSS_IMAGE_MODEL); add('loras', 'moss_image_sft_pose_control_lora.safetensors');
    if (data.poseHasIdentity) image(QWEN21_EDIT_MODEL);
  }
  else if ((mode === 'image' && data.imageModel === 'h3_image') || (mode === 'qwenEdit' && data.qwenModel === 'h3_image')) image(H3_IMAGE_MODEL);
  else if ((mode === 'image' && data.imageModel === 'flux3_klein') || (mode === 'qwenEdit' && data.qwenModel === 'flux3_klein')) { image(FLUX3_KLEIN_MODEL); add('text_encoders', FLUX3_KLEIN_MODEL.upsampler); }
  else if (mode === 'image' && data.imageModel === 'moss') image(MOSS_IMAGE_MODEL);
  else if (mode === 'image') { image(IMAGE_MODEL); add('loras', IMAGE_LORAS[data.imageLora]); }
  else if (mode === 'imageUpscale') { add('diffusion_models', data.upscaleModel === 'seedvr2_7b' ? VERSIONED_IMAGE_MODELS.seedvr7b : IMAGE_MODEL.hdUnet); add('vae', IMAGE_MODEL.hdVae); }
  else if (mode === 'identityEdit') { image({ ...IMAGE_MODEL, unet: IDENTITY_EDIT_MODEL.unet }); add('loras', IDENTITY_EDIT_MODEL.lora); if (data.quadView) add('loras', IDENTITY_EDIT_MODEL.quadViewLora); }
  else if (['qwenEdit', 'characterSheet', 'outfitEdit', 'localRealism'].includes(mode)) {
    if (mode === 'outfitEdit' && data.outfitModel === 'muse_v4') {
      image({ ...IMAGE_MODEL, unet: VERSIONED_IMAGE_MODELS.museV4 }); add('loras', IDENTITY_EDIT_MODEL.lora);
    } else {
      image({ ...QWEN21_EDIT_MODEL, unet: (mode === 'qwenEdit' && data.qwenModel === 'turbo') || (mode === 'outfitEdit' && data.outfitModel === 'qwen21_turbo') ? VERSIONED_IMAGE_MODELS.qwenTurbo : QWEN21_EDIT_MODEL.unet });
      if (data.imageLora === 'qwen21Realism') add('loras', QWEN21_EDIT_MODEL.realismLora);
    }
    if (mode === 'outfitEdit' && data.outfitUpscale !== 'off') { add('diffusion_models', data.outfitUpscale === 'seedvr2_7b' ? VERSIONED_IMAGE_MODELS.seedvr7b : IMAGE_MODEL.hdUnet); add('vae', IMAGE_MODEL.hdVae); }
  } else if (['swap', 'upscale'].includes(mode)) {
    add('diffusion_models', MODEL_INFO.referenceUnet); add('text_encoders', CHARACTER_SWAP_MODELS.clip);
    add('vae', CHARACTER_SWAP_MODELS.videoVae); add('vae', MODEL_INFO.audioVae); add('loras', CHARACTER_SWAP_MODELS.characterLora);
    add('loras', mode === 'upscale' ? HD_REFINE_TURBO : CHARACTER_SWAP_MODELS.turboLora);
    if (mode === 'upscale') add('latent_upscale_models', HD_REFINE_MODEL);
    else add('checkpoints', CHARACTER_SWAP_MODELS.samCheckpoint);
  } else {
    add('diffusion_models', ['frames', 'text'].includes(mode) ? MODEL_INFO.unet : MODEL_INFO.referenceUnet);
    add('text_encoders', MODEL_INFO.clip); add('vae', MODEL_INFO.videoVae); add('vae', MODEL_INFO.audioVae);
    if (data.turbo !== false) add('loras', ['frames', 'text'].includes(mode) ? MODEL_INFO.turboLora : MODEL_INFO.referenceTurboLora);
  }
  return [...new Set(paths)];
}

export function nodeModelLicenses(data) { return nodeModelPaths(data).map(modelLicense); }
