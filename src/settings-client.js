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

export function updateSettings(payload) {
  return request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
