async function request(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `更新请求失败（${response.status}）。`);
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body;
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
  });
}

export async function getWorkbenchHealth() {
  const response = await fetch('/api/health', { cache: 'no-store' });
  if (!response.ok) throw new Error('工作台尚未就绪。');
  return response.json();
}
