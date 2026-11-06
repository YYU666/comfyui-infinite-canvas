import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BLEND_MODES, DEFAULT_ADJUSTMENTS, DEFAULT_BLEND_SETTINGS, HSL_CHANNELS, LEVEL_CHANNELS,
  DEFAULT_HSL_SETTINGS, DEFAULT_LEVELS_SETTINGS,
  normalizeAdjustments, normalizeBlendSettings, normalizeHslSettings, normalizeLevelsSettings,
  adjustImagePixels, blendImagePixels,
} from './src/image-compositing.js';

const pixel = (...values) => ({ width: values.length / 4, height: 1, data: new Uint8ClampedArray(values) });
const values = (image) => [...image.data];

test('default adjustments preserve all bytes, including hidden RGB, without sharing memory', () => {
  const source = pixel(1, 129, 254, 0, 35, 84, 201, 128);
  const result = adjustImagePixels(source);
  assert.deepEqual(values(result), values(source));
  assert.notEqual(result.data, source.data);
  result.data[0] = 23;
  assert.equal(source.data[0], 1);
  assert.deepEqual(DEFAULT_ADJUSTMENTS, { brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 1, temperature: 0 });
});

test('brightness, contrast, saturation, hue and gamma have meaningful known results', () => {
  assert.deepEqual(values(adjustImagePixels(pixel(100, 100, 100, 37), { brightness: 20 })), [151, 151, 151, 37]);
  assert.deepEqual(values(adjustImagePixels(pixel(10, 90, 240, 37), { contrast: -100 })), [128, 128, 128, 37]);
  assert.deepEqual(values(adjustImagePixels(pixel(255, 0, 0, 200), { saturation: -100 })), [54, 54, 54, 200]);
  assert.deepEqual(values(adjustImagePixels(pixel(255, 0, 0, 200), { hue: 120 })), [0, 255, 0, 200]);
  assert.deepEqual(values(adjustImagePixels(pixel(255, 0, 0, 200), { hue: -120 })), [0, 0, 255, 200]);
  assert.deepEqual(values(adjustImagePixels(pixel(64, 64, 64, 33), { gamma: 2 })), [128, 128, 128, 33]);
  assert.deepEqual(values(adjustImagePixels(pixel(128, 128, 128, 33), { temperature: 100 })), [179, 128, 77, 33]);
});

test('normalization clamps finite values and resets invalid values to safe defaults', () => {
  assert.deepEqual(normalizeAdjustments({ brightness: Infinity, contrast: -101, saturation: 200, hue: 400, gamma: 0, temperature: NaN }),
    { brightness: 0, contrast: -100, saturation: 100, hue: 180, gamma: 0.1, temperature: 0 });
  assert.deepEqual(normalizeBlendSettings({ mode: 'unknown', opacity: Infinity }), DEFAULT_BLEND_SETTINGS);
  assert.deepEqual(normalizeBlendSettings({ mode: 'multiply', opacity: -4 }), { ...DEFAULT_BLEND_SETTINGS, mode: 'multiply', opacity: 0 });
  assert.deepEqual(normalizeBlendSettings({ mode: 'screen', opacity: 120 }), { ...DEFAULT_BLEND_SETTINGS, mode: 'screen', opacity: 100 });
  assert.deepEqual(normalizeAdjustments(null), DEFAULT_ADJUSTMENTS);
});

test('blend modes match opaque source-over known values', () => {
  const base = pixel(64, 128, 192, 255);
  const source = pixel(128, 128, 128, 255);
  assert.deepEqual(values(blendImagePixels(base, source, { mode: 'multiply' })), [32, 64, 96, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, { mode: 'screen' })), [160, 192, 224, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, { mode: 'overlay' })), [64, 128, 192, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, { mode: 'difference' })), [64, 0, 64, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, { mode: 'add' })), [192, 255, 255, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, { mode: 'subtract' })), [0, 0, 64, 255]);
});

test('zero opacity returns base exactly and operations never mutate any input', () => {
  const base = pixel(14, 17, 97, 0);
  const source = pixel(230, 100, 10, 123);
  const mask = pixel(128, 128, 128, 128);
  const originals = [base, source, mask].map(values);
  const identity = blendImagePixels(base, source, { opacity: 0 });
  assert.deepEqual(values(identity), originals[0]);
  assert.notEqual(identity.data, base.data);
  blendImagePixels(base, source, { mode: 'soft-light' }, mask);
  adjustImagePixels(base, { brightness: 44 });
  assert.deepEqual([base, source, mask].map(values), originals);
});

test('transparent backdrop keeps source color, including in multiply mode', () => {
  assert.deepEqual(values(blendImagePixels(pixel(255, 0, 0, 0), pixel(10, 20, 230, 128), { mode: 'multiply' })), [10, 20, 230, 128]);
  assert.deepEqual(values(blendImagePixels(pixel(20, 30, 40, 70), pixel(200, 100, 50, 0))), [20, 30, 40, 70]);
});

test('partially transparent inputs and opacity use straight-alpha source-over', () => {
  assert.deepEqual(values(blendImagePixels(pixel(255, 0, 0, 128), pixel(0, 0, 255, 128))), [85, 0, 170, 192]);
  assert.deepEqual(values(blendImagePixels(pixel(255, 0, 0, 255), pixel(0, 0, 255, 255), { opacity: 50 })), [128, 0, 128, 255]);
  assert.deepEqual(values(blendImagePixels(pixel(255, 0, 0, 128), pixel(0, 0, 255, 128), { mode: 'multiply' })), [85, 0, 85, 192]);
});

test('mask luminance and alpha control coverage independently', () => {
  const base = pixel(0, 0, 0, 255);
  const source = pixel(255, 255, 255, 255);
  assert.deepEqual(values(blendImagePixels(base, source, {}, pixel(0, 0, 0, 255))), [0, 0, 0, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, {}, pixel(255, 255, 255, 255))), [255, 255, 255, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, {}, pixel(255, 255, 255, 128))), [128, 128, 128, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, {}, pixel(255, 255, 255, 0))), [0, 0, 0, 255]);
  assert.deepEqual(values(blendImagePixels(base, source, {}, pixel(255, 0, 0, 255))), [54, 54, 54, 255]);
});

test('all modes remain finite and within byte bounds at singular endpoints', () => {
  for (const { value } of BLEND_MODES) {
    for (const background of [0, 64, 255]) {
      for (const foreground of [0, 128, 255]) {
        const result = blendImagePixels(pixel(background, background, background, 255), pixel(foreground, foreground, foreground, 255), { mode: value });
        assert.equal(result.data[3], 255);
        assert.ok(values(result).every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255), value);
      }
    }
  }
  assert.deepEqual(values(blendImagePixels(pixel(0, 0, 0, 255), pixel(255, 255, 255, 255), { mode: 'color-dodge' })), [0, 0, 0, 255]);
  assert.deepEqual(values(blendImagePixels(pixel(255, 255, 255, 255), pixel(0, 0, 0, 255), { mode: 'color-burn' })), [255, 255, 255, 255]);
});

test('invalid buffers and dimensions fail instead of silently corrupting output', () => {
  const one = pixel(0, 0, 0, 255);
  assert.throws(() => adjustImagePixels({ width: 1, height: 2, data: one.data }), TypeError);
  assert.throws(() => blendImagePixels(one, pixel(0, 0, 0, 255, 0, 0, 0, 255)), RangeError);
  assert.throws(() => blendImagePixels(one, one, {}, pixel(0, 0, 0, 255, 0, 0, 0, 255)), RangeError);
  assert.throws(() => adjustImagePixels({ width: 0, height: 0, data: new Uint8ClampedArray() }), TypeError);
});

const hsl = (image, channels) => adjustImagePixels(image, { adjustmentType: 'hsl', hsl: channels });
const levels = (image, channels) => adjustImagePixels(image, { adjustmentType: 'levels', levels: channels });

test('HSL and Levels defaults contain all channels, normalize independently and preserve bytes', () => {
  assert.deepEqual(HSL_CHANNELS.map(({ value }) => value), ['master', 'red', 'yellow', 'green', 'cyan', 'blue', 'magenta']);
  assert.deepEqual(LEVEL_CHANNELS.map(({ value }) => value), ['rgb', 'red', 'green', 'blue']);
  assert.deepEqual(normalizeHslSettings(null), { adjustmentType: 'hsl', hsl: DEFAULT_HSL_SETTINGS });
  assert.deepEqual(normalizeLevelsSettings(null), { adjustmentType: 'levels', levels: DEFAULT_LEVELS_SETTINGS });
  const source = pixel(1, 254, 128, 0, 36, 35, 75, 103);
  for (const type of ['hsl', 'levels']) {
    const result = adjustImagePixels(source, { adjustmentType: type });
    assert.deepEqual(values(result), values(source));
    assert.notEqual(result.data, source.data);
  }
  const settings = { hsl: { red: { hue: Infinity, saturation: -120, lightness: 130 } } };
  const original = structuredClone(settings);
  const normalized = normalizeHslSettings(settings);
  assert.deepEqual(normalized.hsl.red, { hue: 0, saturation: -100, lightness: 100 });
  normalized.hsl.master.hue = 50;
  assert.equal(DEFAULT_HSL_SETTINGS.master.hue, 0);
  assert.deepEqual(settings, original);
});

test('true HSL controls lightness and saturation rather than HSV value or RGB luminance', () => {
  assert.deepEqual(values(hsl(pixel(255, 0, 0, 73), { master: { saturation: -100 } })), [128, 128, 128, 73]);
  assert.deepEqual(values(hsl(pixel(255, 0, 0, 73), { master: { lightness: 25 } })), [255, 128, 128, 73]);
  assert.deepEqual(values(hsl(pixel(128, 0, 0, 73), { master: { hue: 120 } })), [0, 128, 0, 73]);
  assert.deepEqual(values(hsl(pixel(255, 0, 0, 73), { master: { hue: -120 } })), [0, 0, 255, 73]);
});

test('targeted HSL protects grayscale and unaffected hues, using original hue membership', () => {
  const settings = { red: { hue: 120, saturation: -20, lightness: 10 } };
  const gray = pixel(100, 100, 100, 88);
  const blue = pixel(0, 0, 255, 99);
  assert.deepEqual(values(hsl(gray, settings)), values(gray));
  assert.deepEqual(values(hsl(blue, settings)), values(blue));
  assert.deepEqual(values(hsl(pixel(255, 0, 0, 37), { red: { hue: 120 } })), [0, 255, 0, 37]);
  // Red becomes green, but cannot then enter the green range in the same pass.
  assert.deepEqual(values(hsl(pixel(255, 0, 0, 37), { red: { hue: 120 }, green: { hue: 120 } })), [0, 255, 0, 37]);
  assert.deepEqual(values(hsl(pixel(255, 0, 0, 37), { red: { hue: 120 }, master: { hue: 120 } })), [0, 0, 255, 37]);
});

test('targeted HSL feathers continuously across hue boundaries and wraps red selection', () => {
  const settings = { red: { lightness: 20 } };
  const nearYellow = [pixel(255, 246, 0, 255), pixel(255, 250, 0, 255), pixel(255, 255, 0, 255), pixel(250, 255, 0, 255)];
  const output = nearYellow.map((image) => values(hsl(image, settings)));
  assert.ok(output[0][2] > output[1][2]);
  assert.ok(output[1][2] > output[2][2]);
  assert.equal(output[2][2], 0);
  assert.equal(output[3][2], 0);
  for (let index = 1; index < output.length; index += 1) {
    assert.ok(Math.max(...output[index].map((value, channel) => Math.abs(value - output[index - 1][channel]))) < 12);
  }
  const clockwise = hsl(pixel(255, 128, 0, 255), { red: { lightness: 20 } });
  const counterclockwise = hsl(pixel(255, 0, 128, 255), { red: { lightness: 20 } });
  assert.equal(clockwise.data[2], counterclockwise.data[1]);
  assert.ok(clockwise.data[2] > 0);
});

test('Levels clips inputs, applies gamma and maps output range with preserved alpha', () => {
  assert.deepEqual(values(levels(pixel(40, 128, 220, 73), { rgb: { inputBlack: 64, inputWhite: 192 } })), [0, 128, 255, 73]);
  assert.deepEqual(values(levels(pixel(64, 64, 64, 73), { rgb: { gamma: 2 } })), [128, 128, 128, 73]);
  assert.deepEqual(values(levels(pixel(0, 128, 255, 73), { rgb: { outputBlack: 20, outputWhite: 220 } })), [20, 120, 220, 73]);
  assert.deepEqual(values(levels(pixel(10, 120, 240, 73), { rgb: { outputBlack: 90, outputWhite: 90 } })), [90, 90, 90, 73]);
});

test('Levels applies master before per-channel maps and keeps other channels independent', () => {
  assert.deepEqual(values(levels(pixel(64, 64, 64, 101), { red: { gamma: 2 } })), [128, 64, 64, 101]);
  assert.deepEqual(values(levels(pixel(128, 128, 128, 101), {
    rgb: { inputBlack: 0, inputWhite: 128 }, red: { outputBlack: 0, outputWhite: 128 },
  })), [128, 255, 255, 101]);
  const source = pixel(34, 98, 145, 12);
  const settings = { rgb: { inputBlack: 50, inputWhite: 200 }, blue: { gamma: 1.5 } };
  const originals = [values(source), structuredClone(settings)];
  levels(source, settings);
  assert.deepEqual(values(source), originals[0]);
  assert.deepEqual(settings, originals[1]);
});

test('Levels normalization enforces valid ranges without modifying settings', () => {
  const settings = { levels: { rgb: { inputBlack: 300, inputWhite: -4, gamma: Infinity, outputBlack: 200, outputWhite: 20 }, red: { gamma: 0 } } };
  const original = structuredClone(settings);
  const normalized = normalizeLevelsSettings(settings);
  assert.deepEqual(normalized.levels.rgb, { inputBlack: 254, inputWhite: 255, gamma: 1, outputBlack: 200, outputWhite: 200 });
  assert.equal(normalized.levels.red.gamma, 0.1);
  assert.deepEqual(settings, original);
});

test('mask channel selection uses known RGB and alpha coverage', () => {
  const base = pixel(0, 0, 0, 255);
  const source = pixel(255, 255, 255, 255);
  const mask = pixel(255, 64, 0, 128);
  const expected = { red: 128, green: 32, blue: 0, alpha: 128, luminance: 50 };
  for (const [maskChannel, coverage] of Object.entries(expected)) {
    assert.deepEqual(values(blendImagePixels(base, source, { maskChannel }, mask)), [coverage, coverage, coverage, 255], maskChannel);
  }
});

test('inverting RGB/luminance respects mask transparency, while alpha inversion selects absence', () => {
  const base = pixel(0, 0, 0, 255);
  const source = pixel(255, 255, 255, 255);
  const mask = pixel(255, 64, 0, 128);
  const expected = { red: 0, green: 96, blue: 128, alpha: 127, luminance: 78 };
  for (const [maskChannel, coverage] of Object.entries(expected)) {
    assert.deepEqual(values(blendImagePixels(base, source, { maskChannel, maskInvert: true }, mask)), [coverage, coverage, coverage, 255], maskChannel);
  }
  const transparent = pixel(50, 100, 200, 0);
  assert.deepEqual(values(blendImagePixels(base, source, { maskChannel: 'red', maskInvert: true }, transparent)), values(base));
  assert.deepEqual(values(blendImagePixels(base, source, { maskChannel: 'alpha', maskInvert: true }, transparent)), values(source));
  assert.deepEqual(normalizeBlendSettings({ maskChannel: 'invalid', maskInvert: 'true' }), DEFAULT_BLEND_SETTINGS);
  assert.deepEqual(values(blendImagePixels(base, source, { maskInvert: true })), values(source));
});
