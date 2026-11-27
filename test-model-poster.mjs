import assert from 'node:assert/strict';
import { cachedModelPoster, captureModelPoster, clearModelPosterCache } from './src/model-poster.js';

clearModelPosterCache();
let active = 0;
let peak = 0;
const render = async (url) => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 20));
  active -= 1;
  return `data:image/png,${url}`;
};
const first = await Promise.all(['a', 'b', 'c'].map((key) => captureModelPoster(key, { render })));
assert.deepEqual(first, ['data:image/png,a', 'data:image/png,b', 'data:image/png,c']);
assert.equal(peak, 1);
assert.equal(await captureModelPoster('b', { render: async () => { throw new Error('cache miss'); } }), 'data:image/png,b');
assert.equal(cachedModelPoster('a'), 'data:image/png,a');
clearModelPosterCache();
assert.equal(cachedModelPoster('a'), '');

console.log('model poster ok');
