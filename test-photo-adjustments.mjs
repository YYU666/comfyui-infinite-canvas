import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHOTO_ADJUSTMENTS, PHOTO_CONTROL_SCHEMAS, DEFAULT_PHOTO_SETTINGS,
  normalizeCurvePoints, curveValue, normalizePhotoAdjustment, applyPhotoAdjustment,
} from './src/photo-adjustments.js';
import { adjustImagePixels } from './src/image-compositing.js';

const pixel = (...data) => ({ width: data.length / 4, height: 1, data: new Uint8ClampedArray(data) });
const values = (image) => [...image.data];
const apply = (image, mode, settings = {}) => applyPhotoAdjustment(image, { adjustmentType: mode, [mode]: settings });
const approx = (actual, expected, tolerance = 1) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `channel ${index}: ${value} vs ${expected[index]}`));

test('registry exposes all requested families, with defaults and bounded simple-control schemas', () => {
  const names = PHOTO_ADJUSTMENTS.map(({ value }) => value);
  assert.equal(new Set(names).size, names.length);
  assert.ok(['basic', 'hsl', 'levels'].every((name) => names.includes(name)));
  for (const name of ['exposure', 'whiteBalance', 'vibrance', 'curves', 'shadowsHighlights', 'colorBalance', 'selectiveColor', 'blackWhite', 'photoFilter', 'channelMixer', 'gradientMap', 'invert', 'threshold', 'posterize']) {
    assert.ok(names.includes(name), name);
    assert.ok(Object.hasOwn(DEFAULT_PHOTO_SETTINGS, name), name);
    assert.ok(PHOTO_ADJUSTMENTS.find(({ value }) => value === name).label);
  }
  for (const [mode, schema] of Object.entries(PHOTO_CONTROL_SCHEMAS)) for (const control of schema) {
    assert.ok(Object.hasOwn(DEFAULT_PHOTO_SETTINGS[mode], control.key), `${mode}.${control.key}`);
    if (control.type === 'range') assert.ok(Number.isFinite(control.min) && control.max > control.min && control.step > 0);
  }
});

test('neutral families preserve every RGBA byte and never share output buffers', () => {
  const source = pixel(1, 129, 254, 0, 32, 73, 234, 123, 0, 255, 127, 255);
  for (const mode of ['exposure', 'whiteBalance', 'vibrance', 'curves', 'shadowsHighlights', 'colorBalance', 'selectiveColor', 'channelMixer']) {
    const result = apply(source, mode);
    assert.deepEqual(values(result), values(source), mode);
    assert.notEqual(result.data, source.data);
  }
  for (const [mode, settings] of [['photoFilter', { density: 0 }], ['gradientMap', { amount: 0 }], ['posterize', { levels: 256 }]]) {
    assert.deepEqual(values(apply(source, mode, settings)), values(source));
  }
});

test('new dispatch reaches core while basic/HSL/Levels still use their existing paths', () => {
  const input = pixel(20, 90, 200, 123);
  assert.deepEqual(values(adjustImagePixels(input, { adjustmentType: 'invert' })), [235, 165, 55, 123]);
  assert.deepEqual(values(adjustImagePixels(input, { adjustmentType: 'hsl' })), values(input));
  assert.deepEqual(values(adjustImagePixels(input, { adjustmentType: 'levels' })), values(input));
  assert.deepEqual(values(adjustImagePixels(input, {})), values(input));
});

test('exposure uses EV multiplication, additive offset and inverse gamma', () => {
  assert.deepEqual(values(apply(pixel(32, 64, 128, 93), 'exposure', { exposure: 1 })), [64, 128, 255, 93]);
  assert.deepEqual(values(apply(pixel(0, 64, 255, 93), 'exposure', { offset: 0.2 })), [51, 115, 255, 93]);
  assert.deepEqual(values(apply(pixel(64, 64, 64, 93), 'exposure', { gamma: 2 })), [128, 128, 128, 93]);
});

test('white balance moves warm/cool and green/magenta axes independently', () => {
  assert.deepEqual(values(apply(pixel(128, 128, 128, 33), 'whiteBalance', { temperature: 100 })), [179, 128, 77, 33]);
  assert.deepEqual(values(apply(pixel(128, 128, 128, 33), 'whiteBalance', { tint: 100 })), [147, 90, 147, 33]);
});

test('vibrance protects grays and already-saturated colors while increasing muted chroma', () => {
  assert.deepEqual(values(apply(pixel(128, 128, 128, 33), 'vibrance', { vibrance: 100 })), [128, 128, 128, 33]);
  assert.deepEqual(values(apply(pixel(255, 0, 0, 33), 'vibrance', { vibrance: 100 })), [255, 0, 0, 33]);
  const muted = apply(pixel(140, 110, 100, 33), 'vibrance', { vibrance: 100 });
  assert.ok(muted.data[0] - muted.data[2] > 40);
  assert.deepEqual(values(apply(pixel(255, 0, 0, 33), 'vibrance', { saturation: -100 })), [54, 54, 54, 33]);
});

test('curve normalization sorts, clamps, limits points and preserves minimum x separation', () => {
  const raw = [{ x: 128, y: 300 }, { x: 128.5, y: 20 }, { x: -2, y: 10 }, { x: 255, y: -10 }, { x: NaN, y: 20 }];
  const copy = structuredClone(raw);
  assert.deepEqual(normalizeCurvePoints(raw), [{ x: 0, y: 10 }, { x: 128, y: 255 }, { x: 255, y: 0 }]);
  assert.deepEqual(raw, copy);
  const many = normalizeCurvePoints(Array.from({ length: 256 }, (_, x) => ({ x, y: x })));
  assert.equal(many.length, 16);
  assert.equal(many[0].x, 0); assert.equal(many.at(-1).x, 255);
  assert.ok(many.slice(1).every((point, index) => point.x - many[index].x >= 1));
  assert.deepEqual(normalizeCurvePoints(null), [{ x: 0, y: 0 }, { x: 255, y: 255 }]);
});

test('shape-preserving cubic curves pass anchors without overshoot on nonmonotonic edits', () => {
  const points = [{ x: 0, y: 0 }, { x: 64, y: 220 }, { x: 128, y: 20 }, { x: 200, y: 240 }, { x: 255, y: 255 }];
  for (const point of points) assert.ok(Math.abs(curveValue(points, point.x) - point.y) < 1e-9);
  for (let section = 0; section < points.length - 1; section += 1) {
    const low = Math.min(points[section].y, points[section + 1].y);
    const high = Math.max(points[section].y, points[section + 1].y);
    for (let x = points[section].x; x <= points[section + 1].x; x += 0.5) {
      const y = curveValue(points, x);
      assert.ok(y >= low - 1e-8 && y <= high + 1e-8, `${x}: ${y} outside ${low}..${high}`);
    }
  }
  const midpoint = curveValue([{ x: 0, y: 0 }, { x: 128, y: 200 }, { x: 255, y: 255 }], 64);
  assert.ok(midpoint > 100 && midpoint < 200); // Smooth shape differs from straight-line interpolation.
});

test('curve application maps RGB master before individual channel with exact anchors', () => {
  assert.deepEqual(values(apply(pixel(0, 128, 255, 43), 'curves', { rgb: [{ x: 0, y: 255 }, { x: 255, y: 0 }] })), [255, 127, 0, 43]);
  assert.deepEqual(values(apply(pixel(128, 128, 128, 43), 'curves', {
    rgb: [{ x: 0, y: 0 }, { x: 128, y: 255 }, { x: 255, y: 255 }],
    red: [{ x: 0, y: 0 }, { x: 255, y: 128 }],
  })), [128, 255, 255, 43]);
});

test('shadow/highlight controls lift dark values and recover bright values', () => {
  const dark = apply(pixel(32, 32, 32, 88), 'shadowsHighlights', { shadows: 50 });
  const bright = apply(pixel(224, 224, 224, 88), 'shadowsHighlights', { highlights: 50 });
  assert.ok(dark.data[0] > 32);
  assert.ok(bright.data[0] < 224);
  assert.equal(dark.data[3], 88); assert.equal(bright.data[3], 88);
});

test('color balance selects tonal ranges and luminosity preservation is bounded', () => {
  assert.deepEqual(values(apply(pixel(128, 128, 128, 50), 'colorBalance', {
    midtones: { cyanRed: 100 }, preserveLuminosity: false,
  })), [255, 128, 128, 50]);
  const before = pixel(100, 100, 100, 50);
  const after = apply(before, 'colorBalance', { midtones: { cyanRed: 100 } });
  const outputLum = 0.2126 * after.data[0] + 0.7152 * after.data[1] + 0.0722 * after.data[2];
  assert.ok(Math.abs(outputLum - 100) < 1);
  assert.ok(after.data[0] > after.data[1]);
  assert.deepEqual(values(apply(pixel(0, 0, 0, 255), 'colorBalance', { highlights: { cyanRed: 100 }, preserveLuminosity: false })), [0, 0, 0, 255]);
});

test('selective color targets chromatic and neutral ranges with relative/absolute methods', () => {
  assert.deepEqual(values(apply(pixel(255, 0, 0, 71), 'selectiveColor', { reds: { cyan: 100 } })), [255, 0, 0, 71]);
  assert.deepEqual(values(apply(pixel(0, 0, 255, 71), 'selectiveColor', { reds: { cyan: 100 } })), [0, 0, 255, 71]);
  assert.deepEqual(values(apply(pixel(255, 255, 255, 71), 'selectiveColor', { whites: { cyan: 50 }, method: 'absolute' })), [128, 255, 255, 71]);
  const relative = apply(pixel(64, 0, 0, 71), 'selectiveColor', { reds: { cyan: 25 } });
  const absolute = apply(pixel(64, 0, 0, 71), 'selectiveColor', { reds: { cyan: 25 }, method: 'absolute' });
  assert.equal(relative.data[0], 16); assert.equal(absolute.data[0], 0);
});

test('relative selective CMY edits scale complementary ink at saturated endpoints', () => {
  assert.deepEqual(values(apply(pixel(255, 0, 0, 71), 'selectiveColor', { reds: { magenta: -50 } })), [255, 128, 0, 71]);
  assert.deepEqual(values(apply(pixel(255, 0, 0, 71), 'selectiveColor', { reds: { yellow: -100 } })), [255, 0, 255, 71]);
  assert.deepEqual(values(apply(pixel(255, 0, 0, 71), 'selectiveColor', { reds: { cyan: 50 } })), [255, 0, 0, 71]);
  assert.deepEqual(values(apply(pixel(255, 0, 0, 71), 'selectiveColor', { reds: { cyan: 50 }, method: 'absolute' })), [128, 0, 0, 71]);
  assert.deepEqual(values(apply(pixel(255, 0, 0, 71), 'selectiveColor', { reds: { magenta: 50 } })), [255, 0, 0, 71]);
});

test('selective black density stays separate from relative CMY channel ink', () => {
  assert.deepEqual(values(apply(pixel(255, 0, 0, 71), 'selectiveColor', { reds: { black: 50 } })), [128, 0, 0, 71]);
  assert.deepEqual(values(apply(pixel(128, 0, 0, 71), 'selectiveColor', { reds: { black: -50 } })), [192, 0, 0, 71]);
  assert.deepEqual(values(apply(pixel(255, 0, 0, 71), 'selectiveColor', { reds: { magenta: -50, black: 50 } })), [128, 64, 0, 71]);
  assert.deepEqual(values(apply(pixel(128, 0, 0, 71), 'selectiveColor', { reds: { black: 25 }, method: 'absolute' })), [64, 0, 0, 71]);
});

test('black and white mixer uses hue weights while preserving neutral grayscale', () => {
  assert.deepEqual(values(apply(pixel(255, 0, 0, 73), 'blackWhite')), [102, 102, 102, 73]);
  assert.deepEqual(values(apply(pixel(255, 255, 0, 73), 'blackWhite')), [153, 153, 153, 73]);
  assert.deepEqual(values(apply(pixel(100, 100, 100, 73), 'blackWhite')), [100, 100, 100, 73]);
});

test('photo filter mixes chosen color and optionally preserves luminance', () => {
  assert.deepEqual(values(apply(pixel(0, 0, 0, 33), 'photoFilter', { color: '#ff0000', density: 100, preserveLuminosity: false })), [255, 0, 0, 33]);
  const adjusted = apply(pixel(128, 128, 128, 33), 'photoFilter', { color: '#ff0000', density: 50 });
  assert.ok(adjusted.data[0] > adjusted.data[1]);
  assert.ok(Math.abs((0.2126 * adjusted.data[0] + 0.7152 * adjusted.data[1] + 0.0722 * adjusted.data[2]) - 128) < 1);
});

test('channel mixer supports channel swap, constants and monochrome from red output', () => {
  assert.deepEqual(values(apply(pixel(20, 100, 200, 41), 'channelMixer', {
    red: { red: 0, blue: 100 }, blue: { blue: 0, red: 100 },
  })), [200, 100, 20, 41]);
  assert.deepEqual(values(apply(pixel(20, 100, 200, 41), 'channelMixer', {
    red: { red: 0, green: 100, constant: 10 }, monochrome: true,
  })), [126, 126, 126, 41]);
});

test('gradient map supports endpoints, reverse and blending strength', () => {
  assert.deepEqual(values(apply(pixel(0, 0, 0, 33, 255, 255, 255, 71), 'gradientMap', { dark: '#ff0000', light: '#0000ff' })), [255, 0, 0, 33, 0, 0, 255, 71]);
  assert.deepEqual(values(apply(pixel(0, 0, 0, 33), 'gradientMap', { dark: '#ff0000', light: '#0000ff', reverse: true })), [0, 0, 255, 33]);
  assert.deepEqual(values(apply(pixel(0, 0, 0, 33), 'gradientMap', { dark: '#ff0000', amount: 50 })), [128, 0, 0, 33]);
});

test('invert, threshold and posterize have deterministic byte results', () => {
  assert.deepEqual(values(apply(pixel(0, 64, 255, 73), 'invert')), [255, 191, 0, 73]);
  assert.deepEqual(values(apply(pixel(127, 127, 127, 73, 128, 128, 128, 100), 'threshold')), [0, 0, 0, 73, 255, 255, 255, 100]);
  assert.deepEqual(values(apply(pixel(10, 100, 200, 73), 'posterize', { levels: 4 })), [0, 85, 170, 73]);
});

test('normalization clamps invalid finite controls and rejects malformed colors without mutating data', () => {
  assert.deepEqual(normalizePhotoAdjustment({ adjustmentType: 'exposure', exposure: { exposure: 200, offset: NaN, gamma: 0 }, selectedChannel: 'private-ui-value' }), {
    adjustmentType: 'exposure', exposure: { exposure: 5, offset: 0, gamma: 0.1 },
  });
  assert.deepEqual(normalizePhotoAdjustment({ adjustmentType: 'photoFilter', photoFilter: { color: 'url(secret)', density: -10, preserveLuminosity: 'false' } }), {
    adjustmentType: 'photoFilter', photoFilter: { color: '#ec8a2e', density: 0, preserveLuminosity: true },
  });
  assert.deepEqual(normalizePhotoAdjustment({ adjustmentType: 'invert', extra: 42 }), { adjustmentType: 'invert' });
  assert.equal(normalizePhotoAdjustment({ adjustmentType: 'posterize', posterize: { levels: 3.5 } }).posterize.levels, 4);
});

test('all modes preserve alpha and input objects, with finite clamped byte outputs', () => {
  for (const mode of Object.keys(DEFAULT_PHOTO_SETTINGS)) {
    const image = pixel(1, 129, 254, 0, 98, 234, 110, 123, 255, 0, 127, 255);
    const data = { adjustmentType: mode, [mode]: structuredClone(DEFAULT_PHOTO_SETTINGS[mode]) };
    const before = structuredClone(data); const inputBytes = values(image);
    const result = applyPhotoAdjustment(image, data);
    assert.deepEqual(values(image), inputBytes, mode);
    assert.deepEqual(data, before, mode);
    assert.deepEqual([result.data[3], result.data[7], result.data[11]], [0, 123, 255], mode);
    assert.ok(values(result).every((value) => Number.isFinite(value) && value >= 0 && value <= 255), mode);
  }
  assert.throws(() => applyPhotoAdjustment({ width: 0, height: 1, data: new Uint8ClampedArray() }), TypeError);
});

test('byte lookup fast paths exactly match scalar references for every input byte and diverse alpha', () => {
  const image = { width: 256, height: 1, data: new Uint8ClampedArray(256 * 4) };
  for (let value = 0; value < 256; value += 1) image.data.set([value, (value * 73 + 19) % 256, 255 - value, (value * 17) % 256], value * 4);
  const original = values(image);
  const bound = (value) => Math.min(1, Math.max(0, value));
  const scenarios = [
    ['exposure', { exposure: 1.37, offset: -0.12, gamma: 2.15 }],
    ['exposure', { exposure: -5, offset: 0.5, gamma: 0.1 }],
    ['exposure', { exposure: 5, offset: -0.5, gamma: 3 }],
    ['whiteBalance', { temperature: 37, tint: -81 }],
    ['whiteBalance', { temperature: -100, tint: 100 }],
    ['whiteBalance', { temperature: 100, tint: -100 }],
    ['invert', {}],
    ...[2, 3, 4, 7, 17, 255, 256].map((levels) => ['posterize', { levels }]),
  ];
  for (const [mode, settings] of scenarios) {
    const expected = new Uint8ClampedArray(image.data);
    for (let index = 0; index < image.data.length; index += 4) for (let component = 0; component < 3; component += 1) {
      const channel = image.data[index + component] / 255;
      let output;
      if (mode === 'exposure') output = bound(channel * 2 ** settings.exposure + settings.offset) ** (1 / settings.gamma);
      else if (mode === 'whiteBalance') output = component === 0 ? channel + settings.temperature * 0.002 + settings.tint * 0.00075
        : component === 1 ? channel - settings.tint * 0.0015 : channel - settings.temperature * 0.002 + settings.tint * 0.00075;
      else if (mode === 'invert') output = 1 - channel;
      else output = Math.round(channel * (settings.levels - 1)) / (settings.levels - 1);
      expected[index + component] = 255 * bound(output);
    }
    assert.deepEqual(apply(image, mode, settings).data, expected, `${mode}: ${JSON.stringify(settings)}`);
  }
  assert.deepEqual(values(image), original);
});

test('curve direct byte lookup keeps original table rounding through master and per-channel curves', () => {
  const image = { width: 256, height: 1, data: new Uint8ClampedArray(256 * 4) };
  for (let value = 0; value < 256; value += 1) image.data.set([value, 255 - value, (value * 53) % 256, value % 2 ? 0 : 137], value * 4);
  const settings = {
    rgb: [{ x: 0, y: 14 }, { x: 70, y: 215 }, { x: 156, y: 46 }, { x: 255, y: 242 }],
    red: [{ x: 0, y: 255 }, { x: 127, y: 50 }, { x: 255, y: 0 }],
    green: [{ x: 0, y: 10 }, { x: 180, y: 211 }, { x: 255, y: 220 }],
    blue: [{ x: 0, y: 10 }, { x: 80, y: 240 }, { x: 170, y: 5 }, { x: 255, y: 250 }],
  };
  const expected = new Uint8ClampedArray(image.data);
  for (let index = 0; index < image.data.length; index += 4) for (const [component, key] of ['red', 'green', 'blue'].entries()) {
    const storedTableByte = new Uint8ClampedArray([curveValue(settings[key], curveValue(settings.rgb, image.data[index + component]))])[0];
    expected[index + component] = 255 * boundForCurve(storedTableByte / 255);
  }
  assert.deepEqual(apply(image, 'curves', settings).data, expected);
});

const boundForCurve = (value) => Math.min(1, Math.max(0, value));
