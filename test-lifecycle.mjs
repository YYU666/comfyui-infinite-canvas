import assert from 'node:assert/strict';
import { GenerationAttempts } from './src/generation-attempts.js';
import { mediaCacheIdentity, reconcileMediaCache, assertMediaCacheIdentity } from './src/canvas-media-cache.js';
import { flushProjectAfterMedia } from './src/project-save-barrier.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Upload-flight cancellation is local and cannot fall through to submission.
{
  const attempts = new GenerationAttempts();
  const attempt = attempts.begin('node');
  const upload = deferred();
  let submitted = 0;
  const run = (async () => {
    await upload.promise;
    attempts.assert('node', attempt);
    submitted += 1;
  })();
  attempts.cancel('node');
  upload.resolve('uploaded');
  await assert.rejects(run, { code: 'GENERATION_CANCELLED' });
  assert.equal(submitted, 0);
  const retry = attempts.begin('node');
  attempts.assert('node', retry);
  assert.equal(attempts.isCurrent('node', attempt), false);
}

// A -> B -> undo uploads A bytes; undo -> redo uploads B bytes.
{
  const a = { id: 'media', data: { assetPath: 'assets/a', mediaStorageId: 'a', localFile: true, url: 'blob:a' } };
  const b = { id: 'media', data: { assetPath: 'assets/b', mediaStorageId: 'b', localFile: true, url: 'blob:b' } };
  const urls = new Map([['blob:a', new TextEncoder().encode('A-bytes')], ['blob:b', new TextEncoder().encode('B-bytes')]]);
  let files = { media: 'File-B' };
  let identities = { media: mediaCacheIdentity(b.data) };
  ({ files, identities } = reconcileMediaCache([a], files, identities));
  assert.equal(files.media, undefined);
  const uploadBytes = async (node) => {
    assertMediaCacheIdentity(node, files[node.id], identities[node.id]);
    if (!files[node.id]) {
      files[node.id] = `File-${node.data.assetPath.endsWith('/a') ? 'A' : 'B'}`;
      identities[node.id] = mediaCacheIdentity(node.data);
    }
    return urls.get(node.data.url);
  };
  assert.equal(new TextDecoder().decode(await uploadBytes(a)), 'A-bytes');
  ({ files, identities } = reconcileMediaCache([b], files, identities));
  assert.equal(new TextDecoder().decode(await uploadBytes(b)), 'B-bytes');
  assert.throws(() => assertMediaCacheIdentity(a, 'File-B', mediaCacheIdentity(b.data)), /缓存与当前资产不一致/);
}

// Leaving with no previously dirty snapshot still waits and flushes new refs.
{
  const write = deferred();
  const mediaWrites = new Map([['media', write.promise]]);
  let flushed = false;
  let committedAsset = null;
  const leaving = flushProjectAfterMedia({
    mediaWrites,
    observeAndFlush: async () => { flushed = true; assert.equal(committedAsset, 'assets/new'); },
  });
  await Promise.resolve();
  assert.equal(flushed, false);
  committedAsset = 'assets/new';
  write.resolve();
  await leaving;
  assert.equal(flushed, true);
}

// A failed media write keeps the current page by not entering project close.
{
  const mediaWrites = new Map([['media', Promise.reject(new Error('disk full'))]]);
  let closed = false;
  await assert.rejects(flushProjectAfterMedia({ mediaWrites, observeAndFlush: async () => { closed = true; } }), /disk full/);
  assert.equal(closed, false);
}

console.log('lifecycle tests passed');
