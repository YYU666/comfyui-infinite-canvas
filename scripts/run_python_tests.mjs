import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.H3_TEST_PYTHON || 'python';
const nativePython = process.env.H3_TEST_NATIVE3D_PYTHON;

function run(executable, args, interpreterVariable) {
  return new Promise((resolve) => {
    const child = spawn(executable, ['-B', '-c', 'import os, runpy, sys; sys.path.insert(0, os.getcwd()); runpy.run_module("unittest", run_name="__main__")', ...args], {
      cwd: root, env: process.env, stdio: 'inherit',
    });
    child.once('error', (error) => {
      console.error(`无法启动 Python：${executable}。可用 ${interpreterVariable} 指定解释器。`, error.message);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

if (nativePython) {
  const nativeTest = /^test_native3d_.*\.py$/;
  const coreTests = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^test_.*\.py$/.test(entry.name) && !nativeTest.test(entry.name))
    .map((entry) => entry.name.slice(0, -3))
    .sort();

  console.log('[python] Workbench');
  const coreCode = await run(python, coreTests, 'H3_TEST_PYTHON');
  console.log('[python] Native3D');
  const nativeCode = await run(nativePython, ['discover', '-s', '.', '-p', 'test_native3d_*.py', '-t', '.'],
    'H3_TEST_NATIVE3D_PYTHON');
  process.exitCode = coreCode || nativeCode;
} else {
  process.exitCode = await run(python, ['discover', '-s', '.', '-p', 'test_*.py', '-t', '.'], 'H3_TEST_PYTHON');
}
