// Strip ancillary PNG metadata without decoding/re-encoding pixels (including 16-bit images).
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sRGB', 'sBIT', 'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT']);
const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
export function pngCrc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
export function stripPngMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) throw new Error('去除元数据目前支持 PNG，请导出 PNG 图片。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  let offset = 8, header = false, image = false, end = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), next = offset + 12 + length;
    if (next > bytes.length) throw new Error('PNG 文件不完整，已停止导出。');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || pngCrc(bytes.subarray(offset + 4, next - 4)) !== view.getUint32(next - 4)) throw new Error('PNG 校验失败，已停止导出。');
    if (!header && (type !== 'IHDR' || length !== 13)) throw new Error('PNG 缺少有效图像头。');
    if (header && type === 'IHDR') throw new Error('PNG 图像头重复，已停止导出。');
    header = true;
    if (type === 'IDAT') image = true;
    if (KEEP.has(type)) parts.push(bytes.subarray(offset, next));
    else if (type[0] === type[0].toUpperCase()) throw new Error('PNG 包含未知关键数据，已停止导出。');
    offset = next;
    if (type === 'IEND') { end = length === 0; break; }
  }
  if (!end || !image || offset !== bytes.length) throw new Error('PNG 数据结构无效，已停止导出。');
  return new Blob(parts, { type: 'image/png' });
}

export async function imageExportBlob(url, removeMetadata, fetcher = fetch) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error('读取图片失败，请重试。');
  const blob = await response.blob();
  return removeMetadata ? stripPngMetadata(await blob.arrayBuffer()) : blob;
}
