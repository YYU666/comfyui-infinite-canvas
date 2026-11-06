// Channel maps are raw data: RGB under transparent alpha is significant here.
export const CHANNEL_KEYS = Object.freeze(['red', 'green', 'blue', 'alpha']);
export const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 16384;
export const DEFAULT_CHANNEL_PACK = Object.freeze({
  channels: Object.freeze(Object.fromEntries(CHANNEL_KEYS.map((key) => [key, Object.freeze({
    source: 'luminance', value: key === 'alpha' ? 255 : 0, invert: false,
  })]))),
});

const sources = new Set(['luminance', ...CHANNEL_KEYS]);
const byte = (value, fallback) => Number.isFinite(value) ? Math.round(Math.min(255, Math.max(0, value))) : fallback;

export function normalizeChannelPackSettings(data = {}) {
  const settings = data?.packChannels || data?.channels || {};
  return {
    channels: Object.fromEntries(CHANNEL_KEYS.map((key) => {
      const channel = settings[key] || {};
      return [key, {
        source: sources.has(channel.source) ? channel.source : 'luminance',
        value: byte(channel.value, DEFAULT_CHANNEL_PACK.channels[key].value),
        invert: channel.invert === true,
      }];
    })),
  };
}

function validateImage(image, label) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width < 1 || image.height < 1 || !Number.isSafeInteger(image.width * image.height * 4)
    || !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
    || image.data.length !== image.width * image.height * 4) {
    throw new TypeError(`${label}必须是尺寸有效的 RGBA 字节图像。`);
  }
}

export function packImageChannels(inputs, settings = {}) {
  if (!inputs || typeof inputs !== 'object') throw new TypeError('请提供通道输入。');
  let reference;
  for (const key of CHANNEL_KEYS) {
    if (inputs[key] == null) continue;
    validateImage(inputs[key], `${key} 通道输入`);
    if (!reference) reference = inputs[key];
    else if (inputs[key].width !== reference.width || inputs[key].height !== reference.height) {
      throw new RangeError('通道输入尺寸必须一致，请先缩放。');
    }
  }
  if (!reference) throw new TypeError('至少连接一张通道输入图片。');
  const { channels } = normalizeChannelPackSettings(settings);
  const result = { width: reference.width, height: reference.height, data: new Uint8ClampedArray(reference.data.length) };
  for (const key of CHANNEL_KEYS) writePackedChannel(result, key, inputs[key], channels[key]);
  return result;
}

// Also used by the Worker to consume one source at a time, without retaining
// four native RGBA images until the final packing pass.
export function writePackedChannel(result, key, image, setting) {
  validateImage(result, '输出图像');
  const outputChannel = CHANNEL_KEYS.indexOf(key);
  if (outputChannel < 0) throw new TypeError('不支持的输出通道。');
  if (image != null) {
    validateImage(image, `${key} 通道输入`);
    if (image.width !== result.width || image.height !== result.height) throw new RangeError('通道输入尺寸必须一致，请先缩放。');
  }
  const selected = normalizeChannelPackSettings({ channels: { [key]: setting } }).channels[key];
  const sourceChannel = CHANNEL_KEYS.indexOf(selected.source);
  for (let offset = 0; offset < result.data.length; offset += 4) {
    const value = image == null ? selected.value : sourceChannel >= 0 ? image.data[offset + sourceChannel]
      : Math.round(0.2126 * image.data[offset] + 0.7152 * image.data[offset + 1] + 0.0722 * image.data[offset + 2]);
    result.data[offset + outputChannel] = selected.invert ? 255 - value : value;
  }
}

export function encodeTga(image) {
  validateImage(image, 'TGA 输入');
  if (image.width > 65535 || image.height > 65535) throw new RangeError('TGA 的宽高不能超过 65535 像素。');
  const result = new Uint8Array(18 + image.data.length);
  const header = new DataView(result.buffer);
  result[2] = 2; // Uncompressed true-color, no palette or image ID.
  header.setUint16(12, image.width, true);
  header.setUint16(14, image.height, true);
  result[16] = 32;
  result[17] = 0x28; // Top-left origin and eight attribute (alpha) bits.
  for (let offset = 0; offset < image.data.length; offset += 4) {
    result[18 + offset] = image.data[offset + 2];
    result[18 + offset + 1] = image.data[offset + 1];
    result[18 + offset + 2] = image.data[offset];
    result[18 + offset + 3] = image.data[offset + 3];
  }
  return result;
}

// Decode data maps directly; bitmap/Canvas decoding would premultiply and erase
// RGB data in pixels whose packed alpha channel happens to contain zero.
export function readTgaHeader(bytes) {
  if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray) || bytes.length < 18) {
    throw new TypeError('TGA 输入必须是包含完整文件头的字节数组。');
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[1] !== 0 || bytes[2] !== 2 || bytes[16] !== 32) {
    throw new TypeError('仅支持无调色板、未压缩的 32 位真彩色 TGA。');
  }
  const width = header.getUint16(12, true);
  const height = header.getUint16(14, true);
  if (!width || !height) throw new RangeError('TGA 的宽高必须大于零。');
  const descriptor = bytes[17];
  if ((descriptor & 0xc0) !== 0 || ![0, 8].includes(descriptor & 0x0f)) {
    throw new TypeError('不支持交错 TGA 或此 Alpha 位数。');
  }
  const pixelCount = width * height;
  const start = 18 + bytes[0]; // Optional image ID precedes the pixel payload.
  if (start + pixelCount * 4 > bytes.length) throw new RangeError('TGA 像素数据或图像标识不完整。');
  if (pixelCount > MAX_IMAGE_PIXELS) throw new RangeError('TGA 图像超过 33,554,432 像素的解码上限。');
  return { width, height, descriptor, start };
}

export function decodeTga(bytes, size = null) {
  const { width, height, descriptor, start } = readTgaHeader(bytes);
  const targetWidth = size?.width ?? width;
  const targetHeight = size?.height ?? height;
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth < 1 || targetHeight < 1
      || targetWidth * targetHeight > MAX_IMAGE_PIXELS) throw new RangeError('TGA 目标尺寸无效或超过解码上限。');
  const result = { width: targetWidth, height: targetHeight, data: new Uint8ClampedArray(targetWidth * targetHeight * 4) };
  const top = (descriptor & 0x20) !== 0;
  const right = (descriptor & 0x10) !== 0;
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / targetHeight));
    const row = top ? sourceY : height - sourceY - 1;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / targetWidth));
      const column = right ? width - sourceX - 1 : sourceX;
      const source = start + (row * width + column) * 4;
      const target = (y * targetWidth + x) * 4;
      result.data[target] = bytes[source + 2];
      result.data[target + 1] = bytes[source + 1];
      result.data[target + 2] = bytes[source];
      result.data[target + 3] = bytes[source + 3];
    }
  }
  return result;
}
