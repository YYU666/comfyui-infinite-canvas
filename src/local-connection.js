export const LOCAL_RECONNECTED = 'refmuse-local-reconnected';
export const LOCAL_START_URL = 'refmuse-canvas://start';
export const EMPTY_METRICS = { vramUsed: null, vramTotal: null, gpuPercent: null, gpuName: null, gpuIndex: null, cpuPercent: null, ramUsed: null, ramTotal: null };

function hardwareMetrics(value) {
  const result = { ...EMPTY_METRICS };
  for (const key of ['vramUsed', 'vramTotal', 'ramUsed', 'ramTotal', 'gpuIndex', 'cpuPercent', 'gpuPercent']) {
    const n = value?.[key];
    if (Number.isFinite(n) && n >= 0 && (!key.endsWith('Percent') || n <= 100)) result[key] = n;
  }
  if (typeof value?.gpuName === 'string') result.gpuName = value.gpuName.slice(0, 160);
  return result;
}

// Probe only reads. Never replay project writes or generation after a lost response.
async function probeReadiness({ fetchImpl = fetch, signal } = {}) {
  const read = (url) => fetchImpl(url, { signal, credentials: 'same-origin', cache: 'no-store' });
  let health;
  try {
    const response = await read('/api/health');
    if (!response.ok) throw new Error('Unavailable');
    health = await response.json();
    if (health.ok !== true) throw new Error('Not a workbench');
  } catch {
    return { online: false, backendOnline: false, label: '工作台服务未连接，点击启动本地服务', metrics: { ...EMPTY_METRICS } };
  }
  let sessionRefreshed = false;
  try {
    let response = await read('/api/comfy/system_stats');
    if (response.status === 401) {
      // The existing HTML bootstrap rotates the HttpOnly cookie. Fetching it
      // does not execute HTML, navigate, remount the canvas, or reopen a project.
      const bootstrap = await read('/');
      if (!bootstrap.ok) throw new Error('Session bootstrap failed');
      await bootstrap.body?.cancel();
      response = await read('/api/comfy/system_stats');
      sessionRefreshed = response.status !== 401;
    }
    if (response.status === 401 || response.status === 403) return { online: false, backendOnline: true,
      state: 'session_error', label: '工作台会话连接失败，请稍后点击重试；当前画布已保留', metrics: { ...EMPTY_METRICS } };
    if (!response.ok) throw new Error('ComfyUI unavailable');
    const stats = await response.json();
    const metrics = { ...EMPTY_METRICS };
    const device = stats?.devices?.[0];
    if (metrics.vramTotal == null && Number.isFinite(device?.vram_total) && Number.isFinite(device?.vram_free)) {
      metrics.vramTotal = device.vram_total;
      metrics.vramUsed = Math.max(0, device.vram_total - device.vram_free);
      metrics.gpuName = device.name || null;
      metrics.gpuPercent = null;
      metrics.gpuIndex = null;
    }
    return { online: true, backendOnline: true, sessionRefreshed,
      state: 'ready', comfy: health.comfy, label: device?.name?.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, '') || '本地 GPU',
      metrics };
  } catch {
    return { online: false, backendOnline: true, sessionRefreshed, state: health.comfy?.state, comfy: health.comfy, metrics: { ...EMPTY_METRICS },
      label: health.comfy?.error || (health.comfy?.state === 'starting' ? 'ComfyUI 正在启动，等待服务就绪…' : '工作台已连接，但 ComfyUI 未就绪。点击重试启动；可下载诊断日志查看原因。') };
  }
}

// Bound the whole operation (including body reads), even when a fetch mock ignores abort.
export async function boundedRead(operation, { signal, timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  let timer;
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => { controller.abort(); reject(signal?.reason || new Error('检查已取消')); };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error('连接检查超时')); }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

export async function probeLocalConnection({ fetchImpl = fetch, signal, onStatus, timeoutMs = 6000, metricsTimeoutMs = 1200 } = {}) {
  let next;
  try { next = await boundedRead(childSignal => probeReadiness({ fetchImpl, signal: childSignal }), { signal, timeoutMs }); }
  catch { next = { online: false, backendOnline: null, state: 'connection_timeout', label: '连接检查超时，请点击重试；当前画布已保留。', metrics: { ...EMPTY_METRICS } }; }
  if (signal?.aborted) return next;
  onStatus?.(next); // Publish readiness before optional monitoring can stall.
  if (!next.backendOnline) return next;
  try {
    const metrics = await boundedRead(async childSignal => {
      const response = await fetchImpl('/api/hardware-metrics', { signal: childSignal, credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Monitoring unavailable');
      return hardwareMetrics(await response.json());
    }, { signal, timeoutMs: metricsTimeoutMs });
    for (const [key, value] of Object.entries(metrics)) if (value != null) next.metrics[key] = value;
  } catch { /* Monitoring cannot revoke service readiness. */ }
  return next;
}

export async function requestComfyStart({ signal, fetchImpl = fetch } = {}) {
  return boundedRead(async childSignal => {
    const response = await fetchImpl('/api/local-comfy/start', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: '{}', signal: childSignal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '会话连接失败，请再次点击检查。' : '启动请求失败，请下载诊断日志。');
    return response.json();
  }, { signal, timeoutMs: 5000 });
}

// Must run synchronously inside the toolbar click to retain browser user activation.
export function requestLocalStart() {
  const link = document.createElement('a');
  link.href = LOCAL_START_URL;
  link.click();
}

export function localConnectionPresentation(server, starting = false) {
  const text = server.online ? (server.comfy?.degraded ? '已连接·素材库停用' : '本地已连接')
    : starting || server.state === 'starting' ? '正在启动…' : server.state === 'session_error' ? '会话异常'
    : server.state === 'connection_timeout' ? '连接超时' : ['exited', 'failed', 'timeout', 'port_conflict'].includes(server.state) ? '启动失败' : '本地未连接';
  return { connected: Boolean(server.online), text };
}
