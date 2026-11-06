import { existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright-core';
import { publicEndpoint, publicFetch, startPublicProxy } from './browser_public_network.mjs';

const args = process.argv.slice(2);
const getArg = (name) => args[args.indexOf(name) + 1];
const sourceUrl = getArg('--url');
const output = getArg('--output');
const maxBytes = 250 * 1024 * 1024;
if (!sourceUrl || !output) throw new Error('缺少视频链接或输出路径。');
const source = new URL(sourceUrl);
if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) throw new Error('只支持公开的 HTTP(S) 视频链接。');
await publicEndpoint(source.hostname);

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
let browser, proxy;
try {
  proxy = await startPublicProxy();
  browser = await chromium.launch({ executablePath, headless: true, proxy: {server: proxy.server},
    args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const context = await browser.newContext({ locale: 'zh-CN', userAgent, serviceWorkers: 'block' });
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
  const headersForUrl = async (url, range) => {
    const cookies = await context.cookies(url);
    return {'User-Agent': userAgent, Referer: page.url(), Range: range,
      ...(cookies.length ? {Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')} : {})};
  };
  const probe = await publicFetch(videoUrl, url => headersForUrl(url, 'bytes=0-0'));
  if (probe.statusCode < 200 || probe.statusCode >= 300) { probe.destroy(); throw new Error(`视频流探测失败 (${probe.statusCode})，请稍后重试。`); }
  const probeRange = probe.headers['content-range']?.match(/^bytes\s+0-0\/(\d+)$/i);
  const expectedSize = probeRange ? Number(probeRange[1]) : Number(probe.headers['content-length'] || 0);
  probe.destroy();
  if (expectedSize > maxBytes) throw new Error('视频超过 250 MB，请下载并剪辑后再上传。');
  const response = await publicFetch(videoUrl, url => headersForUrl(url, expectedSize ? `bytes=0-${expectedSize - 1}` : 'bytes=0-'));
  if (response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); throw new Error(`视频流下载失败 (${response.statusCode})，请稍后重试。`); }
  const range = response.headers['content-range']?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (range && Number(range[1]) !== 0) { response.destroy(); throw new Error('视频流没有从文件开头返回，请重试。'); }
  let size = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) callback(new Error('视频超过 250 MB，请下载并剪辑后再上传。'));
      else callback(null, chunk);
    },
  });
  let created = false;
  const file = createWriteStream(output, { flags: 'wx' });
  file.once('open', () => { created = true; });
  try {
    await pipeline(response, limit, file);
  } catch (error) {
    if (created) await unlink(output).catch(() => {});
    throw error;
  }
  if (!size) { await unlink(output).catch(() => {}); throw new Error('下载到的视频是空文件。'); }
  if (expectedSize && size !== expectedSize) {
    await unlink(output).catch(() => {});
    throw new Error(`视频下载不完整 (${size}/${expectedSize} 字节)，请重试。`);
  }
  console.log(JSON.stringify({ title, size }));
} finally {
  try { if (browser) await browser.close(); }
  finally { if (proxy) await proxy.close(); }
}
