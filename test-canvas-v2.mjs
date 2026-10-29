import { chromium } from './test-browser.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('h3-workbench-media'); });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.server-status.online', { timeout: 30000 });
assert.equal(await page.locator('.react-flow__node').count(), 2);
assert.equal(await page.locator('.creator-toolbar:visible').count(), 0, 'Toolbar hidden before selection');
await page.locator('.generator-preview').click();
await page.waitForSelector('.creator-toolbar:visible');
assert.equal(await page.locator('.creator-modes button.active').innerText(), '全能参考');
await page.screenshot({ path: '../canvas-v2-home.png', fullPage: true });
await page.locator('.image-node input[type=file]').setInputFiles('../test-frame.png');
await page.waitForSelector('.image-node img');
await page.locator('.generator-preview').click();
await page.waitForSelector('.reference-chip');
await page.screenshot({ path: '../canvas-v2-reference.png', fullPage: true });
await page.locator('.h3-prompt').fill('@角');
await page.waitForSelector('.mention-menu');
await page.locator('.mention-menu button').filter({ hasText: '角色参考' }).click();
assert.ok((await page.locator('.h3-prompt').inputValue()).includes('@角色参考'));
await page.locator('.image-node .neo-node-title input').fill('主角');
assert.ok((await page.locator('.h3-prompt').inputValue()).includes('@主角'), 'Rename updates @ reference');
await page.locator('.h3-prompt').fill('@主角 在雨夜街道回头，镜头缓慢推近，电影感，环境雨声');
await page.locator('.generator-preview').click();
await page.getByRole('button', { name: 'Pin 关键节点', exact: true }).click();
await page.locator('.canvas-dock button[title^="Pin 节点"]').click();
await page.waitForSelector('.floating-pins');
assert.ok(await page.locator('.floating-pins').getByText('全能参考', { exact: true }).isVisible());
await page.locator('.floating-pins .floating-panel-title button').click();
await page.getByLabel('画布项目名称').fill('全能参考持久化测试');
await page.waitForTimeout(900);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.image-node img', { timeout: 15000 });
await page.locator('.generator-preview').click();
assert.equal(await page.locator('.h3-prompt').inputValue(), '@主角 在雨夜街道回头，镜头缓慢推近，电影感，环境雨声');
assert.equal(await page.getByLabel('画布项目名称').inputValue(), '全能参考持久化测试');
const promptResponse = page.waitForResponse(r => r.url().endsWith('/prompt') && r.request().method() === 'POST', { timeout: 30000 });
await page.locator('.node-generate').click();
const response = await promptResponse;
const responseBody = await response.text();
assert.equal(response.status(), 200, `Reference prompt accepted: ${responseBody}`);
const requestJson = JSON.parse(response.request().postData());
assert.equal(requestJson.prompt['7'].class_type, 'MiniMaxH3ReferenceToVideo');
assert.deepEqual(requestJson.prompt['7'].inputs.ref_images.ref_image_0, ['100', 0]);
assert.equal(requestJson.prompt['7'].inputs.prompt.includes('<Picture 1>'), true);
assert.equal(requestJson.prompt['11'].inputs.steps, 4);
assert.equal(requestJson.prompt['2'].inputs.lora_name, 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors');
await page.waitForTimeout(1200);
assert.equal(await page.locator('.generator-error').count(), 0, 'No immediate ComfyUI execution error');
await page.evaluate(async () => { await fetch('http://127.0.0.1:8188/interrupt', { method: 'POST', headers: {'Content-Type':'application/json'}, body:'{}' }); });
await page.waitForTimeout(700);
await page.getByRole('button', { name: '切换简易模式', exact: true }).click();
await page.waitForSelector('.app-shell');
await page.getByRole('button', { name: '画布模式', exact: true }).click();
await page.waitForSelector('.neo-app');
await page.locator('.generator-preview').click();
const mediaBeforeAttach = await page.locator('.media-shell').count();
await page.locator('.creator-toolbar input[type=file]').setInputFiles(['../test-frame.png', '../test-reference-video.mp4', '../test-reference-audio.wav']);
await page.waitForTimeout(700);
assert.equal(await page.locator('.media-shell').count(), mediaBeforeAttach + 3, 'Attach image, video and audio from generator');
assert.equal(await page.locator('.media-audio').count(), 1);
assert.ok(await page.locator('.media-video').count() >= 1);
const nodesBeforeMenu = await page.locator('.react-flow__node').count();
await page.locator('.react-flow__pane').dblclick({ position: { x: 220, y: 190 } });
await page.waitForSelector('.add-node-menu');
await page.locator('.add-node-menu > button').filter({ hasText: '文本备注' }).click();
await page.waitForTimeout(300);
assert.equal(await page.locator('.react-flow__node').count(), nodesBeforeMenu + 1, 'Double-click add menu creates node');
const imagesBeforeDrop = await page.locator('.media-image').count();
await page.evaluate(() => {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0));
  const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'drop-reference.png', { type: 'image/png' }));
  document.querySelector('.react-flow__pane').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: 420, clientY: 300 }));
});
await page.waitForTimeout(400);
assert.equal(await page.locator('.media-image').count(), imagesBeforeDrop + 1, 'Dropped image creates media node');
let queue;
for (let attempt = 0; attempt < 20; attempt++) {
  queue = await page.evaluate(async () => (await (await fetch('http://127.0.0.1:8188/queue')).json()));
  if (!queue.queue_running.length && !queue.queue_pending.length) break;
  await page.waitForTimeout(500);
}
assert.equal(queue.queue_running.length, 0);
assert.equal(queue.queue_pending.length, 0);
await page.screenshot({ path: '../canvas-v2-tested.png', fullPage: true });
const report = {
  title: await page.title(), promptStatus: response.status(), referenceNode: requestJson.prompt['7'].class_type,
  compiledPrompt: requestJson.prompt['7'].inputs.prompt, turboSteps: requestJson.prompt['11'].inputs.steps,
  mentionAndRename: true, pin: true, mediaPersistence: true, simpleModeRoundtrip: true,
  multiModalAttach: true, doubleClickAdd: true, dragDrop: true,
  queueRunning: queue.queue_running.length, queuePending: queue.queue_pending.length, errors,
};
fs.writeFileSync('../canvas_v2_test_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(2);
