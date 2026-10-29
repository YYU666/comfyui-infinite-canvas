import { chromium } from './test-browser.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.route('**/test-reference-video.mp4', route => route.fulfill({ path: '../test-reference-video.mp4', contentType: 'video/mp4' }));
const image = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#88705f"/><circle cx="60" cy="44" r="25" fill="#dec7ae"/><path d="M20 120Q60 65 100 120" fill="#3d332e"/></svg>').toString('base64')}`;
const originalPrompt = '让@女主角 模仿@舞蹈动作 跳舞';

await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.evaluate(({ image, originalPrompt }) => {
  localStorage.clear();
  localStorage.setItem('h3-canvas-snap-v1', 'false');
  localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({
    nodes: [
      { id: 'image-node', type: 'media', position: { x: 40, y: 80 }, data: { kind: 'image', title: '女主角', url: image, name: '女主角.png' } },
      { id: 'video-node', type: 'media', position: { x: 40, y: 410 }, data: { kind: 'video', title: '舞蹈动作', url: '/test-reference-video.mp4', name: '舞蹈动作.mp4' } },
      { id: 'audio-node', type: 'media', position: { x: 400, y: 80 }, data: { kind: 'audio', title: '雨夜环境声', url: '', name: '' } },
      { id: 'gen', type: 'generator', position: { x: 790, y: 130 }, selected: true, data: { title: '全能参考', mode: 'reference', prompt: originalPrompt, status: 'idle', ratio: '16:9', duration: 5, turbo: true, runs: [] } },
    ],
    edges: ['image-node', 'video-node', 'audio-node'].map(id => ({ id: `edge-${id}`, source: id, target: 'gen', sourceHandle: 'ref', targetHandle: 'references' })),
    viewport: { x: 0, y: 0, zoom: 0.8 },
  }));
}, { image, originalPrompt });
await page.reload({ waitUntil: 'networkidle' });
await page.locator('[data-id="gen"] .generator-preview').click();
const editor = page.getByRole('textbox', { name: '视频提示词' });
await editor.waitFor({ state: 'visible' });
await page.waitForTimeout(400);

assert.equal(await editor.locator('.prompt-mention').count(), 2, 'Saved prompt mentions render as two chips');
assert.equal(await editor.locator('.prompt-mention.image img').count(), 1, 'Image mention has an image thumbnail');
assert.equal(await editor.locator('.prompt-mention.video video').count(), 1, 'Video mention has a video thumbnail');
assert.ok(!(await editor.textContent()).includes('@女主角'), 'Long @ tokens are not shown as raw prompt text');
let storedPrompt = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')).nodes.find(node => node.id === 'gen').data.prompt);
assert.equal(storedPrompt, originalPrompt, 'Underlying prompt preserves reference tokens');

await editor.click();
await page.keyboard.press('Control+End');
const cdp = await page.context().newCDPSession(page);
await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
await cdp.send('Input.insertText', { text: '中文' });
await page.waitForTimeout(650);
storedPrompt = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')).nodes.find(node => node.id === 'gen').data.prompt);
assert.ok(storedPrompt.endsWith('中文'), 'Chinese IME composition commits without being interrupted');
await page.keyboard.type('，@女');
const mentionMenu = page.locator('.mention-menu');
await mentionMenu.waitFor({ state: 'visible' });
assert.equal(await mentionMenu.locator(':scope > button').count(), 1, '@ search filters the material list');
assert.equal(await mentionMenu.locator('.mention-thumb img').count(), 1, '@ search results also show thumbnails');
await mentionMenu.locator(':scope > button').click();
await page.keyboard.type('回头');
await page.waitForTimeout(450);
assert.equal(await editor.locator('.prompt-mention').count(), 3, 'Selecting @ result inserts a rich chip');
storedPrompt = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')).nodes.find(node => node.id === 'gen').data.prompt);
assert.ok(storedPrompt.endsWith('，@女主角 回头'), 'Typing continues at the caret after chip insertion');

const lastChip = editor.locator('.prompt-mention').last();
await lastChip.hover();
await lastChip.getByRole('button', { name: '删除引用 女主角' }).click();
await page.waitForTimeout(450);
assert.equal(await editor.locator('.prompt-mention').count(), 2, 'Chip close button removes only that reference');
storedPrompt = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')).nodes.find(node => node.id === 'gen').data.prompt);
assert.ok(!storedPrompt.includes('，@女主角 回头'), 'Deleting a chip updates the underlying prompt');

await page.keyboard.press('Control+End');
await page.keyboard.press('Enter');
await page.keyboard.type('第二行');
await page.waitForTimeout(450);
storedPrompt = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')).nodes.find(node => node.id === 'gen').data.prompt);
assert.ok(storedPrompt.includes('\n第二行'), 'Multiline rich text input is preserved');
await editor.click({ button: 'right' });
assert.equal(await page.getByRole('menu', { name: '添加节点' }).count(), 0, 'Rich prompt keeps its native editing context menu');
await page.screenshot({ path: '../prompt-mentions-test.png', fullPage: true });

await page.reload({ waitUntil: 'networkidle' });
await page.locator('[data-id="gen"] .generator-preview').click();
await page.getByRole('textbox', { name: '视频提示词' }).waitFor({ state: 'visible' });
assert.equal(await editor.locator('.prompt-mention').count(), 2, 'Mention chips survive a page reload');
assert.ok((await editor.textContent()).includes('第二行'), 'Multiline text survives a page reload');

const report = {
  inlineChips: true,
  imageThumbnail: true,
  videoThumbnail: true,
  thumbnailSearch: true,
  stableCaret: true,
  chipDeletion: true,
  multilineInput: true,
  nativeContextMenu: true,
  reloadRestore: true,
  underlyingPrompt: storedPrompt,
  errors,
};
fs.writeFileSync('../prompt_mentions_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(2);
