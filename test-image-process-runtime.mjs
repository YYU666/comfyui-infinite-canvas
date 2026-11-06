import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { decodeTga, encodeTga, MAX_IMAGE_PIXELS } from './src/channel-packing.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const runtimeBuild = await build({ absWorkingDir: root, entryPoints: ['src/image-process-runtime.js'], bundle: true, write: false, format: 'esm',
  define: { 'import.meta.url': JSON.stringify(new URL('src/image-process-runtime.js', import.meta.url).href) } });
const workerBuild = await build({ absWorkingDir: root, entryPoints: ['src/image-compositing.worker.js'], bundle: true, write: false, format: 'iife' });
const { renderImageProcess } = await import(`data:text/javascript;base64,${Buffer.from(runtimeBuild.outputFiles[0].text).toString('base64')}`);
const rgba = (width, height, values) => ({ width, height, data: new Uint8ClampedArray(values) });
const ref = (slot, url, rawUrl) => ({ data: { slot, url, ...(rawUrl ? { rawUrl } : {}) } });

test('direct resized TGA decoding keeps pixel-center nearest mapping for every origin orientation', () => {
  const pixels = Array.from({ length: 8 }, (_, index) => [index + 10, index + 30, index + 60, 0]).flat();
  const original = rgba(4, 2, pixels);
  for (const descriptor of [0x08, 0x18, 0x28, 0x38]) {
    const bytes = encodeTga(original); bytes[17] = descriptor;
    for (let row = 0; row < 2; row += 1) for (let column = 0; column < 4; column += 1) {
      const x = descriptor & 0x10 ? 3 - column : column;
      const y = descriptor & 0x20 ? row : 1 - row;
      const pixel = original.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
      bytes.set([pixel[2], pixel[1], pixel[0], pixel[3]], 18 + (row * 4 + column) * 4);
    }
    assert.deepEqual([...decodeTga(bytes, { width: 2, height: 1 }).data], [...original.data.subarray(20, 24), ...original.data.subarray(28, 32)]);
  }
});

// The real bundled Worker handler runs against instrumented browser primitives.
// Large source dimensions therefore exercise readback policy without allocating
// native-size fixtures or needing a service, browser, user files or credentials.
function harness(t, sources, { offscreen = true, holdPreparation = false } = {}) {
  const names = ['fetch', 'createImageBitmap', 'ImageData', 'document', 'OffscreenCanvas', 'Worker'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  const stats = { reads: [], messages: [], urls: [], nativeLive: 0, nativeMaximum: 0, closed: 0, terminated: 0, workers: 0, context: 'main' };
  const imageClass = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  class Canvas {
    constructor(width = 0, height = 0) { Object.assign(this, { width, height }); }
    getContext() {
      const canvas = this;
      return {
        imageSmoothingEnabled: true,
        clearRect() { canvas.draw = null; },
        drawImage(bitmap, ...args) {
          const coordinates = args.length === 4 ? [0, 0, bitmap.width, bitmap.height, ...args] : args;
          canvas.draw = { bitmap, coordinates };
        },
        getImageData(left, top, width, height) {
          stats.reads.push({ width, height, context: stats.context });
          const data = new Uint8ClampedArray(width * height * 4);
          const { bitmap, coordinates: [sx, sy, sw, sh, dx, dy, dw, dh] } = canvas.draw;
          for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
            const sourceX = Math.min(bitmap.width - 1, Math.floor(sx + (x + left + 0.5 - dx) * sw / dw));
            const sourceY = Math.min(bitmap.height - 1, Math.floor(sy + (y + top + 0.5 - dy) * sh / dh));
            const sample = bitmap.sample ? bitmap.sample(sourceX, sourceY) : bitmap.data.subarray((sourceY * bitmap.width + sourceX) * 4, (sourceY * bitmap.width + sourceX) * 4 + 4);
            data.set(sample, (y * width + x) * 4);
          }
          return new imageClass(data, width, height);
        },
        putImageData(image) { canvas.output = new Uint8ClampedArray(image.data); },
      };
    }
    toBlob(callback) {
      // Model Canvas losing hidden RGB during PNG encoding; TGA must already
      // have been encoded and transferred from the Worker at this point.
      for (let i = 0; i < this.output.length; i += 4) if (!this.output[i + 3]) this.output.fill(0, i, i + 3);
      callback(new Blob([this.output], { type: 'image/png' }));
    }
  }
  globalThis.fetch = async (url) => {
    stats.urls.push(url);
    const source = sources[url];
    assert.ok(source, `Unexpected synthetic fetch: ${url}`);
    return { ok: true, arrayBuffer: async () => source.slice().buffer, blob: async () => ({ source }) };
  };
  globalThis.createImageBitmap = async ({ source }) => {
    stats.nativeLive += 1; stats.nativeMaximum = Math.max(stats.nativeMaximum, stats.nativeLive);
    let closed = false;
    return { ...source, close() { if (!closed) { closed = true; stats.nativeLive -= 1; stats.closed += 1; } } };
  };
  globalThis.ImageData = imageClass;
  globalThis.document = { createElement: () => new Canvas() };
  globalThis.OffscreenCanvas = offscreen ? Canvas : undefined;
  globalThis.Worker = class {
    constructor() {
      stats.workers += 1;
      const self = { postMessage: (message, transfer = []) => {
        assert.equal(transfer.length, new Set(transfer).size);
        const result = structuredClone(message, { transfer });
        queueMicrotask(() => this.onmessage?.({ data: result }));
      } };
      new Function('self', workerBuild.outputFiles[0].text)(self);
      this.handler = self.onmessage;
    }
    postMessage(message, transfer) {
      assert.equal(transfer.length, new Set(transfer).size);
      stats.messages.push({ type: message.type || message.mode, channel: message.channel });
      const { bitmap, ...rest } = message;
      const copied = structuredClone(rest, { transfer: transfer.filter((value) => value instanceof ArrayBuffer) });
      if (bitmap) copied.bitmap = bitmap;
      if (holdPreparation && message.type === 'channelInput') { this.pendingBitmap = bitmap; return; }
      stats.context = 'worker';
      try { this.handler({ data: copied }); } finally { stats.context = 'main'; }
    }
    terminate() { this.pendingBitmap?.close(); stats.terminated += 1; }
  };
  return stats;
}

test('four 32MP bitmap previews read back only preview pixels and release inputs sequentially', async (t) => {
  const image = { width: 8192, height: 4096, sample: () => [40, 80, 120, 255] };
  const stats = harness(t, { large: image });
  const result = await renderImageProcess('channelPack', ['red', 'green', 'blue', 'alpha'].map((key) => ref(key, 'large')), {}, { maxEdge: 512 });
  assert.equal(image.width * image.height, MAX_IMAGE_PIXELS);
  assert.equal(result.width, 512); assert.equal(result.height, 256);
  assert.equal(result.tgaBlob, undefined);
  assert.equal(stats.reads.length, 4);
  assert.ok(stats.reads.every((read) => read.width <= 512 && read.height <= 512 && read.context === 'worker'));
  assert.equal(stats.nativeMaximum, 1);
  assert.equal(stats.nativeLive, 0); assert.equal(stats.closed, 4); assert.equal(stats.terminated, 1);
  assert.deepEqual(stats.messages.map((message) => message.type), ['channelInput', 'channelInput', 'channelInput', 'channelInput', 'channelPack']);
});

test('raw TGA preparation resamples before decoding RGBA, preserves hidden RGB, and can be chained', async (t) => {
  const raw = encodeTga(rgba(4, 1, [11, 21, 31, 0, 41, 51, 61, 0, 71, 81, 91, 0, 101, 111, 121, 0]));
  const sources = { raw };
  const stats = harness(t, sources);
  const settings = { channels: { red: { source: 'red' }, green: { source: 'green' }, blue: { source: 'blue' }, alpha: { source: 'alpha' } } };
  const refs = ['red', 'green', 'blue', 'alpha'].map((key) => ref(key, 'must-not-read-png', 'raw'));
  const preview = await renderImageProcess('channelPack', refs, settings, { maxEdge: 2 });
  assert.deepEqual([...new Uint8Array(await preview.blob.arrayBuffer())], [41, 51, 61, 255, 101, 111, 121, 255]);
  assert.equal(stats.reads.length, 0);
  const full = await renderImageProcess('channelPack', refs, settings);
  assert.deepEqual([...decodeTga(new Uint8Array(await full.tgaBlob.arrayBuffer())).data], [...decodeTga(raw).data]);
  sources.chain = new Uint8Array(await full.tgaBlob.arrayBuffer());
  const chained = await renderImageProcess('channelPack', ['red', 'green', 'blue', 'alpha'].map((key) => ref(key, 'must-not-read-png', 'chain')), settings);
  assert.deepEqual([...decodeTga(new Uint8Array(await chained.tgaBlob.arrayBuffer())).data], [...decodeTga(raw).data]);
  assert.equal(stats.reads.length, 0); assert.equal(stats.nativeMaximum, 0);
});

test('full output scans native alpha in bounded tiles including pixels skipped by preview sampling', async (t) => {
  const sources = {
    small: { width: 2, height: 1, sample: () => [20, 20, 20, 255] },
    transparent: { width: 1024, height: 1, sample: (x) => [30, 30, 30, x === 10 ? 0 : 255] },
  };
  const stats = harness(t, sources);
  const refs = [ref('red', 'small'), ref('green', 'transparent')];
  await renderImageProcess('channelPack', refs, {}, { maxEdge: 1 });
  await assert.rejects(renderImageProcess('channelPack', refs, {}), /不透明灰度贴图/);
  assert.ok(stats.reads.every((read) => read.width <= 256 && read.height <= 256));
  assert.equal(stats.nativeLive, 0);
  const alpha = await renderImageProcess('channelPack', [ref('red', 'transparent')], { channels: { red: { source: 'alpha' } } });
  const image = decodeTga(new Uint8Array(await alpha.tgaBlob.arrayBuffer()));
  assert.equal(image.data[10 * 4], 0); assert.equal(image.data[11 * 4], 255);
});

test('native dimensions and malformed TGA payload fail before pixel readback or Worker creation', async (t) => {
  const bad = encodeTga(rgba(1, 1, [0, 0, 0, 255])); new DataView(bad.buffer).setUint16(12, 20000, true);
  const stats = harness(t, { wide: { width: 16385, height: 1, sample: () => [0, 0, 0, 255] }, bad });
  await assert.rejects(renderImageProcess('channelPack', [ref('red', 'wide')], {}), /16384/);
  await assert.rejects(renderImageProcess('channelPack', [ref('red', '', 'bad')], {}), /不完整/);
  assert.equal(stats.workers, 0); assert.equal(stats.reads.length, 0); assert.equal(stats.nativeLive, 0);
});

test('abort while a prepared bitmap is pending terminates the Worker and releases ownership', async (t) => {
  const stats = harness(t, { image: { width: 1, height: 1, sample: () => [10, 20, 30, 255] } }, { holdPreparation: true });
  const controller = new AbortController();
  const pending = renderImageProcess('channelPack', [ref('red', 'image')], {}, { signal: controller.signal, maxEdge: 512 });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stats.terminated, 1); assert.equal(stats.nativeLive, 0);
});

test('unsupported OffscreenCanvas fails explicitly; ordinary adjustments still encode TGA in Worker', async (t) => {
  const stats = harness(t, { image: { width: 1, height: 1, sample: () => [10, 20, 30, 255] } }, { offscreen: false });
  await assert.rejects(renderImageProcess('channelPack', [ref('red', 'image')], {}), /更新 Chrome 或 Edge/);
  const adjusted = await renderImageProcess('colorAdjust', [ref('guide', 'image')], {}, { tga: true });
  assert.deepEqual([...decodeTga(new Uint8Array(await adjusted.tgaBlob.arrayBuffer())).data], [10, 20, 30, 255]);
  assert.equal(stats.nativeLive, 0);
});
