import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAbr } from './src/paint-abr-parser.js';

function concat(...parts) { return Uint8Array.from(parts.flatMap((part) => [...part])); }
function u8(value) { return Uint8Array.of(value & 255); }
function u16(value) { return Uint8Array.of((value >> 8) & 255, value & 255); }
function i16(value) { return u16(value & 0xffff); }
function u32(value) { return Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255); }
function i32(value) { return u32(value >>> 0); }
function ascii(value) { return Uint8Array.from(value, (char) => char.charCodeAt(0)); }

function legacySample(version, width, height, pixels, name = '') {
  const image = concat(u32(0), u16(25), u32(0), i16(0), i16(0), i16(height), i16(width), u16(8), u8(0), pixels);
  const named = version === 2 ? concat(image, u8(name.length), ascii(name)) : image;
  return concat(u16(version), u16(1), u16(2), u32(named.length), named);
}

function packRow(pixels) {
  const packed = [];
  let index = 0;
  while (index < pixels.length) {
    let run = 1;
    while (index + run < pixels.length && pixels[index + run] === pixels[index] && run < 128) run += 1;
    if (run > 1) {
      packed.push((1 - run) & 255, pixels[index]);
      index += run;
    } else {
      packed.push(0, pixels[index]);
      index += 1;
    }
  }
  return Uint8Array.from(packed);
}

function modernSample(version, width, height, pixels, { rle = false, extraId = false } = {}) {
  let image = concat(u8(rle ? 1 : 0));
  if (!rle) image = concat(image, pixels);
  else {
    for (let y = 0; y < height; y += 1) {
      const row = packRow(pixels.subarray(y * width, (y + 1) * width));
      image = concat(image, version >= 10 ? u32(row.length) : u16(row.length), row);
    }
  }
  const bounds = concat(i32(0), i32(0), i32(height), i32(width), u16(8), image);
  const body = extraId ? concat(u32(0x11223344), bounds) : bounds;
  const item = concat(u32(body.length), body);
  const block = concat(ascii('8BIM'), ascii('samp'), u32(item.length), item, item.length % 2 ? u8(0) : Uint8Array.of());
  return concat(u16(version), u16(1), block);
}

test('v1 raw and v2 named samples become stamps', () => {
  const pixels = Uint8Array.from([255, 0, 0, 255]);
  const v1 = parseAbr(legacySample(1, 2, 2, pixels));
  assert.equal(v1.ok, true);
  assert.equal(v1.stamps[0].width, 2);
  assert.equal(v1.stamps[0].alpha[0], 255);
  assert.equal(v1.stamps[0].alpha[1], 0);
  assert.match(v1.message, /成功导入 1 个笔尖图案/);
  const v2 = parseAbr(legacySample(2, 2, 2, pixels, 'SketchTip'));
  assert.equal(v2.stamps[0].name, 'SketchTip');
});

test('v6 and v10 sample blocks decode raw, RLE and an optional id', () => {
  const pixels = Uint8Array.from([255, 255, 0, 0, 128, 64]);
  const raw = parseAbr(modernSample(6, 3, 2, pixels));
  assert.deepEqual([...raw.stamps[0].alpha], [...pixels]);
  const rle = parseAbr(modernSample(6, 3, 2, pixels, { rle: true }));
  assert.deepEqual([...rle.stamps[0].alpha], [...pixels]);
  const withId = parseAbr(modernSample(6, 3, 2, pixels, { extraId: true }));
  assert.deepEqual([...withId.stamps[0].alpha], [...pixels]);
  const v10 = parseAbr(modernSample(10, 3, 2, pixels, { rle: true }));
  assert.deepEqual([...v10.stamps[0].alpha], [...pixels]);
  assert.match(v10.message, /PS 私有双重画笔\/湿边参数已忽略/);
});

test('wide tips scale to a 512 edge and odd blocks keep the following sample', () => {
  const pixels = new Uint8Array(600 * 2).fill(200);
  const scaled = parseAbr(legacySample(1, 600, 2, pixels));
  assert.equal(scaled.ok, true);
  assert.equal(Math.max(scaled.stamps[0].width, scaled.stamps[0].height), 512);
  const dummy = concat(ascii('8BIM'), ascii('parm'), u32(1), u8(9), u8(0));
  const sample = modernSample(6, 2, 2, Uint8Array.from([1, 2, 3, 4]));
  const combined = concat(sample.subarray(0, 4), dummy, sample.subarray(4));
  const parsed = parseAbr(combined);
  assert.equal(parsed.ok, true);
  assert.deepEqual([...parsed.stamps[0].alpha], [1, 2, 3, 4]);
});

test('empty, truncated, unknown, computed-only and huge headers fail closed', () => {
  assert.equal(parseAbr(new Uint8Array()).ok, false);
  assert.match(parseAbr(new Uint8Array()).error, /空|损坏/);
  assert.equal(parseAbr(concat(u16(1), u16(1))).ok, false);
  assert.match(parseAbr(concat(u16(1), u16(1))).error, /损坏|不完整/);
  const unknown = parseAbr(concat(u16(99), u16(0)));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /无法识别|加密|高版本/);
  const computed = concat(u16(1), u16(1), u16(1), u32(0));
  const skipped = parseAbr(computed);
  assert.equal(skipped.ok, false);
  assert.match(skipped.error, /没有可提取的笔尖|纯参数|加密/);
  const huge = concat(u16(6), u16(1), ascii('8BIM'), ascii('samp'), u32(23), u32(19), i32(0), i32(0), i32(20000), i32(20000), u16(8), u8(0));
  const rejected = parseAbr(huge);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /尺寸|损坏|没有可提取/);
  assert.equal(parseAbr(new Uint8Array(50 * 1024 * 1024 + 1)).ok, false);
});
