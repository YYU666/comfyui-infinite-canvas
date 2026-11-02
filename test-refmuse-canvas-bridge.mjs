import assert from 'node:assert/strict';
import { createRefmuseCanvasBridge, normalizeRefmuseReference, REFMUSE_IMAGE_LIMIT } from './src/refmuse-canvas-bridge.js';

const sent = []; const imports = []; let release; let readonly = false; let visible = true;
const frame = { postMessage: (data, origin) => sent.push({ data, origin }) };
let ready = 0; const themes = [];
const bridge = createRefmuseCanvasBridge({
  getFrame: () => frame, channel: 'channel', isActive: () => visible, isReadOnly: () => readonly, isBusy: () => false,
  onReady: () => ready++, onTheme: theme => themes.push(theme), onBusy() {}, onMessage() {},
  onImport: async (...args) => { imports.push(args); await new Promise((resolve) => { release = resolve; }); },
});
const event = (id, extra = {}) => ({ source: frame, origin: 'https://refmuse.cn', data: {
  type: 'refmuse.canvas.import', version: 1, channel: 'channel', requestId: id,
  blob: new Blob(['fixture'], { type: 'image/png' }), reference: { title: '场景', sourceUrl: 'https://example.com/art' }, ...extra,
} });
bridge.init(); assert.equal(sent.length, 2); sent.length = 0;
await bridge.receive({ ...event('wrong-origin'), origin: 'https://evil.test' });
await bridge.receive({ ...event('wrong-frame'), source: {} });
await bridge.receive(event('wrong-channel', { channel: 'bad' }));
await bridge.receive(event('wrong-version', { version: 2 }));
assert.equal(imports.length, 0); assert.equal(sent.length, 0);
await bridge.receive(event('ready', { type: 'refmuse.canvas.ready' })); assert.equal(ready, 1);
await bridge.receive(event('theme', { type: 'refmuse.canvas.theme', theme: 'dark' }));
await bridge.receive(event('ready-theme', { type: 'refmuse.canvas.ready', theme: 'light' }));
for (const extra of [{ theme:'url(evil)' }, { theme:'dark', channel:'wrong' }, { theme:'dark', version:2 }]) await bridge.receive(event('bad-theme', { type:'refmuse.canvas.theme', ...extra }));
await bridge.receive({ ...event('bad-theme', { type:'refmuse.canvas.theme',theme:'dark' }),origin:'https://evil.test' });
await bridge.receive({ ...event('bad-theme', { type:'refmuse.canvas.theme',theme:'dark' }),source:{} });
assert.deepEqual(themes, ['dark','light']);
assert.equal(ready, 2, 'theme notifications do not announce readiness');
const first = bridge.receive(event('one'));
const duplicate = bridge.receive(event('one'));
assert.equal(imports.length, 1); assert.equal(sent.length, 0, 'no ack before save');
await bridge.receive(event('two')); assert.equal(sent.at(-1).data.ok, false, 'concurrent imports blocked');
release(); await Promise.all([first, duplicate]);
assert.equal(imports.length, 1); assert.equal(sent.at(-1).data.ok, true);
await bridge.receive(event('one')); assert.equal(imports.length, 1, 'completed receipt is idempotent');
assert.equal(imports[0][0].name, '场景.png'); assert.equal(imports[0][1], 'refmuse');
assert.equal(imports[0][2].sourceUrl, 'https://example.com/art');
readonly = true; await bridge.receive(event('readonly')); assert.equal(sent.at(-1).data.ok, false); readonly = false;
await bridge.receive(event('not-blob', { blob: { size: 10, type: 'image/png' } })); assert.equal(sent.at(-1).data.ok, false);
await bridge.receive(event('svg', { blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }) })); assert.equal(sent.at(-1).data.ok, false);
await bridge.receive(event('large', { blob: new Blob([new Uint8Array(REFMUSE_IMAGE_LIMIT + 1)], { type: 'image/png' }) })); assert.equal(sent.at(-1).data.ok, false);
visible = false; await bridge.receive(event('hidden')); assert.equal(sent.at(-1).data.code, 'LIBRARY_HIDDEN'); assert.equal(sent.at(-1).data.retryable, true);
assert.equal(imports.length, 1); visible = true;
assert.equal(normalizeRefmuseReference({ sourceUrl: 'javascript:alert(1)', mediaUrl: 'https://user:pass@example.com/x' }).sourceUrl, '');
assert.equal(normalizeRefmuseReference({ mediaUrl: 'https://user:pass@example.com/x' }).mediaUrl, '');
bridge.stop(); const count = sent.length; await bridge.receive(event('after-close')); assert.equal(sent.length, count);
await bridge.receive(event('stopped-theme', {type:'refmuse.canvas.theme',theme:'dark'})); assert.deepEqual(themes, ['dark','light']);
const failed = createRefmuseCanvasBridge({ getFrame: () => frame, channel: 'channel', isReadOnly: () => false, isBusy: () => false,
  onBusy() {}, onMessage() {}, onImport: async () => { throw Error('secret local path'); } });
await failed.receive(event('save-error')); assert.equal(sent.at(-1).data.ok, false);
assert.ok(!JSON.stringify(sent.at(-1)).includes('secret'));
console.log('Refmuse bridge: origin/source/channel, ack-after-save, replay/concurrency, readonly, MIME/size, provenance and error privacy passed');
