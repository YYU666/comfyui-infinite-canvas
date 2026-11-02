import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from './test-browser.mjs';

const root = process.cwd();
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || path.join(root, 'dist'));
const origin = 'http://127.0.0.1:8799';
const galleries = ['https://ai-costume-gallery.pages.dev', 'https://ai-pose-gallery.pages.dev'];
let pixel;
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  const imagePage = await browser.newPage();
  pixel = Buffer.from(await imagePage.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4; const context = canvas.getContext('2d'); context.fillStyle = '#c8b599'; context.fillRect(0, 0, 4, 4); return canvas.toDataURL().split(',')[1]; }), 'base64');
  await imagePage.close();
  for (const scenario of ['success', 'upload-failure', 'save-failure', 'readonly']) {
    let project = { id: 'prj_gallery', name: 'Reference library fixture', revision: 1, shots: [], canvas: { viewport: { x: 0, y: 0, zoom: 1 }, edges: [], nodes: [{ id: 'note', type: 'note', selected: true, position: { x: 40, y: 80 }, data: { title: 'Existing note', text: 'Synthetic test only' } }] } };
    const assets = new Map(); const uploads = []; const saves = []; const prompts = []; const remoteRequests = []; const opens = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      window.fixtureTools = new Map();
      Object.defineProperty(document, 'modelContext', { value: { registerTool(tool, options) { window.fixtureTools.set(tool.name, tool); options?.signal?.addEventListener('abort', () => window.fixtureTools.delete(tool.name)); } } });
      window.EventSource = class { addEventListener() {} close() {} };
      window.WebSocket = class { addEventListener() {} close() {} };
    });
    await context.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (request.method() === 'POST' && (url.pathname.endsWith('/prompt') || url.pathname === '/api/queue')) prompts.push(request.url());
      if (url.origin === 'https://refmuse.cn') {
        assert.equal(request.headers()['x-h3-token'], undefined);
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><h2>Refmuse synthetic reference</h2><form id="search"><input name="query"><button>搜索</button></form><button id="import">导入当前画布</button><p id="result"></p><script>
          let channel; window.replies=[]; window.searches=0;document.querySelector('#search').onsubmit=event=>{event.preventDefault();window.searches++};
          window.addEventListener('message',event=>{if(event.origin!=='${origin}'||event.source!==parent)return;
            if(event.data.type==='refmuse.canvas.init'){channel=event.data.channel;parent.postMessage({type:'refmuse.canvas.ready',version:1,channel},event.origin);parent.postMessage({type:'refmuse.canvas.theme',version:1,channel,theme:'dark'},event.origin);}
            if(event.data.type==='refmuse.canvas.result'){window.replies.push(event.data);document.querySelector('#result').textContent=event.data.message;}
          });
          document.querySelector('#import').onclick=async()=>{
            const blob=await (await fetch('data:image/png;base64,${pixel.toString('base64')}')).blob();
            window.importMessage={type:'refmuse.canvas.import',version:1,channel,requestId:'fixture-refmuse-one',blob,reference:{title:'游戏场景参考',sourceUrl:'https://example.com/concept',mediaUrl:'https://refmuse.cn/images/fixture.png',author:'Fixture'}};
            parent.postMessage(window.importMessage,'${origin}');parent.postMessage(window.importMessage,'${origin}');
          };
        </script>` });
      }
      if (galleries.includes(url.origin)) {
        remoteRequests.push(request);
        assert.equal(request.headers()['x-h3-token'], undefined);
        assert.equal(request.headers().referer, undefined);
        assert.equal(url.search, '');
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>body{background:#eee8dd;font:24px sans-serif;padding:48px}section{background:white;padding:40px}</style><section>Mock reference gallery<br><small>Isolated fixture · no external images</small></section>' });
      }
      assert.equal(url.origin, origin, 'network must remain fully intercepted');
      if (url.pathname === '/api/projects') return json({ projects: [project] });
      if (url.pathname === '/api/projects/trash') return json({ projects: [] });
      if (url.pathname === '/api/projects/open') {
        opens.push(request.postDataJSON());
        if (scenario === 'readonly' && !request.postDataJSON().readOnly) return json({ message: 'fixture locked' }, 423);
        return json(project);
      }
      if (url.pathname.startsWith('/api/projects/prj_gallery/assets/')) {
        if (request.method() === 'PUT') {
          uploads.push(request.url());
          if (scenario === 'upload-failure') return json({ message: 'fixture disk full' }, 507);
          const assetPath = `assets/fixture-${uploads.length}.png`; assets.set(assetPath, request.postDataBuffer());
          project.revision++;
          return json({ revision: project.revision, asset: { path: assetPath } });
        }
        return route.fulfill({ contentType: 'image/png', body: assets.get(decodeURIComponent(url.pathname.split('/prj_gallery/')[1])) || pixel });
      }
      if (url.pathname === '/api/projects/prj_gallery') {
        if (request.method() === 'PUT') {
          saves.push(request.postDataJSON());
          if (scenario === 'save-failure') return json({ message: 'fixture project save failed' }, 507);
          assert.equal(Number(request.headers()['if-match']), project.revision);
          project = { ...request.postDataJSON(), revision: project.revision + 1 };
        }
        return json(project);
      }
      if (url.pathname.startsWith('/api/agent/canvas/')) return json({ message: 'native fixture only' }, 503);
      if (url.pathname === '/api/settings') return json({ notifications: false, checkUpdatesOnLaunch: false });
      if (url.pathname === '/api/queue') return json({ jobs: [] });
      if (url.pathname === '/api/comfy/system_stats') return json({ devices: [] });
      if (url.pathname.startsWith('/api/')) return json({});
      const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
    });
    const page = await context.newPage(); page.on('pageerror', (error) => failures.push(error.message));
    const openProject = async () => { await page.goto(origin); await page.locator('.project-open').click(); await page.getByRole('button', { name: 'Refmuse参考库', exact: true }).waitFor(); };
    await openProject();
    const toolbar = page.getByRole('button', { name: 'Refmuse参考库', exact: true });
    await toolbar.click();
    const modal = page.getByRole('dialog', { name: 'Refmuse参考库' }); await modal.waitFor({ timeout: 5000 }).catch(async (error) => { console.error(scenario, failures, await page.locator('body').innerText()); throw error; });
    assert.equal(await modal.locator('nav button').first().innerText(), 'Refmuse');
    assert.match(await modal.locator('iframe').getAttribute('src'), /^https:\/\/refmuse\.cn\//);
    await modal.getByRole('button', { name: '衣装库', exact: true }).click();
    assert.equal(await modal.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-downloads');
    assert.equal(await modal.locator('iframe').getAttribute('src'), `${galleries[0]}/`);
    assert.equal(await modal.getByRole('link').getAttribute('target'), '_blank');
    assert.equal(await modal.getByRole('link').getAttribute('rel'), 'noopener noreferrer');
    if (scenario !== 'readonly') {
      await modal.getByRole('button', { name: '关闭参考库' }).focus(); await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'IFRAME');
      await modal.getByRole('button', { name: '关闭参考库' }).focus();
    }
    const before = await page.locator('.react-flow__node').count();
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v'); await page.keyboard.press('Delete'); await page.keyboard.press('Control+z');
    await page.evaluate(() => { const data = new DataTransfer(); data.items.add(new File(['fake'], 'pasted.png', { type: 'image/png' })); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data })); });
    assert.equal(await page.locator('.react-flow__node').count(), before);
    assert.equal(uploads.length, 0);
    await modal.getByRole('button', { name: '姿势库', exact: true }).click();
    assert.equal(await modal.locator('iframe').getAttribute('src'), `${galleries[1]}/`);
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent === 'Refmuse参考库');
    const result = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_open_reference_library').execute({ library: 'costume' })));
    assert.equal(result.ok, true); assert.equal(result.opened, true); assert.equal(result.remoteContentVerified, false);
    assert.equal(result.container, 'current-canvas-modal'); assert.equal(result.sourceUrl, `${galleries[0]}/`);
    assert.equal(await page.evaluate(() => window.fixtureTools.get('canvas_open_reference_library').annotations.readOnlyHint), true);
    assert.equal(saves.length, 0, 'browsing must not persist a project');
    const invalid = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_open_reference_library').execute({ library: 'https://evil.test' })));
    assert.equal(invalid.ok, false);
    assert.equal(await modal.locator('footer,input[type=file]').count(), 0, 'downloaded-file import row is removed');
    assert.equal(await modal.getByRole('button', { name: '导入已下载的图片' }).count(), 0);
    if (scenario === 'readonly') await modal.getByText('只读画布可浏览，无法导入。').waitFor();
    // Real cross-origin window/source handshake and Blob transport into existing save flow.
    if (!await modal.isVisible()) await toolbar.click();
    await modal.getByRole('button', { name: 'Refmuse', exact: true }).click();
    await modal.getByRole('status').filter({ hasText: 'Refmuse 已连接' }).waitFor();
    const refFrame = page.frames().find((frame) => frame.url().startsWith('https://refmuse.cn/'));
    const previousUploads = uploads.length;
    await page.waitForFunction(() => document.querySelector('.reference-library').dataset.theme === 'dark');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.reference-library')).backgroundColor === 'rgb(10, 10, 10)');
    assert.equal(await modal.evaluate(element => getComputedStyle(element).borderRadius), '0px');
    assert.equal(await modal.locator('nav button').first().evaluate(element => getComputedStyle(element).borderRadius), '0px');
    await refFrame.evaluate(() => parent.postMessage({type:'refmuse.canvas.theme',version:1,channel,theme:'light'}, 'http://127.0.0.1:8799'));
    await page.waitForFunction(() => document.querySelector('.reference-library').dataset.theme === 'light');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.reference-library')).backgroundColor === 'rgb(247, 247, 245)');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {source:window,origin:'https://refmuse.cn',data:{type:'refmuse.canvas.theme',version:1,theme:'dark'}})));
    await refFrame.evaluate(() => { parent.postMessage({type:'refmuse.canvas.theme',version:1,channel,theme:'url(evil)'}, 'http://127.0.0.1:8799'); parent.postMessage({type:'refmuse.canvas.theme',version:1,channel:'wrong',theme:'dark'}, 'http://127.0.0.1:8799'); });
    assert.equal(await modal.getAttribute('data-theme'), 'light', 'spoofed or non-enum themes ignored');
    await refFrame.evaluate(() => parent.postMessage({type:'refmuse.canvas.theme',version:1,channel,theme:'dark'}, 'http://127.0.0.1:8799'));
    await page.waitForFunction(() => document.querySelector('.reference-library').dataset.theme === 'dark');
    assert.match(await modal.locator('iframe').getAttribute('sandbox'), /allow-forms/);
    await refFrame.locator('#search button').click();
    assert.equal(await refFrame.evaluate(() => window.searches), 1, 'embedded login/search forms must dispatch submit');
    if (scenario === 'success') await page.evaluate(() => {
      const original = window.createImageBitmap; window.originalFixtureDecode = original;
      window.createImageBitmap = (...args) => new Promise((resolve, reject) => { window.releaseFixtureDecode = () => original(...args).then(resolve, reject); });
    });
    await refFrame.locator('#import').click();
    if (scenario === 'success') {
      await page.waitForFunction(() => typeof window.releaseFixtureDecode === 'function');
      const beforeOpens = opens.length;
      const blocked = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_open_project').execute({projectId:'prj_other'})));
      assert.equal(blocked.ok, false); assert.match(blocked.error, /关闭参考库/);
      assert.equal(opens.length, beforeOpens, 'switching during image decode must not open another project');
      const blockedLibrary = await page.evaluate(async () => JSON.parse(await window.fixtureTools.get('canvas_open_reference_library').execute({library:'pose'})));
      assert.equal(blockedLibrary.ok, false); assert.match(blockedLibrary.error, /正在导入/);
      assert.equal(await modal.getByRole('button', { name:'关闭参考库' }).isDisabled(), true);
      await page.evaluate(() => { window.releaseFixtureDecode(); window.createImageBitmap = window.originalFixtureDecode; });
    }
    await refFrame.waitForFunction(() => window.replies.length >= 2);
    const replies = await refFrame.evaluate(() => window.replies);
    if (replies[0].ok !== (scenario === 'success')) console.error('REFMUSE_DEBUG',scenario,replies,await modal.innerText(),failures);
    assert.equal(replies[0].ok, scenario === 'success');
    assert.equal(replies[1].ok, replies[0].ok);
    if (scenario === 'success') {
      assert.equal(uploads.length, previousUploads + 1, 'duplicate transport must create one upload');
      const imported = project.canvas.nodes.find((node) => node.data?.title === '游戏场景参考');
      assert.ok(imported?.data.assetPath);
      assert.equal(imported.data.sourceGallery.sourceUrl, 'https://example.com/concept');
      assert.equal(imported.data.sourceGallery.author, 'Fixture');
      await refFrame.evaluate(() => parent.postMessage(window.importMessage, 'http://127.0.0.1:8799'));
      await refFrame.waitForFunction(() => window.replies.length >= 3);
      assert.equal(uploads.length, previousUploads + 1);
      await mkdir(path.join(root, '.cache/refmuse-integration'), { recursive: true });
      await refFrame.locator('input[name=query]').fill('森林遗迹');
      await refFrame.evaluate(() => { window.retainedMarker = 'same-document'; });
      await modal.getByRole('button', { name: '关闭参考库' }).click();
      await modal.waitFor({ state: 'hidden' });
      const uploadsBeforeHidden = uploads.length;
      await refFrame.evaluate(() => parent.postMessage({ ...window.importMessage, requestId: 'late-hidden' }, 'http://127.0.0.1:8799'));
      await refFrame.waitForFunction(() => window.replies.some(reply => reply.requestId === 'late-hidden'), {}, { polling: 100 });
      const hiddenReply = await refFrame.evaluate(() => window.replies.find(reply => reply.requestId === 'late-hidden'));
      assert.equal(hiddenReply.code, 'LIBRARY_HIDDEN'); assert.equal(hiddenReply.retryable, true);
      assert.equal(uploads.length, uploadsBeforeHidden, 'hidden page must not import');
      await toolbar.click(); await modal.waitFor({ state: 'visible' });
      assert.equal(await refFrame.evaluate(() => window.retainedMarker), 'same-document');
      assert.equal(await refFrame.locator('input[name=query]').inputValue(), '森林遗迹');
      // Exhaust only no-write hidden requests; explicit reload must create a fresh session.
      await modal.getByRole('button', { name: '关闭参考库' }).click();
      await refFrame.evaluate(() => { for (let i=0;i<105;i++) parent.postMessage({ ...window.importMessage, requestId: `hidden-limit-${i}` }, 'http://127.0.0.1:8799'); });
      await refFrame.waitForFunction(() => window.replies.some(reply => reply.code === 'SESSION_LIMIT'), {}, { polling: 100 }).catch(async error => { console.error('CAP_DEBUG', await refFrame.evaluate(() => ({ count:window.replies.length,last:window.replies.at(-1),request:window.importMessage?.requestId })), failures); throw error; });
      assert.equal(uploads.length, uploadsBeforeHidden);
      await toolbar.click();
      await modal.getByRole('button', { name: '重新加载', exact: true }).click();
      await modal.getByRole('status').filter({ hasText: 'Refmuse 已连接' }).waitFor();
      const freshFrame = page.frames().find((frame) => frame.url().startsWith('https://refmuse.cn/'));
      assert.equal(await freshFrame.evaluate(() => window.retainedMarker), undefined);
      await freshFrame.locator('#import').click();
      await freshFrame.waitForFunction(() => window.replies.length >= 2);
      assert.equal(await freshFrame.evaluate(() => window.replies[0].ok), true);
      assert.equal(uploads.length, uploadsBeforeHidden + 1);

      assert.equal(await modal.locator('nav button').first().getAttribute('aria-pressed'), 'true');
      await page.screenshot({ path: path.join(root, '.cache/refmuse-integration/fixture-integrated.png') });
      await modal.getByRole('button', { name:'关闭参考库' }).click();
      await page.reload();
      await page.getByLabel('画布项目名称').waitFor();
      assert.equal(await page.locator('.project-open').count(), 0, 'reload restores imported project');
      const persisted = project.canvas.nodes.find(node => node.id === imported.id);
      assert.ok(persisted.data.assetPath);
      assert.equal(persisted.data.sourceGallery.author, 'Fixture');
    } else {
      assert.equal(project.canvas.nodes.some(node => node.type === 'media'), false, 'no saved phantom import');
      if (scenario === 'readonly') assert.equal(uploads.length, previousUploads);
      else await modal.getByRole('alert').filter({hasText:'导入未完成'}).waitFor();
    }
    assert.equal(prompts.length, 0, 'gallery does not trigger generation');
    assert.ok(remoteRequests.length >= 2);
    await context.close();
  }
  assert.deepEqual(failures, []);
  console.log('reference library UI: authenticated live light/dark themes, square shell, removed footer, browse, readonly, MCP, Refmuse persistence/reopen, upload/save failures and keyboard isolation passed');
} finally { await browser.close(); }
