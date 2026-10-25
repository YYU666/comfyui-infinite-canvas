import { existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const getArg = (name) => args[args.indexOf(name) + 1];
const sourceUrl = getArg('--url');
const output = getArg('--output');
const maxBytes = 250 * 1024 * 1024;
if (!sourceUrl || !output) throw new Error('缺少视频链接或输出路径。');

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = chromeCandidates.find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('没有找到 Chrome 或 Edge，无法解析需要网页验证的视频。');

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ locale: 'zh-CN', userAgent });
  const page = await context.newPage();
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let videoUrl = '';
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    videoUrl = await page.evaluate(() => {
      const videos = [...document.querySelectorAll('video')];
      for (const video of videos) {
        const sources = [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(source => source.src)];
        const found = sources.find(value => value?.startsWith('https://') || value?.startsWith('http://'));
        if (found) return found;
      }
      return '';
    });
    if (videoUrl) break;
    if (/验证|captcha|登录后查看|内容不存在|视频不存在/.test(await page.locator('body').innerText())) break;
    await page.waitForTimeout(1000);
  }
  if (!videoUrl) throw new Error('页面没有返回可播放的视频，可能需要登录、完成人机验证，或作品已失效。');
  // Douyin may expose a short preview first, then replace it with the full play URL.
  await page.waitForTimeout(5000);
  videoUrl = await page.evaluate((fallback) => {
    const video = [...document.querySelectorAll('video')].find(item => item.currentSrc || item.querySelector('source'));
    if (!video) return fallback;
    const sources = [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(source => source.src)].filter(Boolean);
    return sources.find(value => value.includes('/aweme/v1/play/')) || video.currentSrc || sources[0] || fallback;
  }, videoUrl);
  const title = (await page.title()).replace(/\s*[-_]\s*抖音\s*$/, '').trim() || '抖音视频参考';
  const cookies = await context.cookies();
  const headers = {
    'User-Agent': userAgent,
    Referer: page.url(),
    ...(cookies.length ? { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } : {}),
  };
  const probe = await fetch(videoUrl, { headers: { ...headers, Range: 'bytes=0-0' }, redirect: 'follow' });
  if (!probe.ok) throw new Error(`视频流探测失败 (${probe.status})，请稍后重试。`);
  const probeRange = probe.headers.get('content-range')?.match(/^bytes\s+0-0\/(\d+)$/i);
  const expectedSize = probeRange ? Number(probeRange[1]) : Number(probe.headers.get('content-length') || 0);
  await probe.body?.cancel();
  if (expectedSize > maxBytes) throw new Error('视频超过 250 MB，请下载并剪辑后再上传。');
  const response = await fetch(videoUrl, {
    headers: { ...headers, Range: expectedSize ? `bytes=0-${expectedSize - 1}` : 'bytes=0-' }, redirect: 'follow',
  });
  if (!response.ok || !response.body) throw new Error(`视频流下载失败 (${response.status})，请稍后重试。`);
  const range = response.headers.get('content-range')?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (range && Number(range[1]) !== 0) throw new Error('视频流没有从文件开头返回，请重试。');
  let size = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) callback(new Error('视频超过 250 MB，请下载并剪辑后再上传。'));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(output, { flags: 'wx' }));
  } catch (error) {
    await unlink(output).catch(() => {});
    throw error;
  }
  if (!size) throw new Error('下载到的视频是空文件。');
  if (expectedSize && size !== expectedSize) {
    await unlink(output).catch(() => {});
    throw new Error(`视频下载不完整 (${size}/${expectedSize} 字节)，请重试。`);
  }
  console.log(JSON.stringify({ title, size }));
} finally {
  if (browser) await browser.close();
}
