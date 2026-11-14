import assert from 'node:assert/strict';
import {
  buildVideoSuperResolutionWorkflow,
  getVideoSuperResolutionDependencyStatus,
  normalizeVideoSuperResolutionSettings,
  videoSuperResolutionOutputPrefix,
} from './src/video-super-resolution.js';

const options = { references: [{ kind: 'video', slot: 'guide', name: 'workbench/original.mp4' }] };
const rtx = buildVideoSuperResolutionWorkflow(options);
assert.equal(rtx.source.inputs.file, 'workbench/original.mp4');
assert.deepEqual(rtx.rtx.inputs.images, ['components', 0]);
assert.equal(rtx.rtx.inputs.resize_type, 'scale by multiplier');
assert.equal(rtx.rtx.inputs['resize_type.scale'], 2, 'use RTX SDK dynamic scale key, not the image resize multiplier key');
assert.equal(rtx.rtx.inputs.quality, 'ULTRA');
assert.equal(rtx.rtx.inputs.image_encoding, '8-bit RGB');
assert.deepEqual(rtx.video.inputs.images, ['rtx', 0]);
assert.equal(rtx.save.inputs.filename_prefix, 'video/H3_RTX_VFX');

const custom = buildVideoSuperResolutionWorkflow({ ...options, videoUpscaleScale: 1.5, rtxQuality: 'HIGHBITRATE_HIGH', rtxStrength: 0.75 });
assert.equal(custom.rtx.inputs['resize_type.scale'], 1.5);
assert.equal(custom.rtx.inputs.quality, 'HIGHBITRATE_HIGH');
assert.equal(custom.rtx.inputs.strength, 0.75);

for (const model of ['seedvr2_3b', 'seedvr2_7b']) {
  const graph = buildVideoSuperResolutionWorkflow({ ...options, videoUpscaleModel: model, seed: 123 });
  assert.equal(graph.model.inputs.unet_name, `${model}_int8_convrot.safetensors`);
  assert.equal(graph.vae.inputs.vae_name, 'seedvr2_ema_vae_fp16.safetensors');
  assert.deepEqual(graph.resize.inputs.input, ['components', 0]);
  assert.equal(graph.resize.inputs['resize_type.multiplier'], 2);
  assert.equal(graph.chunks.inputs.chunking_mode, 'manual');
  assert.equal(graph.chunks.inputs['chunking_mode.frames_per_chunk'], 21);
  assert.deepEqual(graph.conditioning.inputs.vae_conditioning, ['chunks', 0]);
  assert.deepEqual(graph.sample.inputs.latent_image, ['chunks', 0], 'conditioning and sampler must map over the same sequence of chunks');
  assert.deepEqual(graph.merge.inputs.latents, ['sample', 0]);
  assert.deepEqual(graph.merge.inputs.temporal_overlap, ['chunks', 1], 'merge uses effective overlap returned by the splitter');
  assert.equal(graph.sample.inputs.steps, 1);
  assert.equal(graph.sample.inputs.seed, 123);
  assert.deepEqual(graph.decode.inputs.samples, ['merge', 0]);
  assert.deepEqual(graph.postprocess.inputs.original_resized_images, ['resize', 0], 'remove 4n+1 padding against the complete original frame sequence');
  assert.deepEqual(graph.video.inputs.images, ['postprocess', 0]);
  assert.equal(graph.save.inputs.filename_prefix, 'video/H3_SeedVR2');
  for (const name of ['encode', 'decode']) {
    assert.equal(graph[name].inputs.temporal_size, 64, 'VAE temporal memory is bounded independently from sampling chunks');
    assert.equal(graph[name].inputs.temporal_overlap, 8);
  }
}

for (const model of ['rtx', 'seedvr2_3b', 'seedvr2_7b']) {
  const graph = buildVideoSuperResolutionWorkflow({ ...options, videoUpscaleModel: model, duration: 5, ratio: '16:9', resolution: '720P' });
  assert.deepEqual(graph.video.inputs.fps, ['components', 2], 'original FPS is not replaced by a constant');
  assert.deepEqual(graph.video.inputs.audio, ['components', 1], 'retain the original audio instead of synthesized audio');
  assert.deepEqual(graph.save.inputs.video, ['video', 0], 'SaveVideo must bind new video rather than LoadVideo source');
  assert.equal(graph.save.inputs['format.codec'], 'h264');
  assert.equal(graph.save.inputs['format.codec.encoding'], 're-encode');
  assert.equal(graph.save.inputs['format.codec.encoding.crf'], 16);
  const types = Object.values(graph).map((node) => node.class_type);
  assert.ok(!types.includes('ImageFromBatch') && !types.includes('TrimVideo') && !types.includes('TrimAudioDuration'), 'full-video processing cannot silently truncate to node duration');
  assert.ok(!Object.values(graph).some((node) => Object.values(node.inputs).some((value) => typeof value === 'string' && /^https?:/.test(value))), 'workflow contains no cloud media endpoints');
  for (const node of Object.values(graph)) {
    for (const input of Object.values(node.inputs)) {
      if (Array.isArray(input)) assert.ok(graph[input[0]], `all workflow links resolve: ${input[0]}`);
    }
  }
}

assert.throws(() => buildVideoSuperResolutionWorkflow(), /连接一段本地视频/);
assert.throws(() => buildVideoSuperResolutionWorkflow({ references: [{ kind: 'image', slot: 'guide', name: 'a.png' }] }), /连接一段本地视频/);
assert.throws(() => buildVideoSuperResolutionWorkflow({ references: [{ kind: 'video', slot: 'guide', name: '' }] }), /连接一段本地视频/);
for (const value of [0, 0.5, 4.01, NaN, Infinity, 'invalid']) assert.throws(() => normalizeVideoSuperResolutionSettings({ videoUpscaleScale: value }), /倍率/);
for (const value of [-0.1, 1.1, NaN, Infinity, 'invalid']) assert.throws(() => normalizeVideoSuperResolutionSettings({ rtxStrength: value }), /强度/);
for (const rtxQuality of ['BICUBIC', 'DENOISE_HIGH', 'DEBLUR_HIGH', 'unknown']) assert.throws(() => normalizeVideoSuperResolutionSettings({ rtxQuality }), /质量档位/, 'non-upscale modes cannot masquerade as RTX super resolution');
assert.throws(() => normalizeVideoSuperResolutionSettings({ videoUpscaleModel: 'cloud' }), /未知/);
assert.throws(() => videoSuperResolutionOutputPrefix('cloud'), /未知/);
for (const seed of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) assert.throws(() => buildVideoSuperResolutionWorkflow({ ...options, videoUpscaleModel: 'seedvr2_3b', seed }), /种子/);
assert.deepEqual(normalizeVideoSuperResolutionSettings(), { videoUpscaleModel: 'rtx', videoUpscaleScale: 2, rtxQuality: 'ULTRA', rtxStrength: 1 });

const rtxDefinition = {
  input: { required: {
    images: ['IMAGE', {}],
    resize_type: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'scale by multiplier', inputs: { required: { scale: ['FLOAT', { min: 1, max: 4 }] } } }] }],
    quality: ['COMBO', { options: ['LOW', 'ULTRA'] }],
    strength: ['FLOAT', { min: 0, max: 1 }],
    image_encoding: ['COMBO', { options: ['8-bit RGB'] }],
  } },
  output: ['IMAGE'],
};
const classFixture = (graph) => Object.fromEntries(Object.values(graph).map((node) => [node.class_type, {}]));
const rtxDefinitions = { ...classFixture(rtx), RTXVideoSuperResolution: rtxDefinition };
const requestedPaths = [];
assert.deepEqual(await getVideoSuperResolutionDependencyStatus(rtx, async (path) => { requestedPaths.push(path); return rtxDefinitions; }), { ready: true, missing: [] });
assert.deepEqual(requestedPaths, ['/object_info'], 'one read-only JSON request; no prompt, install or model download');
const noRtx = structuredClone(rtxDefinitions); delete noRtx.RTXVideoSuperResolution;
assert.deepEqual(await getVideoSuperResolutionDependencyStatus(rtx, async () => noRtx), { ready: false, missing: ['ComfyUI 节点 RTXVideoSuperResolution'] });
for (const mutate of [
  (schema) => { schema.input.required.resize_type = [['scale by multiplier']]; },
  (schema) => { schema.input.required.resize_type[1].options[0].inputs.required = { multiplier: ['FLOAT', { min: 1, max: 4 }] }; },
  (schema) => { schema.input.required.resize_type[1].options[0].inputs.required.scale = ['FLOAT', { min: 1, max: 1.5 }]; },
]) {
  const definitions = structuredClone(rtxDefinitions); mutate(definitions.RTXVideoSuperResolution);
  const dependencies = await getVideoSuperResolutionDependencyStatus(rtx, async () => definitions);
  assert.equal(dependencies.ready, false);
  assert.ok(dependencies.missing.some((item) => item.includes('resize_type.scale')), 'older/incompatible dynamic fields must stop before submitting');
}
for (const key of ['images', 'quality', 'strength', 'image_encoding']) {
  const definitions = structuredClone(rtxDefinitions); delete definitions.RTXVideoSuperResolution.input.required[key];
  const dependencies = await getVideoSuperResolutionDependencyStatus(rtx, async () => definitions);
  assert.equal(dependencies.ready, false, `missing RTX field ${key} must stop`);
}
const legacyRtx = structuredClone(rtxDefinitions);
legacyRtx.RTXVideoSuperResolution.input.required.quality = [['ULTRA']];
legacyRtx.RTXVideoSuperResolution.input.required.image_encoding = [['8-bit RGB']];
assert.equal((await getVideoSuperResolutionDependencyStatus(rtx, async () => legacyRtx)).ready, true, 'legacy non-dynamic enumeration remains supported');

const seedGraph = buildVideoSuperResolutionWorkflow({ ...options, videoUpscaleModel: 'seedvr2_7b' });
for (const combo of [(files) => [files], (files) => ['COMBO', { options: files }]]) {
  const definitions = {
    ...classFixture(seedGraph),
    UNETLoader: { input: { required: { unet_name: combo(['seedvr2_3b_int8_convrot.safetensors', 'seedvr2_7b_int8_convrot.safetensors']) } } },
    VAELoader: { input: { required: { vae_name: combo(['seedvr2_ema_vae_fp16.safetensors']) } } },
  };
  assert.equal((await getVideoSuperResolutionDependencyStatus(seedGraph, async () => definitions)).ready, true);
  delete definitions.SeedVR2TemporalChunk;
  assert.ok((await getVideoSuperResolutionDependencyStatus(seedGraph, async () => definitions)).missing.includes('ComfyUI 节点 SeedVR2TemporalChunk'));
  definitions.SeedVR2TemporalChunk = {};
  definitions.UNETLoader.input.required.unet_name = combo(['seedvr2_3b_int8_convrot.safetensors']);
  assert.deepEqual((await getVideoSuperResolutionDependencyStatus(seedGraph, async () => definitions)).missing, ['seedvr2_7b_int8_convrot.safetensors'], 'only selected model must be available');
  definitions.UNETLoader.input.required.unet_name = combo(['seedvr2_7b_int8_convrot.safetensors']);
  definitions.VAELoader.input.required.vae_name = combo([]);
  assert.deepEqual((await getVideoSuperResolutionDependencyStatus(seedGraph, async () => definitions)).missing, ['seedvr2_ema_vae_fp16.safetensors']);
}
for (const graph of [null, [], {}, { invalid: null }, { invalid: {} }]) await assert.rejects(getVideoSuperResolutionDependencyStatus(graph, async () => ({})), /工作流无效/);
await assert.rejects(getVideoSuperResolutionDependencyStatus(rtx, async () => null), /无法读取/);
await assert.rejects(getVideoSuperResolutionDependencyStatus(rtx, async () => { throw new Error('backend offline'); }), /backend offline/, 'transport failures propagate and cannot become ready');
console.log('VIDEO_SUPER_RESOLUTION_OK rtx=true seedvrTemporal=true originalFpsAudio=true sourcePreviewExcluded=true');
