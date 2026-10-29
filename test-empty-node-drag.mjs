import { chromium } from './test-browser.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
let fileChoosers = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('filechooser', () => { fileChoosers += 1; });

await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('h3-canvas-snap-v1', 'false');
  localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({
    nodes: [
      { id: 'empty-image', type: 'media', position: { x: 40, y: 110 }, data: { kind: 'image', title: '角色参考', url: '', name: '' } },
      { id: 'empty-video', type: 'media', position: { x: 360, y: 110 }, data: { kind: 'video', title: '动作参考', url: '', name: '' } },
      { id: 'empty-audio', type: 'media', position: { x: 750, y: 110 }, data: { kind: 'audio', title: '声音参考', url: '', name: '' } },
      { id: 'empty-generator', type: 'generator', position: { x: 1080, y: 110 }, data: { title: '全能参考', mode: 'reference', status: 'idle' } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 0.8 },
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-id="empty-image"] .media-drag-surface');
assert.equal(await page.locator('.media-preview.empty .media-drag-surface').count(), 3);
assert.equal(await page.locator('.media-empty.nodrag').count(), 0, 'Empty upload surfaces do not block node dragging');

async function dragSurface(id, selector, dx, dy) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const surface = node.locator(selector);
  const before = await node.boundingBox();
  const box = await surface.boundingBox();
  assert.ok(before && box, `${id} has a visible drag surface`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const after = await node.boundingBox();
  assert.ok(after, `${id} remains visible`);
  assert.ok(Math.abs(after.x - before.x - dx) < 12, `${id} moved horizontally; actual ${after.x - before.x}`);
  assert.ok(Math.abs(after.y - before.y - dy) < 12, `${id} moved vertically; actual ${after.y - before.y}`);
  return { x: after.x - before.x, y: after.y - before.y };
}

const movements = {
  emptyImage: await dragSurface('empty-image', '.media-drag-surface', 95, 55),
  emptyVideo: await dragSurface('empty-video', '.media-drag-surface', 85, 65),
  emptyAudio: await dragSurface('empty-audio', '.media-drag-surface', 75, 45),
  generator: await dragSurface('empty-generator', '.generator-placeholder', -90, 55),
};
assert.equal(fileChoosers, 0, 'Dragging an empty media node never opens the file picker');

const chooserPromise = page.waitForEvent('filechooser');
await page.locator('[data-id="empty-image"] .media-drag-surface').click({ position: { x: 70, y: 60 } });
const chooser = await chooserPromise;
assert.equal(chooser.isMultiple(), false, 'Single click still opens the media file picker');
assert.equal(fileChoosers, 1);

await page.waitForTimeout(500);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')));
for (const id of ['empty-image', 'empty-video', 'empty-audio', 'empty-generator']) {
  assert.ok(saved.nodes.some(node => node.id === id), `${id} position is persisted`);
}

const report = { movements, dragDidNotOpenPicker: true, clickOpensPicker: true, errors };
fs.writeFileSync('../empty_node_drag_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(2);
