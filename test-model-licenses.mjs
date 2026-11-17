import test from 'node:test';
import assert from 'node:assert/strict';
import { modelLicense, nodeModelPaths, nodeModelLicenses } from './src/model-licenses.js';
import { buildHdRefineWorkflow, buildOutfitQuadWorkflow } from './src/workbench-api.js';

test('H3 image and video use distinct official licenses with the four excluded territories', () => {
  const video = modelLicense('diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors');
  const image = modelLicense('vae/minimax_h3_image_vae_fp16.safetensors');
  assert.notEqual(video.licenseUrl, image.licenseUrl);
  for (const info of [video, image]) assert.deepEqual(info.excludedTerritories, ['欧盟', '英国', '韩国', '美国']);
  assert.equal(modelLicense('diffusion_models/Moss_image\\moss_image_sft_int8_convrot.safetensors').license, 'Apache-2.0');
  assert.equal(modelLicense('unknown.safetensors').license, '许可待核实');
  const upscaler = modelLicense('latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors');
  assert.match(upscaler.license, /Apache-2.0/);
  assert.match(upscaler.territoryLicenseUrl, /MiniMaxAI\/MiniMax-H3/);
});

test('Muse V4 lists the actual Identity Edit LoRA and its commercial restriction', () => {
  const options = { mode: 'outfitEdit', outfitModel: 'muse_v4', outfitPanel: 'br', outfitUpscale: 'off', seed: 42, prompt: 'synthetic outfit', references: [{ slot: 'guide', kind: 'image', name: 'synthetic.png' }] };
  const graph = buildOutfitQuadWorkflow(options);
  const categories = { unet_name: 'diffusion_models', clip_name: 'text_encoders', vae_name: 'vae', lora_name: 'loras' };
  const actual = Object.values(graph).flatMap(node => Object.entries(node.inputs).filter(([key]) => categories[key]).map(([key, name]) => `${categories[key]}/${name}`));
  assert.deepEqual(nodeModelPaths(options).sort(), [...new Set(actual)].sort());
  const identity = nodeModelLicenses(options).find(info => info.path.includes('identity_edit_v2'));
  assert.match(identity.restrictions, /非商用|商业用途|书面/);
});

test('local model notices follow the selected recipe and HD refine actual graph', () => {
  const moss = nodeModelLicenses({ mode: 'image', imageModel: 'moss' });
  assert.ok(moss.every(info => info.license.startsWith('Apache-2.0')));
  const graph = buildHdRefineWorkflow({ prompt: '', seed: 42, references: [{ slot: 'guide', kind: 'video', name: 'synthetic.mp4' }] });
  const categories = { unet_name: 'diffusion_models', clip_name: 'text_encoders', vae_name: 'vae', lora_name: 'loras', model_name: 'latent_upscale_models' };
  const actual = Object.values(graph).flatMap(node => Object.entries(node.inputs).filter(([key]) => categories[key]).map(([key, name]) => `${categories[key]}/${name}`));
  assert.deepEqual(nodeModelPaths({ mode: 'upscale' }).sort(), [...new Set(actual)].sort());
  assert.ok(nodeModelPaths({ mode: 'qwenEdit', qwenModel: 'turbo' }).includes('diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors'));
  assert.ok(nodeModelPaths({ mode: 'outfitEdit', outfitUpscale: 'auto' }).includes('diffusion_models/seedvr2_3b_int8_convrot.safetensors'));
});
