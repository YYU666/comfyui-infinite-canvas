import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = {
  node: [
    'test-api.mjs',
    'test-auto-save.mjs',
    'test-canvas-clipboard.mjs',
    'test-canvas-history.mjs',
    'test-canvas-layout.mjs',
    'test-canvas-mcp-queue.mjs',
    'test-generation-queue.mjs',
    'test-local-realism.mjs',
    'test-moss-workflow.mjs',
    'test-object-url-lru.mjs',
    'test-outfit-workflow.mjs',
    'test-qwen-edit.mjs',
    'test_queue_outfit_plan.mjs',
    'test-queue-notifications.mjs',
    'test-reference-quality.mjs',
    'test-reference-tags.mjs',
    'test-resolution.mjs',
  ],
  browser: [
    'test-canvas-clipboard-ui.mjs',
    'test-canvas-projects.mjs',
    'test-launcher-ui.mjs',
    'test-m2-ui.mjs',
    'test-m2-acceptance.mjs',
    'test-m3-ui.mjs',
    'test-update-center-ui.mjs',
  ],
};

const suiteName = process.argv[2] || 'node';
const tests = suites[suiteName];
if (!tests) {
  console.error(`未知测试套件 ${suiteName}；可选：${Object.keys(suites).join(', ')}`);
  process.exit(2);
}
const dist = path.resolve(process.env.H3_TEST_DIST_DIR || path.join(root, 'dist'));
const env = {
  ...process.env,
  H3_WORKBENCH_TEST_MODE: '1',
  H3_TEST_DIST_DIR: dist,
  H3_WORKBENCH_DIST_DIR: dist,
};

for (const test of tests) {
  console.log(`\n[${suiteName}] ${test}`);
  const testPath = path.join(root, test);
  if (!existsSync(testPath)) {
    console.error(`测试入口缺失：${test}。请确认它已纳入 Git 和发布源码包。`);
    process.exit(1);
  }
  const args = [testPath];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) process.exit(exitCode || 1);
}
console.log(`\n${suiteName} suite passed: ${tests.length} files`);
