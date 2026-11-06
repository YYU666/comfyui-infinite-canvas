import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { isPublicAddress, publicEndpoint, publicFetch, startPublicProxy } from './browser_public_network.mjs';

for (const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.1.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(ip), false, ip);
for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
await assert.rejects(publicEndpoint('mixed.test', async () => [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
assert.deepEqual(await publicEndpoint('public.test', async () => [{address:'8.8.8.8',family:4}]), {address:'8.8.8.8',family:4});

// No external network: the public request is synthetic and its redirect points
// to a local sentinel which must never receive a request.
let calls = 0;
const original = http.request;
http.request = (_url, options, complete) => {
  calls++;
  options.lookup('ignored-host', {}, (error,address) => { assert.equal(error,null); assert.equal(address,'8.8.8.8'); });
  const request = new EventEmitter(); request.setTimeout = () => {}; request.end = () => complete({statusCode:302,headers:{location:'http://127.0.0.1/private'},destroy() {}});
  return request;
};
try { await assert.rejects(publicFetch('http://8.8.8.8/video', async () => ({})), /内网或本机/); assert.equal(calls,1); }
finally { http.request = original; }

const proxy = await startPublicProxy();
try {
  const response = await new Promise((resolve,reject) => {
    const request=http.request(proxy.server,{path:'http://127.0.0.1/private'},resolve); request.on('error',reject); request.end();
  });
  assert.equal(response.statusCode,403); response.resume();
  const connect = await new Promise((resolve,reject) => {
    const request=http.request(proxy.server,{method:'CONNECT',path:'127.0.0.1:8188'}); request.on('connect',(response,socket) => {socket.destroy();resolve(response.statusCode);}); request.on('error',reject); request.end();
  });
  assert.equal(connect,403);
} finally { await proxy.close(); }
console.log('PUBLIC_NETWORK_OK DNS pinning, private ranges, redirect/CONNECT blocking; no external traffic');
