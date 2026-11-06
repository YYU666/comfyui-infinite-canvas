// Local, straight-alpha sRGB adjustments. These are documented photo-editing
// formulas, not a claim of pixel equivalence to a proprietary application's tools.
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const finite = (value, fallback, min, max) => Number.isFinite(value) ? clamp(value, min, max) : fallback;
const color = (value, fallback) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
const triplet = (value) => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
const range = (key, label, min, max, step = 1) => ({ key, label, type: 'range', min, max, step });
const checkbox = (key, label) => ({ key, label, type: 'checkbox' });
const rgbNames = ['red', 'green', 'blue'];
const tones = ['shadows', 'midtones', 'highlights'];
const colorRanges = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export const PHOTO_ADJUSTMENTS = freeze([
  { value: 'basic', label: '基础调整', group: '色调与颜色' },
  { value: 'hsl', label: '色相 / 饱和度', group: '色调与颜色' },
  { value: 'levels', label: '色阶', group: '色调与颜色' },
  { value: 'exposure', label: '曝光度', group: '色调与颜色' },
  { value: 'whiteBalance', label: '白平衡', group: '色调与颜色' },
  { value: 'vibrance', label: '自然饱和度', group: '色调与颜色' },
  { value: 'curves', label: '曲线', group: '色调与颜色' },
  { value: 'shadowsHighlights', label: '阴影 / 高光', group: '色调与颜色' },
  { value: 'colorBalance', label: '色彩平衡', group: '色彩混合' },
  { value: 'selectiveColor', label: '可选颜色', group: '色彩混合' },
  { value: 'blackWhite', label: '黑白', group: '色彩混合' },
  { value: 'photoFilter', label: '照片滤镜', group: '色彩混合' },
  { value: 'channelMixer', label: '通道混合器', group: '色彩混合' },
  { value: 'gradientMap', label: '渐变映射', group: '风格化' },
  { value: 'invert', label: '反相', group: '风格化' },
  { value: 'threshold', label: '阈值', group: '风格化' },
  { value: 'posterize', label: '色调分离', group: '风格化' },
]);

export const DEFAULT_PHOTO_SETTINGS = freeze({
  exposure: { exposure: 0, offset: 0, gamma: 1 },
  whiteBalance: { temperature: 0, tint: 0 },
  vibrance: { vibrance: 0, saturation: 0 },
  curves: Object.fromEntries(['rgb', ...rgbNames].map((key) => [key, [{ x: 0, y: 0 }, { x: 255, y: 255 }]])),
  shadowsHighlights: { shadows: 0, highlights: 0, contrast: 0 },
  colorBalance: { ...Object.fromEntries(tones.map((key) => [key, { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }])), preserveLuminosity: true },
  selectiveColor: { ...Object.fromEntries(colorRanges.map((key) => [key, { cyan: 0, magenta: 0, yellow: 0, black: 0 }])), method: 'relative' },
  blackWhite: { red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80 },
  photoFilter: { color: '#ec8a2e', density: 25, preserveLuminosity: true },
  channelMixer: { ...Object.fromEntries(rgbNames.map((key) => [key, { ...Object.fromEntries(rgbNames.map((source) => [source, key === source ? 100 : 0])), constant: 0 }])), monochrome: false },
  gradientMap: { dark: '#000000', light: '#ffffff', reverse: false, amount: 100 },
  invert: {}, threshold: { level: 128 }, posterize: { levels: 4 },
});

export const PHOTO_CONTROL_SCHEMAS = freeze({
  exposure: [range('exposure', '曝光（EV）', -5, 5, 0.01), range('offset', '位移', -0.5, 0.5, 0.001), range('gamma', '伽马', 0.1, 3, 0.01)],
  whiteBalance: [range('temperature', '色温', -100, 100), range('tint', '色调', -100, 100)],
  vibrance: [range('vibrance', '自然饱和度', -100, 100), range('saturation', '饱和度', -100, 100)],
  shadowsHighlights: [range('shadows', '阴影', 0, 100), range('highlights', '高光', 0, 100), range('contrast', '中间调对比度', -100, 100)],
  blackWhite: ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'].map((key, index) => range(key, ['红色', '黄色', '绿色', '青色', '蓝色', '洋红'][index], -100, 300)),
  photoFilter: [{ key: 'color', label: '滤镜颜色', type: 'color' }, range('density', '浓度', 0, 100), checkbox('preserveLuminosity', '保留明度')],
  channelMixer: [checkbox('monochrome', '单色（使用红色输出通道）')],
  gradientMap: [{ key: 'dark', label: '暗部颜色', type: 'color' }, { key: 'light', label: '亮部颜色', type: 'color' }, checkbox('reverse', '反向'), range('amount', '强度', 0, 100)],
  threshold: [range('level', '阈值', 0, 255)], posterize: [range('levels', '色阶数', 2, 256)],
  invert: [],
});

const newModes = new Set(Object.keys(DEFAULT_PHOTO_SETTINGS));
const identityPoints = () => [{ x: 0, y: 0 }, { x: 255, y: 255 }];

export function normalizeCurvePoints(points) {
  if (!Array.isArray(points)) return identityPoints();
  const sorted = points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map((point) => ({ x: clamp(point.x, 0, 255), y: clamp(point.y, 0, 255) })).sort((a, b) => a.x - b.x);
  if (!sorted.length) return identityPoints();
  const start = sorted.find((point) => point.x === 0) || { x: 0, y: 0 };
  const end = sorted.findLast((point) => point.x === 255) || { x: 255, y: 255 };
  const interior = [];
  for (const point of sorted) if (point.x >= 1 && point.x <= 254 && (!interior.length || point.x - interior.at(-1).x >= 1)) interior.push(point);
  const retained = interior.length <= 14 ? interior : Array.from({ length: 14 }, (_, index) => interior[Math.round(index * (interior.length - 1) / 13)]);
  return [{ ...start }, ...retained, { ...end }];
}

// Piecewise cubic Hermite slopes (PCHIP): flatten local extrema and constrain
// endpoint derivatives so non-monotone editing cannot overshoot each segment.
function curveSampler(points) {
  const count = points.length;
  const spans = Array.from({ length: count - 1 }, (_, index) => points[index + 1].x - points[index].x);
  const slopes = spans.map((span, index) => (points[index + 1].y - points[index].y) / span);
  const derivatives = new Array(count).fill(0);
  if (count === 2) derivatives.fill(slopes[0]);
  else {
    const endpoint = (first, second, span, nextSpan) => {
      const value = ((2 * span + nextSpan) * first - span * second) / (span + nextSpan);
      if (Math.sign(value) !== Math.sign(first)) return 0;
      return Math.sign(first) !== Math.sign(second) && Math.abs(value) > 3 * Math.abs(first) ? 3 * first : value;
    };
    derivatives[0] = endpoint(slopes[0], slopes[1], spans[0], spans[1]);
    derivatives[count - 1] = endpoint(slopes.at(-1), slopes.at(-2), spans.at(-1), spans.at(-2));
    for (let index = 1; index < count - 1; index += 1) {
      if (slopes[index - 1] * slopes[index] <= 0) continue;
      const first = 2 * spans[index] + spans[index - 1];
      const second = spans[index] + 2 * spans[index - 1];
      derivatives[index] = (first + second) / (first / slopes[index - 1] + second / slopes[index]);
    }
  }
  return (input) => {
    const x = finite(input, 0, 0, 255);
    let index = 0;
    while (index < count - 2 && x > points[index + 1].x) index += 1;
    const t = clamp((x - points[index].x) / spans[index]);
    const t2 = t * t; const t3 = t2 * t;
    return clamp((2 * t3 - 3 * t2 + 1) * points[index].y + (t3 - 2 * t2 + t) * spans[index] * derivatives[index]
      + (-2 * t3 + 3 * t2) * points[index + 1].y + (t3 - t2) * spans[index] * derivatives[index + 1], 0, 255);
  };
}

export function curveValue(points, x) { return curveSampler(normalizeCurvePoints(points))(x); }

export function normalizePhotoAdjustment(data = {}) {
  const adjustmentType = newModes.has(data?.adjustmentType) ? data.adjustmentType : 'basic';
  if (adjustmentType === 'basic' || adjustmentType === 'invert') return { adjustmentType };
  const defaults = DEFAULT_PHOTO_SETTINGS[adjustmentType];
  const source = data?.[adjustmentType] || {};
  const value = (key, min, max) => finite(source[key], defaults[key], min, max);
  let settings;
  switch (adjustmentType) {
    case 'exposure': settings = { exposure: value('exposure', -5, 5), offset: value('offset', -0.5, 0.5), gamma: value('gamma', 0.1, 3) }; break;
    case 'whiteBalance': settings = { temperature: value('temperature', -100, 100), tint: value('tint', -100, 100) }; break;
    case 'vibrance': settings = { vibrance: value('vibrance', -100, 100), saturation: value('saturation', -100, 100) }; break;
    case 'curves': settings = Object.fromEntries(['rgb', ...rgbNames].map((key) => [key, normalizeCurvePoints(source[key])])); break;
    case 'shadowsHighlights': settings = { shadows: value('shadows', 0, 100), highlights: value('highlights', 0, 100), contrast: value('contrast', -100, 100) }; break;
    case 'colorBalance': settings = { ...Object.fromEntries(tones.map((tone) => [tone, Object.fromEntries(['cyanRed', 'magentaGreen', 'yellowBlue'].map((key) => [key, finite(source[tone]?.[key], 0, -100, 100)]))])), preserveLuminosity: source.preserveLuminosity !== false }; break;
    case 'selectiveColor': settings = { ...Object.fromEntries(colorRanges.map((tone) => [tone, Object.fromEntries(['cyan', 'magenta', 'yellow', 'black'].map((key) => [key, finite(source[tone]?.[key], 0, -100, 100)]))])), method: source.method === 'absolute' ? 'absolute' : 'relative' }; break;
    case 'blackWhite': settings = Object.fromEntries(Object.keys(defaults).map((key) => [key, value(key, -100, 300)])); break;
    case 'photoFilter': settings = { color: color(source.color, defaults.color), density: value('density', 0, 100), preserveLuminosity: source.preserveLuminosity !== false }; break;
    case 'channelMixer': settings = { ...Object.fromEntries(rgbNames.map((output) => [output, { ...Object.fromEntries(rgbNames.map((key) => [key, finite(source[output]?.[key], defaults[output][key], -200, 200)])), constant: finite(source[output]?.constant, 0, -100, 100) }])), monochrome: source.monochrome === true }; break;
    case 'gradientMap': settings = { dark: color(source.dark, defaults.dark), light: color(source.light, defaults.light), reverse: source.reverse === true, amount: value('amount', 0, 100) }; break;
    case 'threshold': settings = { level: Math.round(value('level', 0, 255)) }; break;
    case 'posterize': settings = { levels: Math.round(value('levels', 2, 256)) }; break;
    default: settings = {};
  }
  return { adjustmentType, [adjustmentType]: settings };
}

const luminance = (red, green, blue) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;
function preserveLuminosity(red, green, blue, target) {
  const change = target - luminance(red, green, blue);
  red += change; green += change; blue += change;
  const min = Math.min(red, green, blue); const max = Math.max(red, green, blue);
  if (min < 0) {
    const scale = target / (target - min);
    red = target + (red - target) * scale; green = target + (green - target) * scale; blue = target + (blue - target) * scale;
  }
  if (max > 1) {
    const updatedMax = Math.max(red, green, blue);
    const scale = updatedMax > 1 ? (1 - target) / (updatedMax - target) : 1;
    red = target + (red - target) * scale; green = target + (green - target) * scale; blue = target + (blue - target) * scale;
  }
  return [clamp(red), clamp(green), clamp(blue)];
}

function hueWeights(red, green, blue) {
  const max = Math.max(red, green, blue); const min = Math.min(red, green, blue); const chroma = max - min;
  let hue = !chroma ? 0 : max === red ? (green - blue) / chroma : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  hue = ((hue % 6) + 6) % 6;
  const weights = new Array(6).fill(0);
  weights[Math.floor(hue)] = 1 - hue % 1;
  weights[(Math.floor(hue) + 1) % 6] = hue % 1;
  return { weights, min, max, chroma };
}

export function applyPhotoAdjustment(image, data = {}) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
    || !Number.isSafeInteger(image.width * image.height * 4) || !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
    || image.data.length !== image.width * image.height * 4) throw new TypeError('输入图必须是尺寸有效的 RGBA 字节图像。');
  const normalized = normalizePhotoAdjustment(data);
  const mode = normalized.adjustmentType;
  const settings = normalized[mode];
  const result = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  if (!newModes.has(mode)) return result;
  const neutral = ['exposure', 'whiteBalance', 'vibrance', 'curves', 'shadowsHighlights', 'colorBalance', 'selectiveColor', 'channelMixer'];
  if (neutral.includes(mode) && JSON.stringify(settings) === JSON.stringify(DEFAULT_PHOTO_SETTINGS[mode])) return result;
  if ((mode === 'photoFilter' && settings.density === 0) || (mode === 'gradientMap' && settings.amount === 0) || (mode === 'posterize' && settings.levels === 256)) return result;
  let tables;
  if (mode === 'curves') {
    const master = curveSampler(settings.rgb);
    tables = rgbNames.map((key) => {
      const channel = curveSampler(settings[key]);
      return Uint8ClampedArray.from({ length: 256 }, (_, value) => channel(master(value)));
    });
  } else if (['exposure', 'whiteBalance', 'invert', 'posterize'].includes(mode)) {
    // These operations depend on one input byte at a time. Evaluate their exact
    // scalar formulas once per byte value, rather than per full-resolution pixel.
    const tableFor = (component) => Uint8ClampedArray.from({ length: 256 }, (_, value) => {
      const channel = value / 255;
      let output;
      if (mode === 'exposure') output = clamp(channel * 2 ** settings.exposure + settings.offset) ** (1 / settings.gamma);
      else if (mode === 'whiteBalance') output = component === 0 ? channel + settings.temperature * 0.002 + settings.tint * 0.00075
        : component === 1 ? channel - settings.tint * 0.0015 : channel - settings.temperature * 0.002 + settings.tint * 0.00075;
      else if (mode === 'invert') output = 1 - channel;
      else output = Math.round(channel * (settings.levels - 1)) / (settings.levels - 1);
      return 255 * clamp(output);
    });
    const first = tableFor(0);
    tables = mode === 'whiteBalance' ? [first, tableFor(1), tableFor(2)] : [first, first, first];
  }
  if (tables) {
    const [red, green, blue] = tables;
    for (let index = 0; index < image.data.length; index += 4) {
      result.data[index] = red[image.data[index]];
      result.data[index + 1] = green[image.data[index + 1]];
      result.data[index + 2] = blue[image.data[index + 2]];
    }
    return result;
  }
  const filter = mode === 'photoFilter' ? triplet(settings.color) : null;
  const dark = mode === 'gradientMap' ? triplet(settings.dark) : null;
  const light = mode === 'gradientMap' ? triplet(settings.light) : null;
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index] / 255; const green = image.data[index + 1] / 255; const blue = image.data[index + 2] / 255;
    const originalLum = luminance(red, green, blue);
    let output = [red, green, blue];
    switch (mode) {
      case 'vibrance': {
        const max = Math.max(red, green, blue); const min = Math.min(red, green, blue);
        const adaptive = 1 + settings.vibrance / 100 * (1 - (max - min));
        const saturation = (1 + settings.saturation / 100) * adaptive;
        output = output.map((channel) => originalLum + (channel - originalLum) * saturation); break;
      }
      case 'shadowsHighlights': {
        const shadows = (1 - originalLum) ** 2 * settings.shadows / 100;
        const highlights = originalLum ** 2 * settings.highlights / 100;
        const factor = (1 + settings.contrast / 100) / Math.max(0.001, 1 - settings.contrast / 100);
        output = output.map((channel) => ((channel + shadows * (1 - channel) - highlights * channel) - 0.5) * factor + 0.5); break;
      }
      case 'colorBalance': {
        const shadow = Math.max(0, 1 - 2 * originalLum); const highlight = Math.max(0, 2 * originalLum - 1);
        const weights = [shadow, 1 - shadow - highlight, highlight];
        output = output.map((channel, component) => channel + tones.reduce((sum, tone, toneIndex) => sum + settings[tone][['cyanRed', 'magentaGreen', 'yellowBlue'][component]] * weights[toneIndex] * 0.005, 0));
        if (settings.preserveLuminosity) output = preserveLuminosity(...output, originalLum); break;
      }
      case 'selectiveColor': {
        const membership = hueWeights(red, green, blue);
        const saturation = membership.max ? membership.chroma / membership.max : 0;
        const white = Math.max(0, 2 * membership.min - 1); const black = Math.max(0, 1 - 2 * membership.max);
        const weights = [...membership.weights.map((weight) => weight * saturation), white, Math.max(0, 1 - white - black) * (1 - saturation), black];
        const blackDensity = colorRanges.reduce((sum, key, rangeIndex) => sum + weights[rangeIndex] * settings[key].black / 100, 0);
        output = output.map((channel, component) => {
          const ink = colorRanges.reduce((sum, key, rangeIndex) => sum + weights[rangeIndex] * settings[key][['cyan', 'magenta', 'yellow'][component]] / 100, 0);
          // Relative CMY scales existing complementary ink (1 - RGB), so
          // removing magenta from red can raise green even when green is zero.
          // Black is a separate density control, scaling the resulting RGB in
          // relative mode, rather than being conflated with each CMY amount.
          const afterCmy = clamp(channel - ink * (settings.method === 'relative' ? 1 - channel : 1));
          return settings.method === 'relative' ? afterCmy * (1 - blackDensity) : afterCmy - blackDensity;
        }); break;
      }
      case 'blackWhite': {
        const { weights, min, chroma } = hueWeights(red, green, blue);
        const keys = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];
        const value = min + chroma * weights.reduce((sum, weight, channel) => sum + weight * settings[keys[channel]] / 100, 0);
        output = [value, value, value]; break;
      }
      case 'photoFilter': {
        const density = settings.density / 100;
        output = output.map((channel, component) => channel * (1 - density) + filter[component] * density);
        if (settings.preserveLuminosity) output = preserveLuminosity(...output, originalLum); break;
      }
      case 'channelMixer': {
        output = rgbNames.map((key) => (red * settings[key].red + green * settings[key].green + blue * settings[key].blue + settings[key].constant) / 100);
        if (settings.monochrome) output = [output[0], output[0], output[0]]; break;
      }
      case 'gradientMap': {
        const position = settings.reverse ? 1 - originalLum : originalLum;
        const amount = settings.amount / 100;
        output = output.map((channel, component) => channel * (1 - amount) + (dark[component] + (light[component] - dark[component]) * position) * amount); break;
      }
      case 'threshold': { const value = originalLum * 255 >= settings.level ? 1 : 0; output = [value, value, value]; break; }
      default: break;
    }
    result.data[index] = 255 * clamp(output[0]);
    result.data[index + 1] = 255 * clamp(output[1]);
    result.data[index + 2] = 255 * clamp(output[2]);
  }
  return result;
}
