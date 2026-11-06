import { applyPhotoAdjustment, DEFAULT_PHOTO_SETTINGS } from './photo-adjustments.js';

// Local image operations use straight-alpha sRGB bytes, like Canvas ImageData.
export const DEFAULT_ADJUSTMENTS = Object.freeze({
  brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 1, temperature: 0,
});

export const HSL_CHANNELS = Object.freeze([
  { value: 'master', label: '全色' }, { value: 'red', label: '红色' },
  { value: 'yellow', label: '黄色' }, { value: 'green', label: '绿色' },
  { value: 'cyan', label: '青色' }, { value: 'blue', label: '蓝色' },
  { value: 'magenta', label: '洋红' },
].map(Object.freeze));

export const LEVEL_CHANNELS = Object.freeze([
  { value: 'rgb', label: 'RGB' }, { value: 'red', label: '红色' },
  { value: 'green', label: '绿色' }, { value: 'blue', label: '蓝色' },
].map(Object.freeze));

export const DEFAULT_HSL_SETTINGS = Object.freeze(Object.fromEntries(HSL_CHANNELS.map(({ value }) => [
  value, Object.freeze({ hue: 0, saturation: 0, lightness: 0 }),
])));
export const DEFAULT_LEVELS_SETTINGS = Object.freeze(Object.fromEntries(LEVEL_CHANNELS.map(({ value }) => [
  value, Object.freeze({ inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }),
])));

export const DEFAULT_BLEND_SETTINGS = Object.freeze({ mode: 'normal', opacity: 100, maskChannel: 'luminance', maskInvert: false });

export const BLEND_MODES = Object.freeze([
  { value: 'normal', label: '正常' },
  { value: 'multiply', label: '正片叠底' },
  { value: 'screen', label: '滤色' },
  { value: 'overlay', label: '叠加' },
  { value: 'soft-light', label: '柔光' },
  { value: 'hard-light', label: '强光' },
  { value: 'darken', label: '变暗' },
  { value: 'lighten', label: '变亮' },
  { value: 'color-dodge', label: '颜色减淡' },
  { value: 'color-burn', label: '颜色加深' },
  { value: 'difference', label: '差值' },
  { value: 'exclusion', label: '排除' },
  { value: 'add', label: '线性减淡（添加）' },
  { value: 'subtract', label: '减去' },
].map(Object.freeze));

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const setting = (value, fallback, low, high) => Number.isFinite(value) ? clamp(value, low, high) : fallback;
const modeNames = new Set(BLEND_MODES.map(({ value }) => value));
const maskChannelNames = new Set(['luminance', 'red', 'green', 'blue', 'alpha']);

export function normalizeAdjustments(settings = {}) {
  const value = settings || {};
  return {
    brightness: setting(value.brightness, 0, -100, 100),
    contrast: setting(value.contrast, 0, -100, 100),
    saturation: setting(value.saturation, 0, -100, 100),
    hue: setting(value.hue, 0, -180, 180),
    gamma: setting(value.gamma, 1, 0.1, 3),
    temperature: setting(value.temperature, 0, -100, 100),
  };
}

export function normalizeBlendSettings(settings = {}) {
  const value = settings || {};
  return {
    mode: modeNames.has(value.mode) ? value.mode : 'normal',
    opacity: setting(value.opacity, 100, 0, 100),
    maskChannel: maskChannelNames.has(value.maskChannel) ? value.maskChannel : 'luminance',
    maskInvert: value.maskInvert === true,
  };
}

export function normalizeHslSettings(settings = {}) {
  const source = settings?.hsl || {};
  return {
    adjustmentType: 'hsl',
    hsl: Object.fromEntries(HSL_CHANNELS.map(({ value }) => {
      const channel = source[value] || {};
      return [value, {
        hue: setting(channel.hue, 0, -180, 180),
        saturation: setting(channel.saturation, 0, -100, 100),
        lightness: setting(channel.lightness, 0, -100, 100),
      }];
    })),
  };
}

export function normalizeLevelsSettings(settings = {}) {
  const source = settings?.levels || {};
  return {
    adjustmentType: 'levels',
    levels: Object.fromEntries(LEVEL_CHANNELS.map(({ value }) => {
      const channel = source[value] || {};
      const inputBlack = setting(channel.inputBlack, 0, 0, 254);
      const outputBlack = setting(channel.outputBlack, 0, 0, 255);
      return [value, {
        inputBlack,
        inputWhite: Math.max(inputBlack + 1, setting(channel.inputWhite, 255, 1, 255)),
        gamma: setting(channel.gamma, 1, 0.1, 3),
        outputBlack,
        outputWhite: Math.max(outputBlack, setting(channel.outputWhite, 255, 0, 255)),
      }];
    })),
  };
}

function validateImage(image, label) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
      || image.width < 1 || image.height < 1 || !Number.isSafeInteger(image.width * image.height * 4)
      || !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
      || image.data.length !== image.width * image.height * 4) {
    throw new TypeError(`${label} 必须是尺寸有效的 RGBA 字节图像。`);
  }
}

function sameSize(base, image, label) {
  validateImage(image, label);
  if (base.width !== image.width || base.height !== image.height) {
    throw new RangeError(`${label} 尺寸必须与底图一致，请先缩放。`);
  }
}

export function adjustImagePixels(image, settings = {}) {
  validateImage(image, '输入图');
  if (Object.hasOwn(DEFAULT_PHOTO_SETTINGS, settings?.adjustmentType)) return applyPhotoAdjustment(image, settings);
  if (settings?.adjustmentType === 'hsl') return adjustHslPixels(image, normalizeHslSettings(settings).hsl);
  if (settings?.adjustmentType === 'levels') return adjustLevelsPixels(image, normalizeLevelsSettings(settings).levels);
  const options = normalizeAdjustments(settings);
  const result = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  if (Object.keys(DEFAULT_ADJUSTMENTS).every((key) => options[key] === DEFAULT_ADJUSTMENTS[key])) return result;
  const brightness = options.brightness / 100;
  const contrast = (1 + options.contrast / 100) / Math.max(0.001, 1 - options.contrast / 100);
  const saturation = 1 + options.saturation / 100;
  const temperature = options.temperature / 100 * 0.2;
  const gamma = 1 / options.gamma;
  const adjustChannel = (channel, luminance) => {
    const saturated = luminance + (channel - luminance) * saturation;
    const adjusted = clamp((saturated - 0.5) * contrast + 0.5 + brightness);
    return 255 * (gamma === 1 ? adjusted : adjusted ** gamma);
  };
  for (let index = 0; index < image.data.length; index += 4) {
    let red = clamp(image.data[index] / 255 + temperature);
    let green = image.data[index + 1] / 255;
    let blue = clamp(image.data[index + 2] / 255 - temperature);
    if (options.hue) {
      // Rotate HSV hue, retaining saturation/value without per-pixel allocations.
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const chroma = maximum - minimum;
      if (chroma) {
        let hue = maximum === red ? (green - blue) / chroma
          : maximum === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
        hue = ((hue + options.hue / 60) % 6 + 6) % 6;
        const middle = chroma * (1 - Math.abs(hue % 2 - 1));
        red = minimum + (hue < 1 || hue >= 5 ? chroma : hue < 2 ? middle : hue < 4 ? 0 : middle);
        green = minimum + (hue < 1 ? middle : hue < 3 ? chroma : hue < 4 ? middle : 0);
        blue = minimum + (hue < 2 ? 0 : hue < 3 ? middle : hue < 5 ? chroma : middle);
      }
    }
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    result.data[index] = adjustChannel(red, luminance);
    result.data[index + 1] = adjustChannel(green, luminance);
    result.data[index + 2] = adjustChannel(blue, luminance);
  }
  return result;
}

function adjustHslPixels(image, channels) {
  const result = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const master = channels.master;
  const targets = HSL_CHANNELS.slice(1).map(({ value }, index) => ({ ...channels[value], center: index * 60 }))
    .filter((channel) => channel.hue || channel.saturation || channel.lightness);
  if (!targets.length && !master.hue && !master.saturation && !master.lightness) return result;
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index] / 255;
    const green = image.data[index + 1] / 255;
    const blue = image.data[index + 2] / 255;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const chroma = maximum - minimum;
    let lightness = (maximum + minimum) / 2;
    let saturation = chroma ? chroma / (1 - Math.abs(2 * lightness - 1)) : 0;
    let hue = chroma ? (maximum === red ? (green - blue) / chroma
      : maximum === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4) * 60 : 0;
    hue = (hue + 360) % 360;
    let targetHue = 0;
    let targetSaturation = 0;
    let targetLightness = 0;
    // Weights use the original hue, never the already-adjusted hue. Grays have no
    // chromatic range membership. Adjacent triangular ranges feather over 60°.
    if (chroma) for (const target of targets) {
      const distance = Math.abs(hue - target.center);
      const weight = Math.max(0, 1 - Math.min(distance, 360 - distance) / 60);
      targetHue += weight * target.hue;
      targetSaturation += weight * target.saturation;
      targetLightness += weight * target.lightness;
    }
    if (!targetHue && !targetSaturation && !targetLightness && !master.hue && !master.saturation && !master.lightness) continue;
    // Targeted edits first, then master: H += ΔH, S *= 1 + ΔS/100,
    // L += ΔL/100. Clamp S/L after each stage; wrap H to [0, 360).
    saturation = clamp(clamp(saturation * (1 + targetSaturation / 100)) * (1 + master.saturation / 100));
    lightness = clamp(clamp(lightness + targetLightness / 100) + master.lightness / 100);
    hue = ((hue + targetHue + master.hue) % 360 + 360) % 360 / 60;
    const outputChroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const middle = outputChroma * (1 - Math.abs(hue % 2 - 1));
    const offset = lightness - outputChroma / 2;
    result.data[index] = 255 * (offset + (hue < 1 || hue >= 5 ? outputChroma : hue < 2 ? middle : hue < 4 ? 0 : middle));
    result.data[index + 1] = 255 * (offset + (hue < 1 ? middle : hue < 3 ? outputChroma : hue < 4 ? middle : 0));
    result.data[index + 2] = 255 * (offset + (hue < 2 ? 0 : hue < 3 ? middle : hue < 5 ? outputChroma : middle));
  }
  return result;
}

function adjustLevelsPixels(image, channels) {
  const result = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const identity = (channel) => channel.inputBlack === 0 && channel.inputWhite === 255
    && channel.gamma === 1 && channel.outputBlack === 0 && channel.outputWhite === 255;
  if (LEVEL_CHANNELS.every(({ value }) => identity(channels[value]))) return result;
  const map = (value, channel) => {
    const input = clamp((value - channel.inputBlack) / (channel.inputWhite - channel.inputBlack));
    return channel.outputBlack + (channel.outputWhite - channel.outputBlack) * input ** (1 / channel.gamma);
  };
  const tables = ['red', 'green', 'blue'].map((key) => Uint8ClampedArray.from(
    { length: 256 }, (_, value) => map(map(value, channels.rgb), channels[key]),
  ));
  for (let index = 0; index < image.data.length; index += 4) {
    result.data[index] = tables[0][image.data[index]];
    result.data[index + 1] = tables[1][image.data[index + 1]];
    result.data[index + 2] = tables[2][image.data[index + 2]];
  }
  return result;
}

function blendChannel(base, source, mode) {
  switch (mode) {
    case 'multiply': return base * source;
    case 'screen': return base + source - base * source;
    case 'overlay': return base <= 0.5 ? 2 * base * source : 1 - 2 * (1 - base) * (1 - source);
    case 'hard-light': return source <= 0.5 ? 2 * base * source : 1 - 2 * (1 - base) * (1 - source);
    case 'soft-light': {
      if (source <= 0.5) return base - (1 - 2 * source) * base * (1 - base);
      const curve = base <= 0.25 ? ((16 * base - 12) * base + 4) * base : Math.sqrt(base);
      return base + (2 * source - 1) * (curve - base);
    }
    case 'darken': return Math.min(base, source);
    case 'lighten': return Math.max(base, source);
    case 'color-dodge': return base === 0 ? 0 : source === 1 ? 1 : Math.min(1, base / (1 - source));
    case 'color-burn': return base === 1 ? 1 : source === 0 ? 0 : 1 - Math.min(1, (1 - base) / source);
    case 'difference': return Math.abs(base - source);
    case 'exclusion': return base + source - 2 * base * source;
    case 'add': return Math.min(1, base + source);
    case 'subtract': return Math.max(0, base - source);
    default: return source;
  }
}

export function blendImagePixels(base, overlay, settings = {}, mask = null) {
  validateImage(base, '底图');
  sameSize(base, overlay, '叠加图');
  if (mask != null) sameSize(base, mask, '遮罩');
  const { mode, opacity, maskChannel, maskInvert } = normalizeBlendSettings(settings);
  const result = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
  if (opacity === 0) return result;
  for (let index = 0; index < base.data.length; index += 4) {
    let maskCoverage = 1;
    if (mask != null) {
      const maskAlpha = mask.data[index + 3] / 255;
      const selected = maskChannel === 'alpha' ? maskAlpha
        : maskChannel === 'red' ? mask.data[index] / 255
          : maskChannel === 'green' ? mask.data[index + 1] / 255
            : maskChannel === 'blue' ? mask.data[index + 2] / 255
              : (0.2126 * mask.data[index] + 0.7152 * mask.data[index + 1] + 0.0722 * mask.data[index + 2]) / 255;
      maskCoverage = (maskInvert ? 1 - selected : selected) * (maskChannel === 'alpha' ? 1 : maskAlpha);
    }
    const sourceAlpha = overlay.data[index + 3] / 255 * opacity / 100 * maskCoverage;
    if (sourceAlpha === 0) continue;
    const baseAlpha = base.data[index + 3] / 255;
    const alpha = sourceAlpha + baseAlpha * (1 - sourceAlpha);
    for (let channel = 0; channel < 3; channel += 1) {
      const background = base.data[index + channel] / 255;
      const source = overlay.data[index + channel] / 255;
      // Source-over compositing with separable blending (straight-alpha inputs).
      const premultiplied = sourceAlpha * (1 - baseAlpha) * source
        + sourceAlpha * baseAlpha * blendChannel(background, source, mode)
        + (1 - sourceAlpha) * baseAlpha * background;
      result.data[index + channel] = 255 * clamp(premultiplied / alpha);
    }
    result.data[index + 3] = alpha * 255;
  }
  return result;
}
