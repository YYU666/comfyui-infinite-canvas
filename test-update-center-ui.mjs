import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { chromium } from './test-browser.mjs';

// Only synthetic components and intercepted APIs: no backend, project, or live canvas.
const root = path.dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', `<!doctype html><html><body><div id="root"></div>
    <script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import UpdateCenter from '/src/UpdateCenter.jsx';
      import SettingsDialog from '/src/SettingsDialog.jsx';
      function Fixture() {
        const [settings, showSettings] = React.useState(false);
        const [projectOpen, setProjectOpen] = React.useState(false);
        return React.createElement(React.Fragment, null,
          React.createElement('button', {onClick: () => window.dispatchEvent(new Event('refmuse-check-updates'))}, '手动检查'),
          React.createElement('button', {onClick: () => showSettings(true)}, '设置'),
          React.createElement('button', {onClick: () => setProjectOpen(!projectOpen)}, '切换项目'),
          React.createElement(UpdateCenter, {projectOpen}),
          settings && React.createElement(SettingsDialog, {onClose: () => showSettings(false), onSaved: () => {}}));
      }
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script></body></html>`));
});
const httpServer = createHttpServer(server.middlewares);
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  let settings = { updates: {autoCheck: true}, projectsRoot: 'C:/synthetic/projects', comfyRoot: 'C:/synthetic/comfy', modelRoots: [], defaults: {ratio: '16:9', resolution: '720P', duration: 5}, queue: {concurrency: 1}, logLevel: 'INFO', deepseek: {configured: false, source: 'none'} };
  let result = { currentVersion: '1.0.1-rc.1', version: 'v9.9.9', updateAvailable: true, canApply: true, notes: '合成测试发布说明', url: 'https://github.com/example/synthetic/releases/tag/v9.9.9' };
  let checks = 0;
  let held = null;
  let hold = false;
  let statusCode = 200;
  let updateStatus = {phase: 'idle', currentVersion: '1.0.1-rc.1'};
  let heldApply;
  let statusReads = 0;
  const applyBodies = [];
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'PUT') settings = {...settings, ...route.request().postDataJSON()};
    return route.fulfill({json: settings});
  });
  await page.route('**/api/updates/status', (route) => { statusReads++; return route.fulfill({status: statusCode, json: updateStatus}); });
  await page.route('**/api/updates/check', async (route) => {
    checks++;
    if (hold) { held = route; return; }
    await route.fulfill({json: result});
  });
  await page.route('**/api/updates/apply', async (route) => {
    applyBodies.push(route.request().postDataJSON());
    heldApply = route;
  });
  await page.route('**/api/health', (route) => route.fulfill({json: {version: '1.0.1-rc.1'}}));
  const manual = () => page.evaluate(() => window.dispatchEvent(new Event('refmuse-check-updates')));
  const close = () => page.getByRole('button', {name: '关闭更新窗口', exact: true}).click();
  const banner = page.locator('.update-available-banner');
  const waitChecks = async (count) => { await page.waitForFunction(() => true); for (let i = 0; checks < count && i < 100; i++) await page.waitForTimeout(30); assert.equal(checks, count); };
  const configure = (autoCheck) => page.evaluate((value) => window.dispatchEvent(new CustomEvent('h3-settings-changed', {detail: {updates: {autoCheck: value}}})), autoCheck);
  await page.goto(base);
  await banner.waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'automatic discovery is non-blocking');
  await page.getByRole('button', {name: '查看更新', exact: true}).click();
  assert.equal(await page.locator('.update-notes').innerText(), '合成测试发布说明');
  await page.getByRole('button', {name: '稍后', exact: true}).click();
  await page.reload(); await waitChecks(2); await page.waitForTimeout(100);
  assert.equal(await banner.count(), 0, 'dismiss survives refresh');
  await manual(); await page.getByRole('heading', {name: '发现新版本 v9.9.9'}).waitFor(); await close();
  result = {...result, version: 'v9.9.10'};
  await page.reload(); await banner.waitFor(); assert.match(await banner.innerText(), /v9.9.10/);
  await page.getByRole('button', {name: '忽略此版本更新提示'}).click();

  await page.getByRole('button', {name: '设置', exact: true}).click();
  await page.getByLabel('自动检查 GitHub Release').uncheck();
  await page.getByRole('button', {name: '保存设置'}).click();
  await page.getByRole('heading', {name: '工作台设置'}).waitFor({state: 'hidden'});
  const beforeOptOut = checks;
  await page.reload(); await page.waitForTimeout(1400); assert.equal(checks, beforeOptOut);
  await manual(); await page.getByRole('heading', {name: '发现新版本 v9.9.10'}).waitFor(); await close();

  result = {currentVersion: '1.0.1-rc.1', status: 'no_release', updateAvailable: false, message: '官方仓库尚未发布 Release。'};
  await manual(); await page.getByText('官方仓库尚未发布 Release。', {exact: true}).waitFor();
  assert.equal(await page.getByRole('heading', {name: '已是最新版本'}).count(), 0); await close();
  statusCode = 503; settings.updates.autoCheck = true;
  await page.reload(); await page.waitForTimeout(1500);
  assert.equal(await page.getByRole('dialog').count(), 0, 'automatic network errors are quiet');
  await manual(); await page.getByText('更新请求失败（503）。', {exact: true}).waitFor(); await close();
  statusCode = 404; await manual(); await page.getByText(/当前后端尚不支持更新检查/).waitFor(); await close(); statusCode = 200;

  // A stalled fetch times out and releases the request lock for a later manual retry.
  await page.clock.install();
  hold = true; const beforeTimeout = checks; await manual(); await waitChecks(beforeTimeout + 1);
  await page.clock.fastForward(30001);
  await page.getByText('更新请求超时，请检查网络后重试。', {exact: true}).waitFor();
  hold = false; await held.fulfill({json: result}).catch(() => {}); held = null; await close();

  // Closing an in-flight manual request cannot reopen a modal.
  hold = true; const beforeHeld = checks; await manual(); await waitChecks(beforeHeld + 1);
  await close(); hold = false; await held.fulfill({json: {...result, updateAvailable: true, version: 'v9.9.11'}}); held = null;
  await page.waitForTimeout(100); assert.equal(await page.getByRole('dialog').count(), 0);

  // Automatic in-flight notices are invalidated by opt-out, even after re-enabling.
  settings.updates.autoCheck = true; hold = true; const beforeAutomatic = checks;
  await page.reload(); await waitChecks(beforeAutomatic + 1);
  await configure(false); await configure(true);
  hold = false; result = {...result, updateAvailable: true, version: 'v9.9.12', canApply: true};
  await held.fulfill({json: result}); held = null; await page.waitForTimeout(100);
  assert.equal(await banner.count(), 0); assert.equal(await page.getByRole('dialog').count(), 0);

  // Manual action joins an automatic request instead of being lost or overlapping.
  hold = true; const beforeJoin = checks; await page.reload(); await waitChecks(beforeJoin + 1);
  await manual(); await manual(); assert.equal(checks, beforeJoin + 1);
  hold = false; await held.fulfill({json: result}); held = null;
  await page.getByRole('heading', {name: '发现新版本 v9.9.12'}).waitFor();
  await close();
  await page.getByRole('button', {name: '切换项目'}).click(); await manual();
  await page.getByRole('heading', {name: '发现新版本 v9.9.12'}).waitFor();
  assert.equal(await page.getByRole('button', {name: '立即升级', exact: true}).isDisabled(), true);
  await close(); await page.getByRole('button', {name: '切换项目'}).click(); await manual();
  await page.getByRole('heading', {name: '发现新版本 v9.9.12'}).waitFor();
  updateStatus = {phase: 'preparing', version: result.version, message: '正在安装新版画布依赖…'};
  const readsBeforeApply = statusReads;
  await page.getByRole('button', {name: '立即升级', exact: true}).click();
  await page.getByRole('heading', {name: '正在安全升级'}).waitFor();
  await page.getByText('正在安装新版画布依赖…', {exact: true}).waitFor();
  await page.clock.fastForward(31000);
  await page.getByRole('heading', {name: '正在安全升级'}).waitFor();
  assert.equal(await page.getByRole('button', {name: '关闭更新窗口'}).count(), 0, 'long preparation remains busy');
  updateStatus = {...updateStatus, message: '正在构建新版画布…'};
  await page.clock.runFor(1600);
  await page.getByText('正在构建新版画布…', {exact: true}).waitFor();
  assert(statusReads > readsBeforeApply + 1, 'status is polled during the pending POST');
  await manual();
  assert.deepEqual(applyBodies, [{tag: 'v9.9.12'}]);
  assert.equal(await page.getByRole('button', {name: '立即升级', exact: true}).count(), 0);
  updateStatus = {phase: 'restarting', version: result.version, message: '更新已准备好，工作台即将重启…'};
  await heldApply.fulfill({json: {accepted: true, version: result.version}});
  await page.clock.runFor(1600);
  await page.getByText('更新已准备好，工作台即将重启…', {exact: true}).waitFor();
  assert.equal(applyBodies.length, 1, 'resolving a long POST never resubmits');

  // Simulate a separate confirmed attempt whose response is lost while the server continues.
  updateStatus = {phase: 'idle', currentVersion: '1.0.1-rc.1'};
  await page.reload(); await page.getByRole('button', {name: '手动检查'}).waitFor(); await manual();
  await page.getByRole('heading', {name: '发现新版本 v9.9.12'}).waitFor();
  updateStatus = {phase: 'preparing', version: result.version, message: '正在下载并校验更新包…'};
  await page.getByRole('button', {name: '立即升级', exact: true}).click();
  await page.getByText('正在下载并校验更新包…', {exact: true}).waitFor();
  await heldApply.abort('connectionreset');
  await page.clock.runFor(1600);
  await manual();
  assert.equal(applyBodies.length, 2, 'ambiguous transport error does not resubmit');
  assert.equal(await page.getByRole('button', {name: '关闭更新窗口'}).count(), 0);
  await page.getByRole('heading', {name: '正在安全升级'}).waitFor();
  updateStatus = {phase: 'error', version: result.version, message: '合成测试：构建失败，旧版尚未替换。'};
  await page.clock.runFor(1600);
  await page.getByText('合成测试：构建失败，旧版尚未替换。', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '关闭更新窗口'}).count(), 1, 'definitive status failure safely releases busy state');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ok: true, syntheticOnly: true, banner: true, dismissPersists: true, newVersion: true, settingsLive: true, manualOptOut: true, noRelease: true, oldBackend: true, quietAutomaticErrors: true, timeoutRecovery: true, inFlightClose: true, inFlightOptOut: true, joinedManual: true, projectGuard: true, confirmedApplyOnly: true, longApplyProgress: true, ambiguousApplyReconciled: true}));
} finally {
  if (browser) await browser.close();
  await server.close();
  await new Promise((resolve) => httpServer.close(resolve));
}
