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
      error.details = body.details && typeof body.details === 'object' ? body.details : {};
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

function failurePaths(details) {
  const paths = Array.isArray(details?.paths) ? details.paths.filter((item) => typeof item === 'string' && item.trim()) : [];
  return paths.slice(0, 12);
}

export function describeUpdateFailure(error) {
  const message = error?.message || '升级失败，请查看工作台状态和运行日志。';
  const paths = failurePaths(error?.details);
  if (!paths.length || paths.some((path) => message.includes(path))) return message;
  const count = Number(error.details?.count) || paths.length;
  return `${message}\n${paths.join('、')}${count > paths.length ? ` 等 ${count} 处` : ''}`;
}

/** A previous failed apply must not hide a release the check still says is available. */
export function priorFailureForRelease(status, release) {
  const failure = status?.lastResult?.phase === 'error' ? status.lastResult : null;
  if (!failure || !release?.updateAvailable || !release.version || !failure.version) return null;
  return failure.version === release.version ? failure : null;
}

/** A restarted backend reports rollback through lastResult, not its idle phase. */
export function currentAttemptFailure(status, version, startedAt) {
  const target = version.replace(/^v/, '');
  if (status?.phase === 'error') {
    const reported = status.version?.replace(/^v/, '');
    return !reported || reported === target ? status : null;
  }
  if (status?.phase !== 'idle') return null;
  const failure = status.lastResult;
  if (failure?.phase !== 'error' || failure.version?.replace(/^v/, '') !== target) return null;
  const updatedAt = Date.parse(failure.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt >= startedAt ? failure : null;
}
