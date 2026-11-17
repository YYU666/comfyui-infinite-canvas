import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { pngCrc, stripPngMetadata, imageExportBlob } from './src/image-export.js';

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc(body));
  return Buffer.concat([header, body, crc]);
}
const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const ihdr = Buffer.from([0,0,0,1,0,0,0,1,16,6,0,0,0]);
const pixel = chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 0, 0, 0, 0, 255, 255])));
const color = chunk('iCCP', Buffer.from('keep-color-profile'));
const png = Buffer.concat([signature, chunk('IHDR',ihdr), color,
  ...['tEXt','iTXt','zTXt','eXIf'].map(type=>chunk(type,Buffer.from('prompt workflow seed GPS'))),
  pixel, chunk('IEND',Buffer.alloc(0))]);

test('removes text/exif while preserving exact 16-bit pixels and color profile', async()=>{
  const clean=Buffer.from(await stripPngMetadata(png).arrayBuffer());
  assert.ok(clean.includes(pixel)); assert.ok(clean.includes(color)); assert.ok(clean.includes(ihdr));
  for(const marker of ['tEXt','iTXt','zTXt','eXIf','workflow','GPS']) assert.ok(!clean.includes(Buffer.from(marker)));
  assert.ok(png.includes(Buffer.from('workflow')));
});
test('preserves standard HDR color interpretation and luminance chunks', async()=>{
  const hdr = [chunk('cICP', Buffer.from([9,16,0,1])), chunk('mDCV', Buffer.alloc(24,1)), chunk('cLLI', Buffer.alloc(8,1))];
  const source = Buffer.concat([signature, chunk('IHDR',ihdr), ...hdr, chunk('iTXt',Buffer.from('private workflow')), pixel, chunk('IEND',Buffer.alloc(0))]);
  const clean = Buffer.from(await stripPngMetadata(source).arrayBuffer());
  for (const colorChunk of hdr) assert.ok(clean.includes(colorChunk));
  assert.ok(clean.includes(pixel)); assert.ok(!clean.includes(Buffer.from('private workflow')));
});
test('off exports original bytes; corrupt and non-PNG input fail without a download', async()=>{
  const original=await imageExportBlob('fixture',false,async()=>new Response(png));
  assert.deepEqual(Buffer.from(await original.arrayBuffer()),png);
  assert.throws(()=>stripPngMetadata(Buffer.from('jpeg')),/PNG/);
  assert.throws(()=>stripPngMetadata(png.subarray(0,-1)),/PNG/);
  const corrupt=Buffer.from(png);corrupt[45]^=1;
  assert.throws(()=>stripPngMetadata(corrupt),/PNG/);
  assert.throws(()=>stripPngMetadata(Buffer.concat([png,Buffer.from('hidden')])),/PNG/);
  assert.throws(()=>stripPngMetadata(Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IHDR', ihdr), pixel, chunk('IEND', Buffer.alloc(0))])),/PNG/);
});
