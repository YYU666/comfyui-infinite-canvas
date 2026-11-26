import assert from 'node:assert/strict';
globalThis.window = { location: { hostname: '127.0.0.1' } };
const { uploadMedia } = await import('./src/workbench-api.js');
const files = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, { method, body }) => {
  assert.equal(url, '/api/comfy/upload/image');
  assert.equal(method, 'POST');
  assert.equal(body.get('overwrite'), 'false');
  assert.equal(body.get('type'), 'input');
  assert.equal(body.get('subfolder'), 'workbench');
  const file = body.get('image');
  const content = await file.text();
  let name = file.name;
  let index = 1;
  // ComfyUI preserves equal bytes and suffixes differing same-name uploads.
  while (files.has(name) && files.get(name) !== content) name = file.name.replace(/(\.[^.]+)$/, ` (${index++})$1`);
  files.set(name, content);
  return new Response(JSON.stringify({ name, subfolder: 'workbench', type: 'input' }));
};
try {
  const first = await uploadMedia(new File(['first result'], 'save_00001_.png'));
  const second = await uploadMedia(new File(['second result'], 'save_00001_.png'));
  assert.equal(first, 'workbench/save_00001_.png');
  assert.equal(second, 'workbench/save_00001_ (1).png');
  assert.equal(files.get('save_00001_.png'), 'first result');
  assert.equal(files.get('save_00001_ (1).png'), 'second result');
  assert.equal(await uploadMedia(new File(['first result'], 'save_00001_.png')), first);
} finally { globalThis.fetch = originalFetch; }
console.log('UPLOAD_MEDIA_IDENTITY_OK overwrite=false returnedUniqueNames=true originalsPreserved=true');
