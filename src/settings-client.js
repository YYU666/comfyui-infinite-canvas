async function request(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `设置请求失败（${response.status}）。`);
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

export function getSettings() {
  return request('/api/settings');
}

export async function updateSettings(payload) {
  const result = await request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  window.dispatchEvent(new CustomEvent('h3-settings-changed', { detail: result }));
  return result;
}
