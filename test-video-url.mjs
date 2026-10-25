import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const sourceUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({
    nodes: [
      { id: 'welcome', type: 'note', position: { x: 0, y: 0 }, data: { title: '从这里开始', text: '① 上传图片、视频或音频素材\n② 选中全能参考，用 + 添加或连线素材\n③ 输入 @ 名称引用角色、动作或声音\n④ 点击右下角箭头，本地生成视频' } },
      { id: 'main-h3', type: 'generator', position: { x: 700, y: 80 }, data: { title: '全能参考', mode: 'reference', prompt: '', ratio: '16:9', duration: 5, turbo: true } },
    ], edges: [], viewport: { x: 40, y: 20, zoom: 0.8 },
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.server-status.online', { timeout: 30000 });
await page.locator('#video-url-input').fill(sourceUrl);
await page.getByRole('button', { name: '加载视频链接', exact: true }).click();
await page.waitForSelector('.media-video video', { timeout: 180000 });
assert.equal(await page.locator('.media-video .neo-node-title input').inputValue(), 'flower');
await page.locator('.generator-preview').click();
await page.waitForSelector('.reference-chip');
assert.ok((await page.locator('.reference-chip').innerText()).includes('@flower'));
assert.ok((await page.locator('.creator-footnote').innerText()).includes('已连接 1 个素材'));
await page.waitForTimeout(800);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('h3-infinite-canvas-v2')));
const video = saved.nodes.find(node => node.type === 'media' && node.data.kind === 'video');
const edge = saved.edges.find(item => item.source === video.id && item.target === 'main-h3');
assert.equal(edge.targetHandle, 'references');
assert.ok(video.data.remoteName.startsWith('workbench/web_'));
assert.equal(video.data.sourceUrl, sourceUrl);
await page.screenshot({ path: '../video-url-import-test.png', fullPage: true });
const report = {
  loadedTitle: video.data.title,
  remoteName: video.data.remoteName,
  connectedTo: edge.target,
  targetHandle: edge.targetHandle,
  sourceUrlPersisted: true,
  errors,
};
fs.writeFileSync('../video_url_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(2);
