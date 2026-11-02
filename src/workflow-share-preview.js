const SOURCE_LIMIT = 32 * 1024 * 1024;
export const THUMBNAIL_LIMIT = 128 * 1024;

// Inspect dimensions before the browser allocates a decoded bitmap.
export function thumbnailSourceSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 24 && text(1, 3) === 'PNG' && bytes[0] === 137 && text(12, 4) === 'IHDR') return [view.getUint32(16), view.getUint32(20)];
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += length;
    }
  }
  if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = text(offset, 4), length = view.getUint32(offset + 4, true), start = offset + 8;
      if (start + length > bytes.length) break;
      const uint24 = (at) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
      if (type === 'VP8X' && length >= 10) return [uint24(start + 4) + 1, uint24(start + 7) + 1];
      if (type === 'VP8 ' && length >= 10 && bytes[start + 3] === 157 && bytes[start + 4] === 1 && bytes[start + 5] === 42) return [view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383];
      if (type === 'VP8L' && length >= 5 && bytes[start] === 47) return [(bytes[start + 1] | (bytes[start + 2] & 63) << 8) + 1, ((bytes[start + 2] >> 6) | bytes[start + 3] << 2 | (bytes[start + 4] & 15) << 10) + 1];
      offset = start + length + (length % 2);
    }
  }
  throw new Error('无法读取封面图片尺寸，可取消使用封面后继续。');
}

function localImageUrl(value) {
  const url = new URL(value, location.href);
  if (url.origin !== location.origin || !(['http:', 'https:'].includes(url.protocol) && /^\/api\/(?:projects\/|comfy\/view$)/.test(url.pathname) || url.protocol === 'blob:')) throw new Error('封面只能读取当前画布的本地图片。');
  return url.href;
}

export async function prepareShareThumbnail(url, { signal } = {}) {
  const response = await fetch(localImageUrl(url), { signal, redirect: 'error' });
  if (!response.ok) throw new Error('封面图片读取失败，可取消使用封面后继续。');
  if (!/^image\/(?:png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > SOURCE_LIMIT) throw new Error('封面来源需为不超过 32 MiB 的 PNG、JPEG 或 WebP。');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SOURCE_LIMIT) throw new Error('封面原图超过 32 MiB，可取消使用封面后继续。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const [width, height] = thumbnailSourceSize(bytes);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw new Error('图片尺寸过大，无法制作封面。');
  const bitmap = await createImageBitmap(new Blob([bytes], { type: response.headers.get('content-type') }));
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 64 * 1024 * 1024) throw new Error('图片尺寸过大，无法制作封面。');
    const ratio = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    context.fillStyle = '#202020'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [.82, .65, .45]) {
      const result = canvas.toDataURL('image/jpeg', quality);
      if ((result.length - result.indexOf(',') - 1) * .75 <= THUMBNAIL_LIMIT) return result;
    }
    throw new Error('封面压缩后仍过大，可取消使用封面后继续。');
  } finally { bitmap.close(); }
}
