import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
await page.addInitScript(() => localStorage.clear());
await page.goto('http://127.0.0.1:8790', { waitUntil: 'networkidle' });
await page.waitForSelector('.neo-app', { timeout: 30000 });
await page.getByText('本地已连接', { exact: true }).waitFor({ timeout: 30000 });

async function addFromMenu(namePattern) {
  const before = new Set(await page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => node.dataset.id)));
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 1380, y: 140 } });
  const menu = page.getByRole('menu', { name: '添加节点' });
  await menu.waitFor();
  await menu.getByRole('button', { name: namePattern }).click();
  await page.waitForTimeout(500);
  const after = await page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
  const id = after.find((item) => !before.has(item));
  assert.ok(id, `Added node: ${namePattern}`);
  return id;
}

async function connect(sourceId, targetId, targetHandle) {
  await page.getByTitle('适应画布', { exact: true }).click();
  await page.waitForTimeout(500);
  const source = page.locator(`.react-flow__node[data-id="${sourceId}"] .react-flow__handle.source`);
  const target = page.locator(`.react-flow__node[data-id="${targetId}"] .react-flow__handle.target[data-handleid="${targetHandle}"]`);
  const s = await source.boundingBox();
  const t = await target.boundingBox();
  assert.ok(s && t, `Visible handles ${sourceId} -> ${targetHandle}`);
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

const swapId = await addFromMenu(/^角色替换/);
const videoId = await addFromMenu(/^视频素材/);
const imageId = await addFromMenu(/^图片素材/);
const videoNode = page.locator(`.react-flow__node[data-id="${videoId}"]`);
const imageNode = page.locator(`.react-flow__node[data-id="${imageId}"]`);
const swapNode = page.locator(`.react-flow__node[data-id="${swapId}"]`);
await videoNode.locator('input[type=file]').setInputFiles('D:/H3_Workbench/references/workbench/web_20261025_1fda623ee994.mp4');
await imageNode.locator('input[type=file]').setInputFiles('D:/H3_Workbench/references/workbench/reference-character-portrait.png');
await page.waitForTimeout(800);

await page.getByTitle('适应画布', { exact: true }).click();
await page.waitForTimeout(500);
const beforeDrag = await videoNode.boundingBox();
const surface = videoNode.locator('.media-drag-surface');
const dragBox = await surface.boundingBox();
assert.ok(beforeDrag && dragBox, 'Video drag surface is visible');
await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
await page.mouse.down();
await page.mouse.move(dragBox.x + dragBox.width / 2 + 90, dragBox.y + dragBox.height / 2 + 45, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
const afterDrag = await videoNode.boundingBox();
assert.ok(Math.abs(afterDrag.x - beforeDrag.x) > 40 && Math.abs(afterDrag.y - beforeDrag.y) > 20, 'Video body drags the node');

await connect(videoId, swapId, 'guide');
await connect(imageId, swapId, 'identity');
assert.equal(await page.locator('.react-flow__edge').count(), 3, 'Both swap inputs connected');
await swapNode.locator('.generator-preview').click();
const toolbar = page.locator('.creator-toolbar:visible');
const prompt = 'Female, oval face, large brown eyes, long black half-up hair, lavender butterfly ornament, pale blue camisole';
await toolbar.locator('.h3-prompt').fill(prompt);
await toolbar.getByLabel('换人目标').fill('the smaller white mannequin on the right');
await toolbar.getByLabel('SAM 识别').fill('white mannequin');
assert.equal(await toolbar.locator('.h3-prompt').textContent(), prompt, 'Prompt remains editable');
await page.screenshot({ path: '../comparison/character-swap-ui.png', fullPage: true });

let submitted;
await page.route('http://127.0.0.1:8188/prompt', async (route) => {
  submitted = route.request().postDataJSON();
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prompt_id: 'ui-test-not-executed', number: 0, node_errors: {} }) });
});
await toolbar.locator('.node-generate').click();
await page.waitForTimeout(1500);
assert.ok(submitted, 'Workflow submitted from swap UI');
const graph = submitted.prompt;
assert.equal(graph['17'].inputs.lora_name, 'minimax_h3_character_swap_v1.1_ref2va_fro.safetensors');
assert.equal(graph['19'].class_type, 'MiniMaxH3AddGuide');
assert.deepEqual(graph['19'].inputs.image, ['104', 0]);
assert.equal(graph['104'].inputs.length, 124);
assert.equal(graph['105'].class_type, 'TrimAudioDuration');
assert.equal(graph['21'].inputs.text, 'white mannequin');
assert.ok(graph['7'].inputs.prompt.startsWith('body_swap:'));
assert.ok(graph['7'].inputs.prompt.includes('This is a full-character replacement, not a face swap or head swap.'));
assert.ok(graph['7'].inputs.prompt.includes('do not turn a top into a dress, add a skirt'));
assert.equal(graph['100'].inputs.image, 'workbench/reference-character-portrait.png');
assert.equal(graph['101'].inputs.file, 'workbench/web_20261025_1fda623ee994.mp4');

const report = {
  swapId,
  videoId,
  imageId,
  rightClickAdd: true,
  mediaBodyDrag: true,
  promptEditable: true,
  guideAndIdentityConnected: true,
  characterSwapLora: true,
  addGuide: true,
  samTarget: graph['21'].inputs.text,
  trimmedFrames: graph['104'].inputs.length,
  originalAudioTrimmed: true,
  browserErrors: errors,
};
fs.writeFileSync('../comparison/character-swap-ui-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(2);
