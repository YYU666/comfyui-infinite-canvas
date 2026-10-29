import { chromium } from './test-browser.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const videoUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.evaluate(({ videoUrl, pixel }) => {
  localStorage.clear();
  localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({
    nodes: [
      { id: 'drag-image', type: 'media', position: { x: 60, y: 120 }, data: { kind: 'image', title: '图片拖动测试', url: pixel, name: 'pixel.png' } },
      { id: 'drag-video', type: 'media', position: { x: 400, y: 120 }, data: { kind: 'video', title: '视频拖动测试', url: videoUrl, name: 'flower.mp4' } },
      { id: 'drag-result', type: 'generator', position: { x: 800, y: 120 }, data: { title: '生成结果拖动测试', resultUrl: videoUrl, status: 'done' } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 0.8 },
  }));
}, { videoUrl, pixel });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.media-drag-surface');
assert.equal(await page.locator('.media-drag-surface').count(), 3);

async function dragByMedia(id, dx, dy) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const surface = node.locator('.media-drag-surface');
  const before = await node.boundingBox();
  const box = await surface.boundingBox();
  assert.ok(before && box, `${id} drag surface is visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const after = await node.boundingBox();
  assert.ok(after, `${id} remains visible`);
  // XYFlow consumes a small pointer threshold before the node starts moving.
  assert.ok(Math.abs(after.x - before.x - dx) < 12, `${id} moved horizontally by ${dx}; actual ${after.x - before.x}`);
  assert.ok(Math.abs(after.y - before.y - dy) < 12, `${id} moved vertically by ${dy}; actual ${after.y - before.y}`);
  return { x: after.x - before.x, y: after.y - before.y };
}

const imageMovement = await dragByMedia('drag-image', 95, 55);
const videoMovement = await dragByMedia('drag-video', 85, 65);
const resultMovement = await dragByMedia('drag-result', 70, 45);
assert.ok(await page.locator('[data-id="drag-video"] video').evaluate(video => video.paused), 'Dragging does not start playback');
await page.locator('[data-id="drag-video"] .media-drag-surface').click({ position: { x: 80, y: 55 } });
await page.waitForFunction(() => !document.querySelector('[data-id="drag-video"] video')?.paused, { timeout: 15000 });
await page.locator('[data-id="drag-video"] .media-drag-surface').click({ position: { x: 80, y: 55 } });
await page.waitForFunction(() => document.querySelector('[data-id="drag-video"] video')?.paused, { timeout: 5000 });
const previewHeight = await page.locator('[data-id="drag-video"] .media-preview').evaluate(element => element.clientHeight);
const surfaceHeight = await page.locator('[data-id="drag-video"] .media-drag-surface').evaluate(element => element.clientHeight);
assert.ok(surfaceHeight < previewHeight, 'Native video control bar remains exposed');
await page.screenshot({ path: '../media-drag-test.png', fullPage: true });
const report = { imageMovement, videoMovement, resultMovement, clickPlayback: true, nativeControlsExposed: true, errors };
fs.writeFileSync('../media_drag_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(2);
