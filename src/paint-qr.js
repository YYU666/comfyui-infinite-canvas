const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
}

const VERSIONS = [
  { version: 1, size: 21, data: 16, ecc: 10, blocks: 1, per: 16, chars: 14, align: [], remainder: 0 },
  { version: 2, size: 25, data: 28, ecc: 16, blocks: 1, per: 28, chars: 26, align: [6, 18], remainder: 7 },
  { version: 3, size: 29, data: 44, ecc: 26, blocks: 1, per: 44, chars: 42, align: [6, 22], remainder: 7 },
  { version: 4, size: 33, data: 64, ecc: 18, blocks: 2, per: 32, chars: 62, align: [6, 26], remainder: 7 },
  { version: 5, size: 37, data: 86, ecc: 24, blocks: 2, per: 43, chars: 84, align: [6, 30], remainder: 7 },
  { version: 6, size: 41, data: 108, ecc: 16, blocks: 4, per: 27, chars: 106, align: [6, 34], remainder: 7 },
];

function mul(left, right) {
  if (!left || !right) return 0;
  return EXP[LOG[left] + LOG[right]];
}

function reedSolomon(data, count) {
  let generator = [1];
  for (let index = 0; index < count; index += 1) {
    const next = new Array(generator.length + 1).fill(0);
    for (let term = 0; term < generator.length; term += 1) {
      next[term] ^= generator[term];
      next[term + 1] ^= mul(generator[term], EXP[index]);
    }
    generator = next;
  }
  const out = new Uint8Array(data.length + count);
  out.set(data);
  for (let index = 0; index < data.length; index += 1) {
    const factor = out[index];
    if (!factor) continue;
    for (let term = 0; term < generator.length; term += 1) out[index + term] ^= mul(generator[term], factor);
  }
  return out.slice(data.length);
}

function encodeData(text, spec) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > spec.chars) throw new Error('二维码内容超出当前版本。');
  const bits = [];
  const push = (value, length) => { for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const limit = spec.data * 8;
  for (let index = 0; index < 4 && bits.length < limit; index += 1) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[index + bit];
    data.push(value);
  }
  for (let index = 0; data.length < spec.data; index += 1) data.push(index % 2 ? 0x11 : 0xec);
  const blocks = [];
  const eccBlocks = [];
  for (let index = 0; index < spec.blocks; index += 1) {
    const block = Uint8Array.from(data.slice(index * spec.per, (index + 1) * spec.per));
    blocks.push(block);
    eccBlocks.push(reedSolomon(block, spec.ecc));
  }
  const interleaved = [];
  for (let column = 0; column < spec.per; column += 1) for (const block of blocks) interleaved.push(block[column]);
  for (let column = 0; column < spec.ecc; column += 1) for (const block of eccBlocks) interleaved.push(block[column]);
  const output = [];
  for (const byte of interleaved) for (let bit = 7; bit >= 0; bit -= 1) output.push((byte >> bit) & 1);
  for (let index = 0; index < spec.remainder; index += 1) output.push(0);
  return output;
}

function blank(size) { return Array.from({ length: size }, () => Array(size).fill(null)); }

function paintFinder(matrix, row, col) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const yy = row + y; const xx = col + x;
      if (yy < 0 || xx < 0 || yy >= matrix.length || xx >= matrix.length) continue;
      const edge = y === -1 || x === -1 || y === 7 || x === 7;
      const outer = y === 0 || x === 0 || y === 6 || x === 6;
      const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
      matrix[yy][xx] = edge ? false : Boolean(outer || core);
    }
  }
}

function paintAlignment(matrix, row, col) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      matrix[row + y][col + x] = Math.max(Math.abs(x), Math.abs(y)) !== 1;
    }
  }
}

function reserve(matrix) {
  const size = matrix.length;
  paintFinder(matrix, 0, 0);
  paintFinder(matrix, 0, size - 7);
  paintFinder(matrix, size - 7, 0);
  for (let index = 8; index < size - 8; index += 1) {
    if (matrix[6][index] === null) matrix[6][index] = index % 2 === 0;
    if (matrix[index][6] === null) matrix[index][6] = index % 2 === 0;
  }
  matrix[size - 8][8] = true;
  for (let index = 0; index < 9; index += 1) {
    if (matrix[8][index] === null) matrix[8][index] = false;
    if (matrix[index][8] === null) matrix[index][8] = false;
  }
  for (let index = 0; index < 8; index += 1) {
    if (matrix[8][size - 1 - index] === null) matrix[8][size - 1 - index] = false;
    if (matrix[size - 1 - index][8] === null) matrix[size - 1 - index][8] = false;
  }
}

function place(matrix, bits, dataCells) {
  const size = matrix.length;
  let cursor = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const xx of [col, col - 1]) {
        if (matrix[row][xx] !== null) continue;
        matrix[row][xx] = cursor < bits.length ? Boolean(bits[cursor]) : false;
        if (dataCells) dataCells[row][xx] = true;
        cursor += 1;
      }
    }
    upward = !upward;
  }
}

function masked(row, col, mask, bit) {
  const on = [
    (row + col) % 2 === 0,
    row % 2 === 0,
    col % 3 === 0,
    (row + col) % 3 === 0,
    (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
    ((row * col) % 2) + ((row * col) % 3) === 0,
    (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
    (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
  ][mask];
  return on ? !bit : bit;
}

function formatBits(mask) {
  let rem = mask << 10;
  for (let index = 14; index >= 10; index -= 1) if (rem & (1 << index)) rem ^= 0x537 << (index - 10);
  return ((mask << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function drawFormat(matrix, mask) {
  const bits = formatBits(mask);
  const size = matrix.length;
  const bit = (index) => Boolean((bits >> index) & 1);
  for (let index = 0; index <= 5; index += 1) matrix[index][8] = bit(index);
  matrix[7][8] = bit(6);
  matrix[8][8] = bit(7);
  matrix[8][7] = bit(8);
  for (let index = 9; index < 15; index += 1) matrix[8][14 - index] = bit(index);
  for (let index = 0; index < 8; index += 1) matrix[8][size - 1 - index] = bit(index);
  for (let index = 8; index < 15; index += 1) matrix[size - 15 + index][8] = bit(index);
  matrix[size - 8][8] = true;
}

function penalty(matrix) {
  let dark = 0;
  for (const row of matrix) for (const cell of row) if (cell) dark += 1;
  return Math.abs(dark * 2 - matrix.length * matrix.length);
}

export function qrMatrix(text) {
  const payload = String(text || '');
  const spec = VERSIONS.find((item) => item.chars >= new TextEncoder().encode(payload).length);
  if (!spec) throw new Error('链接过长，无法生成配对二维码。');
  const bits = encodeData(payload, spec);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = blank(spec.size);
    reserve(matrix);
    for (let row = 0; row < spec.align.length; row += 1) {
      for (let col = 0; col < spec.align.length; col += 1) {
        const y = spec.align[row]; const x = spec.align[col];
        if (matrix[y][x] !== null) continue;
        paintAlignment(matrix, y, x);
      }
    }
    const dataCells = blank(spec.size);
    place(matrix, bits, dataCells);
    for (let row = 0; row < spec.size; row += 1) {
      for (let col = 0; col < spec.size; col += 1) {
        if (dataCells[row][col]) matrix[row][col] = masked(row, col, mask, Boolean(matrix[row][col]));
      }
    }
    drawFormat(matrix, mask);
    const score = penalty(matrix);
    if (score < bestScore) { best = matrix; bestScore = score; }
  }
  return { size: spec.size, version: spec.version, modules: best };
}

export function qrSvg(text, cell = 4) {
  const code = qrMatrix(text);
  const quiet = 4;
  const size = (code.size + quiet * 2) * cell;
  const rects = [];
  code.modules.forEach((row, y) => row.forEach((on, x) => {
    if (on) rects.push(`<rect fill="#111" x="${(x + quiet) * cell}" y="${(y + quiet) * cell}" width="${cell}" height="${cell}"/>`);
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>${rects.join('')}</svg>`;
}
