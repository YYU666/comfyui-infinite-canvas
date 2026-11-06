import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHANNEL_KEYS, DEFAULT_CHANNEL_PACK, normalizeChannelPackSettings, packImageChannels, encodeTga, decodeTga,
} from './src/channel-packing.js';

const pixel = (...values) => ({ width: values.length / 4, height: 1, data: new Uint8ClampedArray(values) });
const gray = (value, alpha = 255) => pixel(value, value, value, alpha);
const values = (image) => [...image.data];

test('default map has four independent sources and alpha fallback is opaque', () => {
  assert.deepEqual(CHANNEL_KEYS, ['red', 'green', 'blue', 'alpha']);
  assert.deepEqual(normalizeChannelPackSettings(), DEFAULT_CHANNEL_PACK);
  assert.deepEqual(values(packImageChannels({ red: gray(80) })), [80, 0, 0, 255]);
  assert.deepEqual(values(packImageChannels({ alpha: gray(90) })), [0, 0, 0, 90]);
  const normalized = normalizeChannelPackSettings();
  normalized.channels.red.value = 99;
  assert.equal(DEFAULT_CHANNEL_PACK.channels.red.value, 0);
  assert.equal(normalized.channels.green.value, 0);
});

test('four grayscale maps pack into raw RGBA independent of source opacity', () => {
  assert.deepEqual(values(packImageChannels({
    red: gray(17, 0), green: gray(80, 1), blue: gray(201, 128), alpha: gray(39, 0),
  })), [17, 80, 201, 39]);
});

test('each output can select any raw source component or luminance', () => {
  const input = pixel(21, 82, 203, 0);
  assert.deepEqual(values(packImageChannels({ red: input, green: input, blue: input, alpha: input }, {
    packChannels: { red: { source: 'blue' }, green: { source: 'red' }, blue: { source: 'green' }, alpha: { source: 'alpha' } },
  })), [203, 21, 82, 0]);
  assert.deepEqual(values(packImageChannels({ red: pixel(255, 0, 0, 0) })), [54, 0, 0, 255]);
  assert.deepEqual(values(packImageChannels({ red: pixel(0, 255, 0, 0) })), [182, 0, 0, 255]);
  assert.deepEqual(values(packImageChannels({ red: pixel(0, 0, 255, 0) })), [18, 0, 0, 255]);
});

test('inversion applies uniformly to connected image channels and fallback constants', () => {
  assert.deepEqual(values(packImageChannels({ red: pixel(10, 20, 30, 40) }, {
    channels: { red: { source: 'alpha', invert: true }, green: { value: 12, invert: true }, blue: { value: 200 }, alpha: { invert: true } },
  })), [215, 243, 200, 0]);
});

test('settings normalize finite values, prefer persisted packChannels and do not mutate', () => {
  const settings = { packChannels: { red: { source: 'bad', value: 999, invert: 'true' }, green: { value: -20 }, blue: { value: 4.6 }, alpha: { value: Infinity } }, channels: { red: { value: 100 } } };
  const before = structuredClone(settings);
  assert.deepEqual(normalizeChannelPackSettings(settings), {
    channels: {
      red: { source: 'luminance', value: 255, invert: false },
      green: { source: 'luminance', value: 0, invert: false },
      blue: { source: 'luminance', value: 5, invert: false },
      alpha: { source: 'luminance', value: 255, invert: false },
    },
  });
  assert.deepEqual(settings, before);
  assert.deepEqual(normalizeChannelPackSettings(null), DEFAULT_CHANNEL_PACK);
});

test('packing preserves input buffers and respects all pixels across rows', () => {
  const red = { width: 2, height: 2, data: new Uint8ClampedArray([10, 10, 10, 0, 20, 20, 20, 0, 30, 30, 30, 0, 40, 40, 40, 0]) };
  const original = values(red);
  const result = packImageChannels({ red });
  assert.deepEqual(values(result), [10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255]);
  result.data[0] = 255;
  assert.deepEqual(values(red), original);
});

test('packing rejects missing, malformed or differently sized inputs', () => {
  assert.throws(() => packImageChannels(null), TypeError);
  assert.throws(() => packImageChannels({}), /至少连接/);
  assert.throws(() => packImageChannels({ red: { width: 2, height: 1, data: new Uint8ClampedArray(4) } }), TypeError);
  assert.throws(() => packImageChannels({ red: gray(1), blue: pixel(2, 2, 2, 255, 3, 3, 3, 255) }), RangeError);
  assert.throws(() => packImageChannels({ red: gray(1), green: false }), TypeError);
});

test('TGA emits exact uncompressed 32-bit header and raw BGRA including alpha-zero RGB', () => {
  const image = pixel(17, 80, 201, 0);
  const encoded = encodeTga(image);
  assert.ok(encoded instanceof Uint8Array);
  assert.deepEqual([...encoded], [
    0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 32, 0x28,
    201, 80, 17, 0,
  ]);
  assert.deepEqual(values(image), [17, 80, 201, 0]);
});

test('TGA top-left origin preserves row order with 2x2 known RGBA pixels', () => {
  const image = { width: 2, height: 2, data: new Uint8ClampedArray([
    255, 0, 0, 1, 0, 255, 0, 2,
    0, 0, 255, 3, 17, 80, 201, 4,
  ]) };
  const encoded = encodeTga(image);
  assert.deepEqual([...encoded.slice(12, 18)], [2, 0, 2, 0, 32, 0x28]);
  assert.deepEqual([...encoded.slice(18)], [0, 0, 255, 1, 0, 255, 0, 2, 255, 0, 0, 3, 201, 80, 17, 4]);
  assert.equal(encoded.length, 18 + 2 * 2 * 4);
});

test('TGA uses little-endian dimensions and rejects dimensions outside its 16-bit header', () => {
  const image = { width: 256, height: 1, data: new Uint8Array(256 * 4) };
  assert.deepEqual([...encodeTga(image).slice(12, 16)], [0, 1, 1, 0]);
  assert.throws(() => encodeTga({ width: 65536, height: 1, data: new Uint8Array(65536 * 4) }), RangeError);
  assert.throws(() => encodeTga({ width: 1, height: 65536, data: new Uint8Array(65536 * 4) }), RangeError);
  assert.throws(() => encodeTga({ width: 0, height: 1, data: new Uint8Array() }), TypeError);
  assert.throws(() => encodeTga({ width: 1, height: 1, data: [1, 2, 3, 4] }), TypeError);
});

test('TGA raw round-trip retains RGBA including hidden RGB under zero alpha', () => {
  const image = { width: 2, height: 2, data: new Uint8ClampedArray([
    17, 80, 201, 0, 255, 0, 0, 1,
    0, 255, 0, 128, 9, 23, 141, 255,
  ]) };
  const encoded = encodeTga(image);
  const original = [...encoded];
  const decoded = decodeTga(encoded);
  assert.deepEqual(decoded, image);
  assert.notEqual(decoded.data, image.data);
  assert.deepEqual([...encoded], original);
  assert.deepEqual(decodeTga(new Uint8ClampedArray(encoded)), image);
  // A view into a larger byte buffer must honor its byteOffset.
  const wrapped = new Uint8Array(encoded.length + 10);
  wrapped.set(encoded, 5);
  assert.deepEqual(decodeTga(wrapped.subarray(5, 5 + encoded.length)), image);
});

test('TGA decoder normalizes all four top/bottom and left/right origin combinations', () => {
  const image = { width: 2, height: 2, data: new Uint8ClampedArray([
    255, 0, 0, 0, 0, 255, 0, 2,
    0, 0, 255, 3, 17, 80, 201, 4,
  ]) };
  const canonical = encodeTga(image);
  const pixels = Array.from({ length: 4 }, (_, index) => [...canonical.slice(18 + index * 4, 22 + index * 4)]);
  const origins = [
    [0x28, [0, 1, 2, 3]], // Top-left.
    [0x08, [2, 3, 0, 1]], // Bottom-left.
    [0x38, [1, 0, 3, 2]], // Top-right.
    [0x18, [3, 2, 1, 0]], // Bottom-right.
  ];
  for (const [descriptor, order] of origins) {
    const encoded = new Uint8Array(canonical);
    encoded[17] = descriptor;
    encoded.set(order.flatMap((index) => pixels[index]), 18);
    assert.deepEqual(decodeTga(encoded), image, `descriptor ${descriptor}`);
  }
});

test('TGA decoder skips image IDs and tolerates an optional footer after complete pixels', () => {
  const image = pixel(17, 80, 201, 0);
  const encoded = encodeTga(image);
  const withIdAndFooter = new Uint8Array(encoded.length + 3 + 26);
  withIdAndFooter.set(encoded.subarray(0, 18));
  withIdAndFooter[0] = 3;
  withIdAndFooter.set([65, 66, 67], 18);
  withIdAndFooter.set(encoded.subarray(18), 21);
  assert.deepEqual(decodeTga(withIdAndFooter), image);
});

test('TGA decoder rejects truncated, forged or unsupported headers before pixel allocation', () => {
  const encoded = encodeTga(pixel(1, 2, 3, 0));
  assert.throws(() => decodeTga([...encoded]), TypeError);
  assert.throws(() => decodeTga(encoded.slice(0, 17)), TypeError);
  assert.throws(() => decodeTga(encoded.slice(0, -1)), RangeError);
  for (const [index, value] of [[1, 1], [2, 10], [2, 3], [16, 24], [17, 0x68], [17, 0x24]]) {
    const invalid = new Uint8Array(encoded);
    invalid[index] = value;
    assert.throws(() => decodeTga(invalid), TypeError, `header ${index}=${value}`);
  }
  const zeroWidth = new Uint8Array(encoded); zeroWidth[12] = 0;
  assert.throws(() => decodeTga(zeroWidth), RangeError);
  const forged = new Uint8Array(encoded); forged.set([255, 255, 255, 255], 12);
  assert.throws(() => decodeTga(forged), /不完整/);
  const missingId = new Uint8Array(encoded); missingId[0] = 255;
  assert.throws(() => decodeTga(missingId), /不完整/);
});
