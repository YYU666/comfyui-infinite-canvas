import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildImageWorkflow, buildQwen21EditWorkflow, resolveImageDimensions } from './src/workbench-api.js';
import { FLUX3_KLEIN_MODEL, getFlux3KleinDependencyStatus } from './src/flux3-klein.js';

const base = { seed: 42, prompt: 'A red ceramic cup on a wooden table.', imageLora: 'none' };
for (const resolution of ['1MP', '2K', '4K']) {
  const graph = buildImageWorkflow({ ...base, imageModel: 'flux3_klein', ratio: '9:16', flux3Resolution: resolution });
  assert.deepEqual([graph.latent.inputs.width, graph.latent.inputs.height], resolveImageDimensions('9:16', resolution));
}
const text = buildImageWorkflow({ ...base, mode: 'image', imageModel: 'flux3_klein', ratio: '16:9', flux3Resolution: '4K' });
assert.deepEqual([text.latent.inputs.width, text.latent.inputs.height], resolveImageDimensions('16:9', '4K'));
assert.equal(Math.max(text.latent.inputs.width, text.latent.inputs.height), 4096);
assert.equal(text.sample.inputs.steps, 16);
assert.equal(text.model.inputs.unet_name, FLUX3_KLEIN_MODEL.unet);
assert.equal(text.upsampler.inputs.clip_name, FLUX3_KLEIN_MODEL.upsampler);
assert.deepEqual(text.positive.inputs.text, ['caption', 0]);
assert.match(text.caption.inputs.system_prompt, /text-to-image/);
assert.match(text.caption.inputs.prompt, /^TARGET CANVAS: 4096:2336/);
const refs = Array.from({ length: 10 }, (_, i) => ({ id: `ref${i + 1}`, kind: 'image', slot: 'references', name: `${i + 1}.png` }));
const edit = buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', prompt: 'Keep 图2 and borrow the colors of 图1.', references: refs, qwenReferenceOrder: ['ref2', 'ref1'], qwenRefResolution: 1536 });
assert.equal(edit.reference_1.inputs.image, '2.png');
assert.equal(edit.reference_2.inputs.image, '1.png');
assert.equal(Object.keys(edit.encode.inputs).filter((key) => key.startsWith('images.image')).length, 10);
assert.match(edit.caption.inputs.prompt, /reference image 2.*reference image 1/);
assert.match(edit.caption.inputs.system_prompt, /image-editing/);
assert.deepEqual(edit.caption.inputs.image, ['caption_batch_10', 0]);
assert.deepEqual(edit.caption_batch_2.inputs.image1, ['caption_image_1', 0]);
assert.equal(edit.caption_image_1.class_type, 'ResizeAndPadImage');
assert.equal(edit.encode.inputs['resolution.megapixels'], 2.25);
assert.equal(edit.output_size.inputs.megapixels, 1, 'output size must not inherit Qwen reference precision');
assert.deepEqual(edit.sample.inputs.latent_image, ['latent', 0]);
const edit4k = buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', references: refs.slice(0, 1), flux3Resolution: '4K' });
assert.equal(edit4k.output_size.inputs.largest_size, 4096);
const edit2k = buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', references: refs.slice(0, 1), flux3Resolution: '2K', qwenRefResolution: 768 });
assert.equal(edit2k.output_size.inputs.largest_size, 2048);
assert.equal(edit2k.encode.inputs['resolution.megapixels'], 0.5625);
assert.throws(() => buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', references: [] }), /至少需要一张/);
assert.throws(() => buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', references: [...refs, { ...refs[0], id: 'extra', name: 'extra.png' }] }), /最多连接 10/);
assert.throws(() => buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', references: [refs[0], { kind: 'image', slot: 'mask', name: 'mask.png' }] }), /遮罩/);
assert.throws(() => buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', references: refs, qwenSourceCrop: { x: 0, y: 0, width: 100, height: 100 } }), /裁切/);
assert.throws(() => buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', references: refs, qwenMaskCrop: true }), /遮罩/);
assert.throws(() => buildQwen21EditWorkflow({ ...base, qwenModel: 'flux3_klein', references: refs, imageLora: 'qwen21Realism' }), /LoRA/);
assert.throws(() => buildImageWorkflow({ ...base, imageModel: 'flux3_klein', flux3Resolution: 'invalid' }), /输出尺寸/);

const originalFetch = globalThis.fetch;
try {
  let missingNode, missingType = false;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => {
    const name = url.split('/').at(-1);
    if (name === missingNode) return {};
    return { [name]: { input: { required: name === 'UNETLoader' ? { unet_name: [[FLUX3_KLEIN_MODEL.unet]] }
      : name === 'CLIPLoader' ? { clip_name: [[FLUX3_KLEIN_MODEL.clip, FLUX3_KLEIN_MODEL.upsampler]], type: [missingType ? ['flux2'] : ['flux3']] }
        : name === 'VAELoader' ? { vae_name: [[FLUX3_KLEIN_MODEL.vae]] } : {} } } };
  } });
  for (const graph of [text, edit, edit4k]) assert.equal((await getFlux3KleinDependencyStatus(graph)).ready, true);
  for (const graph of [text, edit, edit4k]) {
    for (const classType of new Set(Object.values(graph).map((node) => node.class_type))) {
      missingNode = classType;
      const result = await getFlux3KleinDependencyStatus(graph);
      assert.equal(result.ready, false, `must block missing ${classType}`);
      assert.ok(result.missing.includes(`ComfyUI 节点 ${classType}`));
    }
  }
  missingNode = undefined;
  missingType = true;
  assert.ok((await getFlux3KleinDependencyStatus(text)).missing.includes('ComfyUI 的 flux3 文本编码器支持'));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  const missing = await getFlux3KleinDependencyStatus(text);
  assert.equal(missing.ready, false);
  assert.ok(missing.missing.includes(FLUX3_KLEIN_MODEL.unet));
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(getFlux3KleinDependencyStatus(text), /确认 ComfyUI 在线/);
} finally { globalThis.fetch = originalFetch; }
await mkdir('.cache/flux3-klein', { recursive: true });
await writeFile('.cache/flux3-klein/graphs.json', JSON.stringify({ text, edit, edit4k }, null, 2));
console.log('FLUX3_KLEIN_OK text/edit, mandatory upsampler, 10 ordered references, independent size, incompatible inputs, dependency checks');
