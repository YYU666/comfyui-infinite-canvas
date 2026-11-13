import assert from 'node:assert/strict';
import { downloadVideoForMcp, registerCanvasMcp } from './src/canvas-mcp.js';
import { publicDownloadError, validatePublicVideoUrl, videoDownloadState } from './src/video-download.js';

const secret = 's3cret-token';

function assertNoSecret(value) {
  assert.equal(JSON.stringify(value).includes(secret), false);
}

for (const [input, expected] of [
  ['https://www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk'],
  ['https://v.douyin.com/abcDEF123/', 'https://v.douyin.com/abcDEF123/'],
  ['https://www.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD'],
  ['7.43 复制打开抖音，看看【作品】https://v.douyin.com/abcDEF123/ 08/05', 'https://v.douyin.com/abcDEF123/'],
  ['http://xhslink.com/a/AbCdEf?xsec_token=AB123&xsec_source=pc_feed', 'http://xhslink.com/a/AbCdEf?xsec_token=AB123&xsec_source=pc_feed'],
  ['https://example.com/video.mp4。', 'https://example.com/video.mp4'],
]) {
  assert.equal(validatePublicVideoUrl(input), expected);
}

for (const input of ['', '   ', '只有分享标题，没有链接', 'javascript:alert(1)', 'file:///tmp/a.mp4', 'ftp://example.com/a.mp4', `https://alice:${secret}@example.com/a`]) {
  assert.throws(() => validatePublicVideoUrl(input), (error) => {
    assertNoSecret(error.message);
    return true;
  });
}
assert.throws(() => validatePublicVideoUrl(`看看 https://alice:${secret}@example.com/v`), /账号或密码/);
assert.throws(() => validatePublicVideoUrl(123), /http 或 https/);
assert.throws(() => validatePublicVideoUrl(`https://example.com/${'a'.repeat(4000)}`), /过长/);
assert.equal(publicDownloadError({ name: 'TimeoutError' }), '视频下载超时，请换较短的视频，或下载后手动上传。');
assert.equal(publicDownloadError(new Error(`失败 https://alice:${secret}@example.com/v`)).includes(secret), false);
assert.equal(videoDownloadState({ title: '普通备注' }), null);

function harness({ busy = false, importer } = {}) {
  const nodes = [];
  let persists = 0;
  let seenAtStart = null;
  const latest = { current: {
    nodesRef: { current: nodes },
    edgesRef: { current: [] },
    projectName: '下载测试',
    projectId: 'prj_download',
    readOnly: false,
    server: { online: true },
    actions: {
      addNode: (type, extra, position) => {
        const id = `note-${nodes.length + 1}`;
        nodes.push({ id, type, position: position || { x: 12, y: 24 }, data: { ...extra } });
        return id;
      },
      patchNode: (id, patch) => {
        const node = nodes.find((item) => item.id === id);
        node.data = { ...node.data, ...patch };
      },
      updateNode: (id, patch) => {
        const node = nodes.find((item) => item.id === id);
        node.data = { ...node.data, ...patch };
      },
      persistProject: async () => { persists += 1; },
      isVideoDownloadBusy: () => busy,
      importVideoReference: importer || (async (url, nodeId) => {
        const node = nodes.find((item) => item.id === nodeId);
        seenAtStart = node.data.downloadStatus;
        Object.assign(node.data, { downloadStatus: 'downloading', status: 'downloading', downloadMessage: '正在解析并下载到本机', stage: '正在下载', downloadUrl: url, sourceUrl: url });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const videoId = `video-${nodeId}`;
        nodes.push({ id: videoId, type: 'media', position: { x: node.position.x + 360, y: node.position.y }, data: { kind: 'video', title: '下载的视频', sourceUrl: url } });
        Object.assign(node.data, { downloadStatus: 'done', status: 'done', downloadMessage: '下载完成', stage: '下载完成', videoNodeId: videoId, error: null });
        return videoId;
      }),
    },
  } };
  return { latest, nodes, seen: () => seenAtStart, persists: () => persists };
}

const fastWait = async (read) => read() || null;

{
  const { latest, nodes, seen, persists } = harness();
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const receipt = await downloadVideoForMcp(latest, { url, x: 80, y: 120, wait: false }, fastWait);
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.message, '已排队，准备下载');
  assert.ok(receipt.jobId);
  assert.equal(receipt.nodeId, 'note-1');
  assert.equal(nodes[0].position.x, 80);
  assert.equal(nodes[0].data.noteRole, 'videoDownload');
  assert.equal(nodes[0].data.downloadUrl, url);
  assert.equal(persists() >= 1, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen(), 'queued');
  assert.equal(nodes[0].data.downloadStatus, 'done');
  assert.equal(nodes[0].data.videoNodeId, 'video-note-1');
  assert.equal(nodes[1].position.x, 440);
  assert.equal(nodes[1].data.kind, 'video');
  const state = videoDownloadState(nodes[0].data);
  assert.equal(state.downloadStatus, 'done');
  assert.equal(state.videoNodeId, 'video-note-1');
  assert.equal(state.message, '下载完成');
  assert.equal(state.sourceUrl, url);
  assertNoSecret(state);
}

{
  const { latest, nodes } = harness();
  nodes.push({ id: 'download1', type: 'note', position: { x: 10, y: 20 }, data: { title: '视频链接下载', noteRole: 'videoDownload' } });
  const url = '7.84 复制打开抖音 https://v.douyin.com/abcDEF123/ 复制此链接';
  const done = await downloadVideoForMcp(latest, { nodeId: 'download1', url, x: 1, wait: true }, fastWait);
  assert.equal(done.nodeId, 'download1');
  assert.equal(done.status, 'done');
  assert.equal(done.videoNodeId, 'video-download1');
  assert.equal(nodes.filter((node) => node.data.noteRole === 'videoDownload').length, 1);
  assert.equal(nodes[0].data.sourceUrl, 'https://v.douyin.com/abcDEF123/');
  assert.equal(nodes[0].data.downloadUrl, 'https://v.douyin.com/abcDEF123/');
}

{
  const { latest, nodes } = harness({ importer: async () => { throw new Error(`无法加载 https://alice:${secret}@example.com/a`); } });
  await assert.rejects(downloadVideoForMcp(latest, { url: 'https://example.com/missing.mp4', wait: true }, fastWait), (error) => {
    assert.match(error.message, /无法加载/);
    assertNoSecret(error.message);
    return true;
  });
  assert.equal(nodes[0].data.downloadStatus, 'failed');
  assert.match(nodes[0].data.downloadMessage, /无法加载/);
  assertNoSecret(nodes[0].data);
  const failed = videoDownloadState(nodes[0].data);
  assert.equal(failed.downloadStatus, 'failed');
  assert.equal(failed.error, failed.message);
  assertNoSecret(failed);
}

{
  const { latest } = harness();
  nodesOf(latest).push({ id: 'gen', type: 'generator', position: { x: 0, y: 0 }, data: { mode: 'reference' } });
  await assert.rejects(downloadVideoForMcp(latest, { nodeId: 'gen', url: 'https://example.com/a.mp4' }, fastWait), /视频链接下载节点/);
  await assert.rejects(downloadVideoForMcp(latest, { url: 'https://example.com/a.mp4', x: 10 }, fastWait), /x 和 y/);
  await assert.rejects(downloadVideoForMcp(latest, { url: 'https://example.com/a.mp4', nodeId: 'missing' }, fastWait), /找不到节点/);
}

{
  const { latest } = harness({ busy: true });
  await assert.rejects(downloadVideoForMcp(latest, { url: 'https://example.com/a.mp4', x: 0, y: 0 }, fastWait), /另一段视频正在下载/);
  assert.equal(nodesOf(latest).length, 0);
}

function nodesOf(latest) { return latest.current.nodesRef.current; }

{
  const { latest, nodes } = harness();
  const tools = new Map();
  const stop = registerCanvasMcp(latest, {
    context: { registerTool: (tool) => tools.set(tool.name, tool) },
    startPage: () => () => {},
  });
  try {
    assert.ok(tools.has('canvas_download_video'));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    latest.current.actions.importVideoReference = async (url, nodeId) => {
      const node = nodes.find((item) => item.id === nodeId);
      Object.assign(node.data, { downloadStatus: 'downloading', status: 'downloading', downloadMessage: '正在解析并下载到本机', stage: '正在下载' });
      await gate;
      const videoId = 'video-from-tool';
      nodes.push({ id: videoId, type: 'media', position: { x: node.position.x + 360, y: node.position.y }, data: { kind: 'video', sourceUrl: url } });
      Object.assign(node.data, { downloadStatus: 'done', status: 'done', downloadMessage: '下载完成', stage: '下载完成', videoNodeId: videoId, error: null });
      return videoId;
    };
    const started = JSON.parse(await tools.get('canvas_download_video').execute({ url: 'https://www.bilibili.com/video/BV1agent', x: 20, y: 40, wait: false }));
    assert.equal(started.ok, true);
    assert.equal(started.status, 'queued');
    assert.equal(started.nodeId, nodes[0].id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mid = JSON.parse(await tools.get('canvas_get_state').execute({ nodeId: started.nodeId }));
    assert.equal(mid.ok, true);
    assert.equal(mid.nodes[0].downloadStatus, 'downloading');
    assert.match(mid.nodes[0].message, /下载/);
    assert.equal(mid.nodes[0].sourceUrl, 'https://www.bilibili.com/video/BV1agent');
    assert.equal(mid.nodes[0].downloadJobId, started.jobId);
    assert.equal(mid.nodes[0].videoNodeId, null);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = JSON.parse(await tools.get('canvas_get_state').execute({ nodeId: started.nodeId }));
    assert.equal(after.nodes[0].downloadStatus, 'done');
    assert.equal(after.nodes[0].videoNodeId, 'video-from-tool');
    assert.equal(after.nodes[0].message, '下载完成');
    const finished = JSON.parse(await tools.get('canvas_download_video').execute({ nodeId: started.nodeId, url: 'https://example.com/second.mp4', wait: true }));
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.equal(finished.status, 'done');
    assert.ok(finished.videoNodeId);
  } finally { stop(); }
}

console.log('CANVAS_DOWNLOAD_VIDEO_OK url=http(s) noCredentials queued=true wait=true getState=progress');
