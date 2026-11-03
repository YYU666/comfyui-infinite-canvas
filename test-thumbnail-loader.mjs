import assert from 'node:assert/strict';
import { ThumbnailLoader } from './src/thumbnail-loader.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const response = () => new Response('small derivative', { headers: { 'Content-Type': 'image/webp' } });
let active = 0, peak = 0, serial = 0;
const requests = [], revoked = [], loaded = [], failed = [];
const loader = new ThumbnailLoader({
  fetcher: (url, { signal }) => new Promise((resolve, reject) => {
    active++; peak = Math.max(peak, active);
    const abort = () => { active--; reject(signal.reason); };
    const request = { url, finish() { signal.removeEventListener('abort', abort); active--; resolve(response()); } };
    requests.push(request);
    signal.addEventListener('abort', abort, { once: true });
  }),
  createUrl: () => `blob:thumbnail-${++serial}`, revokeUrl: (url) => revoked.push(url),
});
const subscribe = (url, id) => loader.subscribe(url, (objectUrl) => loaded.push([id, objectUrl]), (error) => failed.push(error));
const first = subscribe('/api/thumbnails?filename=first.png', 'first');
const shared = subscribe('/api/thumbnails?filename=first.png', 'shared');
const second = subscribe('/api/thumbnails?filename=second.png', 'second');
const cancelled = subscribe('/api/thumbnails?filename=cancelled.png', 'cancelled');
const fourth = subscribe('/api/thumbnails?filename=fourth.png', 'fourth');
assert.equal(requests.length, 2, 'only two visible requests begin');
cancelled();
first();
assert.equal(active, 2, 'removing one subscriber must not abort the shared request');
requests[0].finish(); await tick();
assert.equal(requests.length, 3, 'finished request starts next non-cancelled item');
assert.ok(requests.every((request) => !request.url.includes('cancelled')));
assert.equal(loaded.length, 1);
assert.equal(loaded[0][0], 'shared', 'unsubscribed node never gets stale state');
const cached = subscribe('/api/thumbnails?filename=first.png', 'cached');
assert.equal(loaded[1][1], loaded[0][1], 'mounted duplicate shares successful object URL');
shared(); assert.equal(revoked.length, 0, 'other subscriber still owns object URL');
cached(); assert.equal(revoked.length, 1, 'last subscriber releases object URL');
second(); fourth(); await tick();
assert.equal(active, 0);
assert.equal(peak, 2);
assert.deepEqual(failed, [], 'cancelled in-flight requests never display errors');
assert.equal(loader.jobs.size, 0);
assert.equal(loader.queue.length, 0);

let attempts = 0;
const retryLoader = new ThumbnailLoader({ fetcher: async () => ++attempts < 3 ? new Response('', { status: 503 }) : response(),
  retryDelays: [0, 0], createUrl: () => 'blob:retry', revokeUrl() {} });
let release;
await new Promise((resolve, reject) => { release = retryLoader.subscribe('/api/thumbnails?filename=busy.png', resolve, reject); });
assert.equal(attempts, 3, 'transient busy retries twice then succeeds');
release();
attempts = 0;
const unavailable = new ThumbnailLoader({ fetcher: async () => { attempts++; return new Response('', { status: 503 }); }, retryDelays: [0, 0] });
await new Promise((resolve, reject) => { release = unavailable.subscribe('/api/thumbnails?filename=unavailable.png', reject, resolve); });
release();
assert.equal(attempts, 3, 'persistent busy has a finite retry budget');

let lateResolve, lateLoads = 0, lateCreates = 0;
const ignoringAbort = new ThumbnailLoader({ fetcher: () => new Promise((resolve) => { lateResolve = resolve; }), createUrl: () => { lateCreates++; return 'blob:late'; } });
const cancelLate = ignoringAbort.subscribe('/api/thumbnails?filename=late.png', () => lateLoads++, () => lateLoads++);
cancelLate(); lateResolve(response()); await tick();
assert.equal(lateLoads, 0); assert.equal(lateCreates, 0, 'aborted completion cannot allocate a leaked object URL');
console.log('THUMBNAIL_LOADER_OK concurrency=2 sharedRequests=true queuedAndInflightCancellation=true noStaleCallbacks=true refcountedUrls=true busyRetries=2');
