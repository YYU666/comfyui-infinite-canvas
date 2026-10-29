import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.H3_TEST_PYTHON || 'python';
const args = ['-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py', '-t', '.'];
const child = spawn(python, args, { cwd: root, env: process.env, stdio: 'inherit' });
child.once('error', (error) => {
  console.error(`无法启动 Python：${python}。可用 H3_TEST_PYTHON 指定解释器。`, error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
