import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

const root = path.resolve(process.env.H3_TEST_DIST_DIR || 'dist');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    response.setHeader('Content-Type', 'application/json'); response.end('{}'); return;
  }
  const target = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(target);
    response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('h3-canvas-name-v1', 'Clipboard UI fixture');
    localStorage.setItem('h3-canvas-snap-v1', 'false');
    localStorage.setItem('h3-infinite-canvas-v2', JSON.stringify({
      nodes: [
        { id: 'fixture-image', type: 'media', position: { x: 100, y: 180 }, data: { kind: 'image', title: '角色', url: '', name: '', mediaStorageId: 'synthetic-media' } },
        { id: 'fixture-generator', type: 'generator', position: { x: 600, y: 200 }, data: { title: '换装', mode: 'qwenEdit', prompt: '@角色 换夏装', seed: 123, randomSeed: false, status: 'done', progress: 100, promptId: 'synthetic-old-task', resultUrl: '', runs: [{ promptId: 'synthetic-old-task' }] } },
      ],
      edges: [{ id: 'fixture-edge', source: 'fixture-image', target: 'fixture-generator', sourceHandle: 'ref', targetHandle: 'guide' }],
      viewport: { x: 0, y: 0, zoom: 0.8 },
    }));
    window.__canvasTools = {};
    document.modelContext = { registerTool(tool) { window.__canvasTools[tool.name] = tool; } };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://127.0.0.1:8188/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: route.request().url().includes('system_stats') ? '{"devices":[]}' : '{}' }));
  await page.routeWebSocket('ws://127.0.0.1:8188/**', () => {});
  await page.goto(origin, { waitUntil: 'networkidle' });
  try {
    await page.locator('[data-id="fixture-image"]').waitFor();
  } catch (error) {
    console.error('CLIPBOARD_UI_BOOT_DEBUG', JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 4000) }));
    throw error;
  }

  const readProject = () => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('h3-canvas-projects', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const project = await new Promise((resolve, reject) => {
      const request = db.transaction('projects', 'readonly').objectStore('projects').getAll();
      request.onsuccess = () => resolve(request.result.find((item) => item.name === 'Clipboard UI fixture'));
      request.onerror = () => reject(request.error);
    });
    db.close();
    return project;
  });
  const waitForNodeCount = async (count) => {
    await page.waitForTimeout(750);
    const project = await readProject();
    assert.equal(project.canvas.nodes.length, count, `自动保存后应有 ${count} 个节点`);
    return project;
  };

  await page.locator('[data-id="fixture-image"] .media-preview').click();
  await page.locator('[data-id="fixture-generator"] .generator-preview').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.react-flow__node.selected').count(), 2, '多选两个原始节点');
  await page.keyboard.press('Control+d');
  let project = await waitForNodeCount(4);
  assert.equal(project.canvas.edges.length, 2, 'Ctrl+D 同时复制内部连线');
  assert.equal(await page.locator('.react-flow__node.selected').count(), 2, '副本组处于选中状态');
  const firstCopies = project.canvas.nodes.filter((node) => !node.id.startsWith('fixture-'));
  assert.equal(firstCopies.find((node) => node.type === 'generator').data.status, 'idle', '生成副本不带旧完成状态');
  assert.equal(firstCopies.find((node) => node.type === 'generator').data.prompt, '@角色 · 副本 换夏装');

  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  project = await waitForNodeCount(6);
  assert.equal(project.canvas.edges.length, 3, 'Ctrl+C / Ctrl+V 再复制一组节点及连线');
  assert.equal(project.canvas.nodes.filter((node) => node.type === 'generator' && node.data.status === 'idle').length, 2);

  const title = page.locator('.react-flow__node-generator.selected input[aria-label="节点名称"]');
  await title.fill('文本编辑区');
  await title.press('Control+d');
  await title.press('Control+c');
  await title.press('Control+v');
  project = await waitForNodeCount(6);
  assert.equal(project.canvas.edges.length, 3, '输入框内快捷键不操作画布');

  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'clipboard-fixture.png', { type: 'image/png' }));
    const input = document.querySelector('.react-flow__node-generator.selected input[aria-label="节点名称"]');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  project = await waitForNodeCount(6);
  assert.equal(project.canvas.nodes.some((node) => node.data.name === 'clipboard-fixture.png'), false, '文本输入框内粘贴图片不会导入画布');

  await page.evaluate(() => {
    document.activeElement?.blur();
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'clipboard-fixture.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  project = await waitForNodeCount(7);
  const pastedImage = project.canvas.nodes.find((node) => node.data.name === 'clipboard-fixture.png');
  assert.ok(pastedImage, '剪贴板图片优先导入为素材，而不是粘贴旧节点');
  assert.equal(pastedImage.data.kind, 'image');
  assert.equal(pastedImage.data.localFile, true);
  assert.ok(pastedImage.data.mediaStorageId, '粘贴图片使用当前项目的素材存储记录');
  const storedImage = await page.evaluate(async ({ projectId, mediaId }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('h3-workbench-media', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const file = await new Promise((resolve, reject) => {
      const request = db.transaction('files', 'readonly').objectStore('files').get(`${projectId}/${mediaId}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close();
    return file ? { name: file.name, size: file.size, type: file.type } : null;
  }, { projectId: project.id, mediaId: pastedImage.data.mediaStorageId });
  assert.equal(storedImage.name, 'clipboard-fixture.png');
  assert.equal(storedImage.type, 'image/png');
  assert.ok(storedImage.size > 0, '图片文件本体已持久化');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('画布项目名称', { exact: true }).waitFor();
  await page.locator(`[data-id="${pastedImage.id}"] img`).waitFor({ state: 'visible' });
  project = await readProject();
  assert.equal(project.canvas.nodes.length, 7, '刷新后节点副本和粘贴图片仍存在');
  assert.equal(project.canvas.edges.length, 3, '刷新后副本连线仍存在');
  assert.deepEqual(errors, []);
  console.log('画布剪贴板 UI 测试通过：节点复制粘贴、图片粘贴优先级、文本输入保护、素材持久化及刷新恢复。');
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
