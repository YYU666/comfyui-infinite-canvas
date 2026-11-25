const ROOT = '/api/cloud-media';

function endpoint(project, attempt) {
  return `${ROOT}/${encodeURIComponent(project)}/${encodeURIComponent(attempt)}`;
}

async function request(path, payload, signal) {
  const options = { cache: 'no-store', signal };
  if (payload !== undefined) {
    Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }
  const response = await fetch(path, options);
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw Object.assign(new Error(problem.message || '云端工作台暂不可用。'), { code: problem.code });
  }
  return response.headers.get('Content-Type')?.includes('application/json') ? response.json() : response.blob();
}

export const cloudProfiles = (signal) => request(`${ROOT}/providers`, undefined, signal);
export const configureCloud = (payload) => request(`${ROOT}/providers`, payload);
export const cloudJob = (project, attempt, signal) => request(endpoint(project, attempt), undefined, signal);
export const submitCloud = (project, attempt, payload) => request(`${endpoint(project, attempt)}/submit`, payload);
export const refreshCloud = (project, attempt) => request(`${endpoint(project, attempt)}/refresh`, {});
export const readCloudMedia = (project, attempt, index) => request(`${endpoint(project, attempt)}/media/${index}`);

export function cloudMediaPorts(route, model) {
  if (route === 'ark') return ['single', 'references', 'first', 'last'];
  if (route?.startsWith('wan-')) return ['first'];
  if (route === 'responses' || route === 'qianwen' || (route === 'apipool' && model === 'gpt-image-2')) return ['references'];
  return [];
}

export const cloudPortLabels = { single: '单图引导', references: '参考图', first: '首帧', last: '尾帧' };
