// Reproducible local microbenchmark; timings are observations, never CI thresholds.
// node scripts/benchmark-image-processing.mjs [--baseline <source-module-directory>]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const baselineIndex = process.argv.indexOf('--baseline');
const baselineRoot = baselineIndex < 0 ? null : path.resolve(process.argv[baselineIndex + 1]);
const load = async (directory) => ({
  ...await import(pathToFileURL(path.join(directory, 'image-compositing.js'))),
  ...await import(pathToFileURL(path.join(directory, 'photo-adjustments.js'))),
  ...await import(pathToFileURL(path.join(directory, 'channel-packing.js'))),
  ...await import(pathToFileURL(path.join(directory, 'image-process-graph.js'))),
});
const image = (width, height) => {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 42;
  for (let index = 0; index < data.length; index += 1) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[index] = seed >>> 24; }
  return { width, height, data };
};
const settings = {
  basic: { brightness: 10, contrast: 15, gamma: 1.2 }, hsl: { hsl: { red: { hue: 35, lightness: 8 } } },
  levels: { levels: { rgb: { inputBlack: 10, inputWhite: 240, gamma: 1.2 } } },
  exposure: { exposure: { exposure: 0.7, offset: 0.02, gamma: 1.3 } }, whiteBalance: { whiteBalance: { temperature: 30, tint: -10 } },
  vibrance: { vibrance: { vibrance: 40, saturation: 10 } }, curves: { curves: { rgb: [{ x: 0, y: 0 }, { x: 100, y: 135 }, { x: 255, y: 255 }] } },
  shadowsHighlights: { shadowsHighlights: { shadows: 30, highlights: 15, contrast: 5 } },
  colorBalance: { colorBalance: { midtones: { cyanRed: 20, magentaGreen: -10 } } },
  selectiveColor: { selectiveColor: { reds: { cyan: -20, magenta: 30, black: 5 } } },
};
function graph(api, depth) {
  const nodes = [{ id: 'map', type: 'media', data: { kind: 'image', assetPath: 'assets/map.png' } }];
  const edges = [];
  for (let index = 0; index < depth; index += 1) {
    const id = `p${index}`; const node = { id, type: 'imageProcess', data: { mode: 'channelPack' } }; nodes.push(node);
    for (const channel of ['red', 'green', 'blue', 'alpha']) edges.push({ source: index ? `p${index - 1}` : 'map', target: id, targetHandle: channel });
    node.data.processedSignature = api.imageProcessSnapshot(id, nodes, edges).signature; node.data.processedAssetPath = `assets/${id}.png`;
  }
  return () => api.imageProcessSnapshot(`p${depth - 1}`, nodes, edges).signature;
}
function measure(label, work, repeats = 3) {
  work();
  const times = []; let result;
  for (let index = 0; index < repeats; index += 1) { const start = performance.now(); result = work(); times.push(performance.now() - start); }
  const bytes = typeof result === 'string' ? result : result.data || result;
  return { label, medianMs: Number(times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(2)), sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function run(directory) {
  const api = await load(directory); const small = image(1024, 1024); const large = image(4096, 4096);
  const rows = api.PHOTO_ADJUSTMENTS.map(({ value }) => measure(`1MP/${value}`, () => api.adjustImagePixels(small, { adjustmentType: value, ...settings[value] })));
  rows.push(measure('4K/curves', () => api.adjustImagePixels(large, { adjustmentType: 'curves', ...settings.curves })));
  rows.push(measure('4K/blend-mask', () => api.blendImagePixels(large, large, { mode: 'soft-light', opacity: 70 }, large)));
  const packed = api.packImageChannels(Object.fromEntries(api.CHANNEL_KEYS.map((key) => [key, large])));
  rows.push(measure('4K/rgba-pack', () => api.packImageChannels(Object.fromEntries(api.CHANNEL_KEYS.map((key) => [key, large])))));
  rows.push(measure('4K/tga-encode', () => api.encodeTga(packed)));
  const tga = api.encodeTga(packed); rows.push(measure('4K/tga-decode', () => api.decodeTga(tga)));
  rows.push(measure('graph/shared-9', graph(api, 9), 5));
  return rows;
}
const before = baselineRoot ? await run(baselineRoot) : null;
const after = await run(sourceRoot);
if (before) for (let index = 0; index < before.length; index += 1) assert.equal(after[index].sha256, before[index].sha256, `pixel/signature regression: ${after[index].label}`);
console.log(JSON.stringify({ node: process.version, cpu: os.cpus()[0]?.model, repeats: '3 timed + 1 warmup (graph 5 timed)', sameOutput: before ? true : null, before, after }, null, 2));
