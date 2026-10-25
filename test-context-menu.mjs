import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('h3-canvas-snap-v1', 'false');
  localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({
    nodes: [{ id: 'context-image', type: 'media', position: { x: 650, y: 220 }, data: { kind: 'image', title: '角色参考', url: '', name: '' } }],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-id="context-image"] .media-drag-surface');
const menu = page.getByRole('menu', { name: '添加节点' });

await page.mouse.click(420, 610, { button: 'right' });
await menu.waitFor({ state: 'visible' });
assert.equal(await menu.locator(':scope > button').count(), 5, 'Right-click menu contains all five node types');
let box = await menu.boundingBox();
assert.ok(Math.abs(box.x - 420) < 2 && Math.abs(box.y - 610) < 2, 'Menu opens at the mouse position');

await menu.getByRole('button', { name: /图片素材/ }).click();
await menu.waitFor({ state: 'detached' });
await page.waitForTimeout(500);
const added = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')).nodes.find(node => node.id !== 'context-image'));
assert.ok(added, 'A node can be added from the right-click menu');
assert.ok(Math.abs(added.position.x - 420) < 2 && Math.abs(added.position.y - 610) < 2, 'Node is created at the right-clicked canvas position');

const existingSurface = await page.locator('[data-id="context-image"] .media-drag-surface').boundingBox();
await page.mouse.click(existingSurface.x + 90, existingSurface.y + 70, { button: 'right' });
await menu.waitFor({ state: 'visible' });
await page.keyboard.press('Escape');
await menu.waitFor({ state: 'detached' });

await page.mouse.click(450, 500, { button: 'right' });
await menu.waitFor({ state: 'visible' });
await page.mouse.click(1050, 700, { button: 'left' });
await menu.waitFor({ state: 'detached' });

await page.mouse.click(1560, 950, { button: 'right' });
await menu.waitFor({ state: 'visible' });
box = await menu.boundingBox();
assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1600 && box.y + box.height <= 1000, 'Menu stays inside the viewport near screen edges');
await page.keyboard.press('Escape');

const titleInput = await page.locator('[data-id="context-image"] input[aria-label="节点名称"]').boundingBox();
await page.mouse.click(titleInput.x + 50, titleInput.y + 10, { button: 'right' });
await page.waitForTimeout(200);
assert.equal(await menu.count(), 0, 'Text editing areas keep their native context menu');

const report = { blankRightClick: true, nodeRightClick: true, addAtCursor: true, escapeCloses: true, outsideClickCloses: true, edgeClamping: true, editAreaUnblocked: true, errors };
fs.writeFileSync('../context_menu_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(2);
