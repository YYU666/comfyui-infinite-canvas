import assert from 'node:assert/strict';
import { thumbnailUrl, hydrateProjectMedia } from './src/canvas-thumbnails.js';
import { persistentCanvas } from './src/auto-save.js';

const input = [{ id: 'ref-1', type: 'media', data: { localFile: true, assetPath: 'assets/图 1.png', remoteName: 'upstream.png', referenceTag: '图1' } }];
const nodes = hydrateProjectMedia(input, 'prj_fixture');
assert.equal(nodes[0].data.url, '/api/projects/prj_fixture/assets/%E5%9B%BE%201.png');
assert.equal(nodes[0].data.remoteName, 'upstream.png');
assert.equal(nodes[0].data.referenceTag, '图1');
assert.equal(input[0].data.url, undefined, 'hydration is non-mutating and performs no reads');
assert.equal(persistentCanvas({ nodes }).nodes[0].data.url, undefined, 'derived URL does not enter project persistence');
const preview = new URL(thumbnailUrl(nodes[0].data.url), 'http://fixture');
assert.equal(preview.searchParams.get('asset'), 'assets/图 1.png');
const comfy = new URL(thumbnailUrl('/api/comfy/view?filename=out.png&subfolder=hello&type=output&rand=123'), 'http://fixture');
assert.equal(comfy.searchParams.get('filename'), 'out.png');
assert.equal(comfy.searchParams.get('type'), 'output');
assert.equal(comfy.searchParams.has('rand'), false, 'unstable cache-busters do not fragment thumbnail cache');
for (const source of ['https://evil/image.png', '//evil/image.png', '/api/comfy/view?filename=..%2Fevil.png', '/api/comfy/view?filename=x.png&type=invalid', '/api/projects/prj_x/assets/%2E%2E%5Cevil.png']) {
  assert.equal(thumbnailUrl(source), null, source);
}
assert.equal(hydrateProjectMedia([{ type: 'media', data: { assetPath: 'assets/../secret.png' } }], 'prj_fixture')[0].data.url, null);
console.log('CANVAS_THUMBNAIL_IDENTITIES_OK originalsPreserved=true unsafeSourcesRejected=true');
