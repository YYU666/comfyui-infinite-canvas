// The video-import browser is isolated from the workbench and only needs public
// HTTP(S). Check DNS at each connection and connect to the checked numeric IP.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8], ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24], ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',3]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::',23], ['2001:db8::',32], ['2002::',16], ['3fff::',20]]) blocked.addSubnet(address, prefix, 'ipv6');
const publicV6 = new net.BlockList(); publicV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && publicV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export async function publicEndpoint(hostname, resolver = dns.lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(host) ? [{address: host, family: net.isIP(host)}] : await resolver(host, {all: true, verbatim: true});
  if (!records.length || records.some(record => !isPublicAddress(record.address))) throw new Error('视频下载及跳转不能访问内网或本机地址。');
  return records.find(record => record.family === 4) || records[0];
}

function checkedUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持公开的 HTTP(S) 视频链接。');
  return url;
}

export async function publicRequest(value, headers = {}, method = 'GET') {
  const url = checkedUrl(value), endpoint = await publicEndpoint(url.hostname);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method, headers, agent: false,
      lookup(_hostname, options, callback) { callback(null, options?.all ? [endpoint] : endpoint.address, endpoint.family); },
    }, resolve);
    request.setTimeout(30000, () => request.destroy(new Error('视频网络请求超时。')));
    request.on('error', reject); request.end();
  });
}

export async function publicFetch(value, headersForUrl, maxRedirects = 8) {
  let url = checkedUrl(value);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await publicRequest(url, await headersForUrl(url.href));
    if (![301,302,303,307,308].includes(response.statusCode)) return response;
    response.destroy();
    if (!response.headers.location || hop === maxRedirects) throw new Error('视频下载跳转次数过多或地址无效。');
    url = checkedUrl(new URL(response.headers.location, url));
  }
}

export async function startPublicProxy() {
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      const url = checkedUrl(request.url);
      // Browser HTTPS uses CONNECT below. Never accept origin-form local paths.
      if (url.protocol !== 'http:') throw new Error('不支持的代理请求。');
      const endpoint = await publicEndpoint(url.hostname);
      const headers = {...request.headers}; delete headers['proxy-connection']; delete headers['proxy-authorization'];
      const upstream = http.request(url, {method:request.method, headers, agent:false,
        lookup(_host, options, callback) { callback(null, options?.all ? [endpoint] : endpoint.address, endpoint.family); }}, result => {
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on('socket', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on('aborted', () => upstream.destroy()); response.on('close', () => upstream.destroy()); request.pipe(upstream);
    } catch { response.writeHead(403); response.end('Public network only'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  server.on('connect', async (request, client, head) => {
    try {
      const url = checkedUrl(`https://${request.url}`), endpoint = await publicEndpoint(url.hostname);
      const upstream = net.connect({host:endpoint.address, family:endpoint.family, port:Number(url.port || 443)});
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.setTimeout(60000, () => upstream.destroy());
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
      upstream.on('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  return {server: `http://127.0.0.1:${server.address().port}`, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }};
}
