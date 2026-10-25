import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.evaluate((pixel) => {
  localStorage.clear();
  localStorage.setItem('h3-canvas-snap-v1', 'true');
  localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({
    nodes: [{ id: 'navigation-image', type: 'media', position: { x: 110, y: 110 }, data: { kind: 'image', title: '画布导航测试', url: pixel, name: 'pixel.png' } }],
    edges: [], viewport: { x: 0, y: 0, zoom: 0.8 },
  }));
}, pixel);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.media-drag-surface');
const zoomText = () => page.locator('.canvas-control-pill .zoom-button span').innerText();
const zoomValue = async () => Number((await zoomText()).replace('%', ''));
assert.equal(await zoomValue(), 80);
await page.mouse.move(1250, 600);
await page.mouse.wheel(0, -420);
await page.waitForTimeout(500);
const wheelZoom = await zoomValue();
assert.ok(wheelZoom > 80, 'Mouse wheel zooms in');

const node = page.locator('[data-id="navigation-image"]');
const beforePan = await node.boundingBox();
await page.mouse.move(1300, 700);
await page.mouse.down();
await page.mouse.move(1180, 620, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(500);
const afterPan = await node.boundingBox();
assert.ok(Math.abs(afterPan.x - beforePan.x + 120) < 12, 'Blank drag pans horizontally');
assert.ok(Math.abs(afterPan.y - beforePan.y + 80) < 12, 'Blank drag pans vertically');
let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')));
assert.deepEqual(saved.nodes[0].position, { x: 110, y: 110 }, 'Panning does not change node coordinates');

await page.getByTitle('缩放', { exact: true }).click();
const beforeButtonZoom = await zoomValue();
await page.getByTitle('放大', { exact: true }).click();
await page.waitForTimeout(450);
assert.ok(await zoomValue() > beforeButtonZoom, 'Zoom button increases zoom');
await page.getByTitle('恢复到 100%', { exact: true }).click();
await page.waitForTimeout(550);
assert.equal(await zoomValue(), 100);
await page.getByTitle('适应全部节点', { exact: true }).click();
assert.equal(await page.locator('.zoom-menu').count(), 0);

await page.getByTitle('缩放', { exact: true }).click();
await page.getByTitle('恢复到 100%', { exact: true }).click();
await page.waitForTimeout(550);
await page.getByTitle('缩放', { exact: true }).click();
const beforeDrag = await node.locator('.media-drag-surface').boundingBox();
await page.mouse.move(beforeDrag.x + 70, beforeDrag.y + 60);
await page.mouse.down();
await page.mouse.move(beforeDrag.x + 107, beforeDrag.y + 89, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(700);
saved = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')));
const snapped = saved.nodes[0].position;
assert.equal(snapped.x % 22, 0, 'Node X snaps to the 22px grid');
assert.equal(snapped.y % 22, 0, 'Node Y snaps to the 22px grid');

const snapButton = page.getByTitle('自动吸附', { exact: true });
assert.equal(await snapButton.getAttribute('aria-pressed'), 'true');
await snapButton.click();
assert.equal(await snapButton.getAttribute('aria-pressed'), 'false');
await page.reload({ waitUntil: 'networkidle' });
assert.equal(await page.getByTitle('自动吸附', { exact: true }).getAttribute('aria-pressed'), 'false', 'Snap preference persists');
await page.getByTitle('自动吸附', { exact: true }).click();
await page.getByTitle('缩放', { exact: true }).click();
await page.screenshot({ path: '../canvas-navigation-test.png', fullPage: true });
const report = { wheelZoom, blankPan: true, zoomMenu: true, reset100: true, snapped, snapPreference: true, errors };
fs.writeFileSync('../canvas_navigation_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(2);
