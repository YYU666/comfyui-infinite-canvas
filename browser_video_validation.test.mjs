import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postId, findPostVideo, validateDuration, validateDownloadedVideo } from './browser_video_validation.mjs';
const post = (id, duration = 2000) => ({aweme_id: id, desc: 'test', video: {duration, play_addr: {url_list: ['https://cdn.example/video?secret=token']}}});
test('resolved Douyin ID is required and recommendations cannot substitute', () => {
  assert.equal(postId('https://www.douyin.com/video/123'), '123');
  assert.equal(postId('https://v.douyin.com/short/'), '');
  assert.equal(postId('https://evil.example/video/123'), '');
  assert.equal(findPostVideo({aweme_detail: post('999')}, '123'), null);
  assert.equal(findPostVideo(post('123'), ''), null);
  assert.equal(findPostVideo({list: [post('999'), post('123')]}, '123').awemeId, '123');
});
test('short genuine post passes while a two-second placeholder for a longer post fails', () => {
  validateDuration(2, findPostVideo(post('123'), '123').duration);
  assert.throws(() => validateDuration(2, 60));
  assert.throws(() => validateDuration(NaN, 2));
  assert.equal(findPostVideo(post('123', 0), '123'), null);
});
test('failed decode or duration mismatch removes created output without leaking URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'douyin-validation-'));
  const file = join(dir, 'video.mp4');
  try {
    for (const execute of [async () => { throw new Error('https://cdn.example/?secret=token'); }, async () => ({stdout: 'frame=50\nout_time_us=2000000\nprogress=end\n', stderr: 'Duration: 00:01:00.00'})]) {
      await writeFile(file, 'placeholder');
      await assert.rejects(validateDownloadedVideo(file, 60, 'ffmpeg', execute), error => !error.message.includes('https:') && !error.message.includes('token'));
      await assert.rejects(access(file));
    }
    await writeFile(file, 'valid');
    assert.equal(await validateDownloadedVideo(file, 2, 'ffmpeg', async () => ({stdout: 'frame=50\nout_time_us=2000000\nprogress=end\n', stderr: 'Duration: 00:01:00.00'})), 2);
    await access(file);
  } finally { await rm(dir, {recursive: true}); }
});
test('browser import retains network protections and never selects an unbound DOM video', async () => {
  const script = await readFile(new URL('./browser_video_import.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes('context.cookies(url)'));
  assert.ok(script.includes('await publicFetch(videoUrl'));
  assert.ok(script.includes('startPublicProxy()'));
  assert.ok(!script.includes("querySelectorAll('video')"));
  assert.ok(script.includes('error instanceof VideoImportError ? error.message :')); 
  assert.ok(!script.includes('JSON.stringify({ title, size, videoUrl'));
});

test('real decoder rejects long-audio short-video, accepts short clip, and refuses playlists', {skip: !process.env.TEST_FFMPEG}, async () => {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const execute = promisify(execFile);
  const ffmpeg = process.env.TEST_FFMPEG;
  const dir = await mkdtemp(join(tmpdir(), 'douyin-real-decode-'));
  try {
    const mixed = join(dir, 'mixed.mp4');
    await execute(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=25:duration=2', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono:d=60', '-c:v', 'libx264', '-c:a', 'aac', mixed], {windowsHide: true});
    await assert.rejects(validateDownloadedVideo(mixed, 60, ffmpeg));
    await assert.rejects(access(mixed));
    const short = join(dir, 'short.mp4');
    await execute(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=25:duration=2', '-c:v', 'libx264', short], {windowsHide: true});
    const duration = await validateDownloadedVideo(short, 2, ffmpeg);
    assert.ok(duration > 1.5 && duration < 2.5);
    const playlist = join(dir, 'playlist.mp4');
    await writeFile(playlist, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:1/private.ts\n#EXT-X-ENDLIST\n');
    await assert.rejects(validateDownloadedVideo(playlist, 2, ffmpeg));
    await assert.rejects(access(playlist));
  } finally { await rm(dir, {recursive: true}); }
});

