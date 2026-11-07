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
export async function probeLocalConnection({ fetchImpl = fetch, signal } = {}) {
  const read = (url) => fetchImpl(url, { signal, credentials: 'same-origin', cache: 'no-store' });
  let health;
  try {
    const response = await read('/api/health');
    if (!response.ok) throw new Error('Unavailable');
    health = await response.json();
    if (health.ok !== true) throw new Error('Not a workbench');
  } catch {
    return { online: false, backendOnline: false, label: '工作台服务未连接，点击启动本地服务', metrics: EMPTY_METRICS };
  }
  // System monitoring is independent of generation readiness.
  const readHardware = async () => {
    try {
      const response = await read('/api/hardware-metrics');
      return response.ok ? hardwareMetrics(await response.json()) : { ...EMPTY_METRICS };
    } catch { return { ...EMPTY_METRICS }; }
  };
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
      label: '工作台会话连接失败，请稍后点击重试；当前画布已保留', metrics: EMPTY_METRICS };
    if (!response.ok) throw new Error('ComfyUI unavailable');
    const stats = await response.json();
    const metrics = await readHardware();
    const device = stats?.devices?.[0];
    if (metrics.vramTotal == null && Number.isFinite(device?.vram_total) && Number.isFinite(device?.vram_free)) {
      metrics.vramTotal = device.vram_total;
      metrics.vramUsed = Math.max(0, device.vram_total - device.vram_free);
      metrics.gpuName = device.name || null;
      metrics.gpuPercent = null;
      metrics.gpuIndex = null;
    }
    return { online: true, backendOnline: true, sessionRefreshed,
      label: device?.name?.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, '') || '本地 GPU',
      metrics };
  } catch {
    return { online: false, backendOnline: true, sessionRefreshed, metrics: await readHardware(),
      label: '工作台已连接，但 ComfyUI 未就绪。请检查 ComfyUI 启动窗口，等待就绪后会自动重连。' };
  }
}

// Must run synchronously inside the toolbar click to retain browser user activation.
export function requestLocalStart() {
  const link = document.createElement('a');
  link.href = LOCAL_START_URL;
  link.click();
}
