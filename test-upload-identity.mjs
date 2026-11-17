import assert from 'node:assert/strict';
import { uploadImage, uploadMedia } from './src/workbench-api.js';

const originalFetch = globalThis.fetch;
const stored = new Map();
let responseNameOnly = false;
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/comfy/upload/image');
    assert.equal(options.method, 'POST');
    const form = options.body;
    assert.equal(form.get('overwrite'), 'false');
    assert.equal(form.get('type'), 'input');
    assert.equal(form.get('subfolder'), 'workbench');
    const file = form.get('image');
    const bytes = Buffer.from(await file.arrayBuffer());
    const original = file.name;
    let name = original;
    let index = 1;
    while (stored.has(name) && !stored.get(name).equals(bytes)) {
      const dot = original.lastIndexOf('.');
      name = `${original.slice(0, dot)} (${index++})${original.slice(dot)}`;
    }
    stored.set(name, bytes);
    return new Response(JSON.stringify({ name, ...(responseNameOnly ? {} : { subfolder: 'workbench' }) }));
  };
  for (const kind of ['image', 'video', 'audio']) {
    const name = `fixture.${{ image: 'png', video: 'mp4', audio: 'wav' }[kind]}`;
    const first = new File([`first ${kind}`], name);
    const second = new File([`second ${kind}`], name);
    const firstPath = await uploadMedia(first, kind);
    const secondPath = await uploadMedia(second, kind);
    assert.equal(firstPath, `workbench/${name}`);
    assert.equal(secondPath, `workbench/${name.replace('.', ' (1).')}`);
    assert.equal(await uploadMedia(first, kind), firstPath);
    assert.equal(stored.get(name).toString(), `first ${kind}`);
  }
  responseNameOnly = true;
  assert.equal(await uploadImage(new File(['plain'], 'plain.png')), 'plain.png');
  globalThis.fetch = async () => new Response('{}');
  for (const kind of ['image', 'video', 'audio']) {
    await assert.rejects(uploadMedia(new File(['bad'], 'bad.bin'), kind), /上传失败/);
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log('upload identity: prior bytes preserved; server identity used for image/video/audio');
