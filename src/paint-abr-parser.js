import { scaleStamp } from './paint-engine.js';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_SAMPLES = 256;
const MAX_EDGE = 8192;
const MAX_PIXELS = MAX_EDGE * MAX_EDGE;
const MAX_V1_COUNT = 512;

class AbrError extends Error {}

class Cursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  remaining() { return this.bytes.length - this.offset; }

  need(size) {
    if (size < 0 || this.offset + size > this.bytes.length) throw new AbrError('笔刷文件已损坏或不完整。');
  }

  u8() { this.need(1); const value = this.bytes[this.offset]; this.offset += 1; return value; }
  u16() { this.need(2); const value = this.view.getUint16(this.offset); this.offset += 2; return value; }
  i16() { this.need(2); const value = this.view.getInt16(this.offset); this.offset += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.offset); this.offset += 4; return value; }
  i32() { this.need(4); const value = this.view.getInt32(this.offset); this.offset += 4; return value; }

  bytesOf(size) {
    this.need(size);
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  ascii(size) { return String.fromCharCode(...this.bytesOf(size)); }
  skip(size) { this.need(size); this.offset += size; }
}

function fail(error) {
  return { ok: false, stamps: [], warnings: [], error, message: error };
}

function validEdge(width, height, depth) {
  return depth === 8 && width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE && width * height <= MAX_PIXELS;
}

function unpackBits(packed, expected) {
  const out = new Uint8Array(expected);
  let src = 0;
  let dst = 0;
  let steps = 0;
  while (dst < expected) {
    if (src >= packed.length || steps > expected + packed.length + 2) throw new AbrError('笔刷文件已损坏或不完整。');
    steps += 1;
    const control = packed[src] << 24 >> 24;
    src += 1;
    if (control >= 0) {
      const count = control + 1;
      if (dst + count > expected || src + count > packed.length) throw new AbrError('笔刷文件已损坏或不完整。');
      out.set(packed.subarray(src, src + count), dst);
      src += count;
      dst += count;
    } else if (control !== -128) {
      const count = 1 - control;
      if (src >= packed.length || dst + count > expected) throw new AbrError('笔刷文件已损坏或不完整。');
      out.fill(packed[src], dst, dst + count);
      src += 1;
      dst += count;
    }
  }
  return out;
}

function readPixels(cursor, width, height, compression, rowBytes, end) {
  const count = width * height;
  if (count > MAX_PIXELS) throw new AbrError('笔尖尺寸超出安全范围。');
  if (compression === 0) {
    if (cursor.offset + count > end) throw new AbrError('笔刷文件已损坏或不完整。');
    return new Uint8Array(cursor.bytesOf(count));
  }
  if (compression !== 1) throw new AbrError('不支持的笔尖压缩方式。');
  const alpha = new Uint8Array(count);
  for (let y = 0; y < height; y += 1) {
    const rowSize = rowBytes === 4 ? cursor.u32() : cursor.u16();
    if (rowSize > width * 2 + 64 || cursor.offset + rowSize > end) throw new AbrError('笔刷文件已损坏或不完整。');
    alpha.set(unpackBits(cursor.bytesOf(rowSize), width), y * width);
  }
  return alpha;
}

function namedStamp(name, width, height, alpha) {
  const scaled = scaleStamp({ width, height, alpha }, 512);
  return { name, width: scaled.width, height: scaled.height, alpha: scaled.alpha };
}

function readLegacySample(cursor, version, end, index) {
  cursor.u32();
  cursor.u16();
  cursor.u32();
  const top = cursor.i16();
  const left = cursor.i16();
  const bottom = cursor.i16();
  const right = cursor.i16();
  const depth = cursor.u16();
  const compression = cursor.u8();
  const width = Math.abs(right - left);
  const height = Math.abs(bottom - top);
  if (!validEdge(width, height, depth)) throw new AbrError('笔尖尺寸超出安全范围。');
  const alpha = readPixels(cursor, width, height, compression, 2, end);
  let name = `笔尖 ${index}`;
  if (version === 2 && cursor.offset < end) {
    const length = cursor.u8();
    if (length > 0 && cursor.offset + length <= end) {
      const decoded = new TextDecoder('latin1').decode(cursor.bytesOf(length)).replace(/\0/g, '').trim();
      if (decoded) name = decoded.slice(0, 80);
    }
  }
  return namedStamp(name, width, height, alpha);
}

function parseLegacy(cursor, version) {
  const count = cursor.u16();
  if (count > MAX_V1_COUNT) throw new AbrError('笔刷数量超出安全上限。');
  const stamps = [];
  const warnings = [];
  for (let index = 0; index < count; index += 1) {
    const type = cursor.u16();
    const size = cursor.u32();
    if (size > cursor.remaining()) throw new AbrError('笔刷文件已损坏或不完整。');
    const end = cursor.offset + size;
    if (type === 2) {
      stamps.push(readLegacySample(cursor, version, end, stamps.length + 1));
      if (stamps.length > MAX_SAMPLES) throw new AbrError('笔尖样本数量超出安全上限。');
    } else warnings.push('已跳过计算型笔刷。');
    cursor.offset = end;
  }
  return { stamps, warnings };
}

function readModernSample(cursor, version, itemEnd, index) {
  const mark = cursor.offset;
  const attempt = () => {
    const top = cursor.i32();
    const left = cursor.i32();
    const bottom = cursor.i32();
    const right = cursor.i32();
    const depth = cursor.u16();
    const compression = cursor.u8();
    const width = Math.abs(right - left);
    const height = Math.abs(bottom - top);
    if (!validEdge(width, height, depth) || cursor.offset > itemEnd) return null;
    const alpha = readPixels(cursor, width, height, compression, version >= 10 ? 4 : 2, itemEnd);
    return namedStamp(`笔尖 ${index}`, width, height, alpha);
  };
  const first = attempt();
  if (first) return first;
  cursor.offset = mark + 4;
  if (cursor.offset + 19 > itemEnd) return null;
  return attempt();
}

function readSamp(cursor, version, end, stamps) {
  let guard = 0;
  while (cursor.offset + 4 <= end && guard <= MAX_SAMPLES) {
    guard += 1;
    const itemSize = cursor.u32();
    if (itemSize < 19 || itemSize > end - cursor.offset) throw new AbrError('笔刷文件已损坏或不完整。');
    const itemEnd = cursor.offset + itemSize;
    const stamp = readModernSample(cursor, version, itemEnd, stamps.length + 1);
    if (stamp) stamps.push(stamp);
    cursor.offset = itemEnd;
    if (stamps.length > MAX_SAMPLES) throw new AbrError('笔尖样本数量超出安全上限。');
  }
}

function parseModern(cursor, version) {
  cursor.u16();
  const stamps = [];
  const warnings = [];
  let guard = 0;
  while (cursor.remaining() >= 12 && guard < 64) {
    guard += 1;
    if (cursor.ascii(4) !== '8BIM') throw new AbrError('笔刷文件已损坏或不完整。');
    const key = cursor.ascii(4);
    const length = cursor.u32();
    if (length > cursor.remaining()) throw new AbrError('笔刷文件已损坏或不完整。');
    const end = cursor.offset + length;
    if (key === 'samp') readSamp(cursor, version, end, stamps);
    else warnings.push(`已忽略 ${key} 参数块。`);
    cursor.offset = end;
    if (length % 2 === 1 && cursor.remaining()) cursor.skip(1);
  }
  return { stamps, warnings };
}

export function parseAbr(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (!bytes.length) return fail('笔刷文件为空或已损坏。');
  if (bytes.length > MAX_BYTES) return fail('笔刷文件超过 50 MiB，已拒绝解析。');
  try {
    const cursor = new Cursor(bytes);
    const version = cursor.u16();
    const parsed = version === 1 || version === 2
      ? parseLegacy(cursor, version)
      : version >= 6 && version <= 10
        ? parseModern(cursor, version)
        : null;
    if (!parsed) return fail(`无法识别的笔刷版本 ${version}。可能是加密笔刷或尚未支持的高版本。`);
    if (!parsed.stamps.length) return fail('该笔刷文件没有可提取的笔尖图案，可能是纯参数笔刷或加密笔刷。');
    return {
      ok: true,
      stamps: parsed.stamps,
      warnings: parsed.warnings,
      message: `成功导入 ${parsed.stamps.length} 个笔尖图案，已接入统一压感笔刷引擎；PS 私有双重画笔/湿边参数已忽略`,
    };
  } catch (error) {
    return fail(error instanceof AbrError ? error.message : '笔刷文件已损坏或不完整。');
  }
}
