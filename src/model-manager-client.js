async function request(path, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...options, cache: 'no-store', signal: controller.signal });
    const body = await response.json().catch((error) => {
      if (error.name === 'AbortError') throw error;
      if (response.ok) throw new Error('模型管理接口返回无效响应，请重试。');
      return {};
    });
    if (!response.ok) {
      const error = new Error(body.message || `模型管理请求失败（${response.status}）。`);
      error.code = body.code;
      error.status = response.status;
      error.details = body.details && typeof body.details === 'object' ? body.details : {};
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('模型管理请求超时，请稍后重试。');
      timeoutError.code = 'MODEL_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function postJson(path, payload) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

export function getModelsSnapshot() {
  return request('/api/models');
}

export function setModelLock(path, locked) {
  return postJson('/api/models/lock', { path, locked });
}

export function lockAllInstalledModels() {
  return postJson('/api/models/lock-installed', {});
}

export function deleteInstalledModel(path) {
  return postJson('/api/models/delete', { path });
}

export function verifyInstalledModel(path) {
  return postJson('/api/models/verify', { path });
}

export function downloadModelUpdate(path) {
  return postJson('/api/models/download', { path });
}

export function cancelModelDownload(path) {
  return postJson('/api/models/cancel', { path });
}
