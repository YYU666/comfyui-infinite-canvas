import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './test-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.H3_TEST_PYTHON || process.env.PYTHON || 'python';
const temporary = await mkdtemp(path.join(tmpdir(), 'refmuse-update-ui-'));
const runtime = path.join(temporary, 'runtime');
const env = { ...process.env, H3_WORKBENCH_RUNTIME_DIR: runtime, H3_PROJECTS_ROOT: path.join(temporary, 'projects'), H3_WORKBENCH_DATA_DIR: path.join(temporary, 'data'), H3_WORKBENCH_NO_BROWSER: '1', H3_WORKBENCH_TEST_MODE: '1' };
const backend = spawn(python, ['video_workbench_launcher.py'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let base;
try {
  let instance;
  for (let count = 0; count < 100; count += 1) {
    try { instance = JSON.parse(await readFile(path.join(runtime, 'instance.json'), 'utf8')); break; }
    catch { if (backend.exitCode !== null) throw new Error(`backend exited ${backend.exitCode}`); await sleep(100); }
  }
  assert(instance?.port, 'isolated backend starts');
  base = `http://127.0.0.1:${instance.port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  const applyBodies = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/updates/status', (route) => route.fulfill({ json: { phase: 'idle', currentVersion: '1.0.1-rc.1', message: '' } }));
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: {
    currentVersion: '1.0.1-rc.1', version: 'v9.9.9', updateAvailable: true, canApply: true,
    notes: '修复画布并改进安全升级。', url: 'https://github.com/YYU666/comfyui-infinite-canvas/releases/tag/v9.9.9',
  } }));
  await page.route('**/api/updates/apply', async (route) => {
    applyBodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { accepted: true, version: 'v9.9.9' } });
  });
  await page.goto(base);
  await page.getByRole('heading', { name: '发现新版本 v9.9.9' }).waitFor();
  assert.equal(await page.locator('.update-notes').innerText(), '修复画布并改进安全升级。');
  await page.getByRole('button', { name: '稍后', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByLabel('启动时检查 GitHub Release').isChecked(), true);
  await page.getByRole('button', { name: '立即检查更新', exact: true }).click();
  await page.getByRole('heading', { name: '发现新版本 v9.9.9' }).waitFor();
  await page.getByRole('button', { name: '立即升级', exact: true }).click();
  await page.getByRole('heading', { name: '正在安全升级' }).waitFor();
  assert.deepEqual(applyBodies, [{ tag: 'v9.9.9' }], 'one click sends only the confirmed tag');
  assert.equal(await page.getByRole('button', { name: '立即升级', exact: true }).count(), 0, 'apply cannot be clicked twice');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ ok: true, automaticPrompt: true, manualCheck: true, confirmedTag: true, duplicateApplyBlocked: true, realUpgrade: false }));
} finally {
  if (browser) await browser.close();
  if (base) spawnSync(python, ['stop.py'], { cwd: root, env, timeout: 15000 });
  for (let count = 0; count < 50 && backend.exitCode === null; count += 1) await sleep(100);
  if (backend.exitCode === null) backend.kill();
  await rm(temporary, { recursive: true, force: true });
}
