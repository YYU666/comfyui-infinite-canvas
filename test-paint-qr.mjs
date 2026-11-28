import assert from 'node:assert/strict';
import test from 'node:test';
import { qrMatrix, qrSvg } from './src/paint-qr.js';

function finder(modules, row, col) {
  return modules[row][col] && modules[row + 6][col + 6] && !modules[row + 1][col + 1];
}

test('pairing links become a quiet-zone SVG with three finders', () => {
  const link = 'http://192.168.1.25:43123/companion?code=246810';
  const code = qrMatrix(link);
  assert.ok(code.size >= 21 && code.size <= 41);
  assert.equal(finder(code.modules, 0, 0), true);
  assert.equal(finder(code.modules, 0, code.size - 7), true);
  assert.equal(finder(code.modules, code.size - 7, 0), true);
  assert.notDeepEqual(code.modules, qrMatrix(`${link}x`).modules);
  const svg = qrSvg(link);
  assert.match(svg, /^<svg/);
  assert.match(svg, /<rect fill="#111"/);
});
