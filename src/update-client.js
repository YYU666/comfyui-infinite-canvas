async function request(path, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...options, cache: 'no-store', signal: controller.signal });
    const body = await response.json().catch((error) => {
      if (error.name === 'AbortError') throw error;
      if (response.ok) throw new Error('更新接口返回了无效响应，请重新启动工作台后重试。');
      return {};
    });
    if (!response.ok) {
      const error = new Error(response.status === 404
        ? '当前后端尚不支持更新检查，请先保存项目，再按 README 更新并重新启动工作台。'
        : body.message || `更新请求失败（${response.status}）。`);
      error.code = body.code;
      error.status = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('更新请求超时，请检查网络后重试。');
      timeoutError.code = 'UPDATE_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally { clearTimeout(timeout); }
}

export function checkForUpdates() {
  return request('/api/updates/check');
}

export function getUpdateStatus() {
  return request('/api/updates/status');
}

export function applyUpdate(tag) {
  return request('/api/updates/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  }, 30 * 60 * 1000); // Preparation includes downloads, npm ci (900s), and build (300s).
}

export async function getWorkbenchHealth() {
  return request('/api/health');
}
