export const SPRITE_ATLAS_PRESET = 'sprite_atlas';
export const SPRITE_ATLAS_MENU = ['游戏美术', '精灵图', '3D 角色转多方向图集'];
export const DEFAULT_SPRITE_OPTIONS = Object.freeze({
  directions: 8, frameSize: 192, framesPerAction: 8, actions: [],
  elevation: 10, startYaw: 0, padding: 0.1, pivot: [0.5, 0.9],
});
export const SPRITE_ACTIVE = ['uploading', 'queued', 'running', 'finishing'];

export function validateSpriteOptions(value = {}) {
  const options = { ...DEFAULT_SPRITE_OPTIONS, ...value };
  const allowed = new Set(Object.keys(DEFAULT_SPRITE_OPTIONS));
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('包含不支持的精灵图参数。');
  if (![4, 8, 16].includes(options.directions)) throw new Error('方向数必须为 4、8 或 16。');
  for (const [key, min, max] of [['frameSize', 32, 1024], ['framesPerAction', 1, 64]]) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数。`);
  }
  for (const [key, min, max] of [['elevation', 0, 60], ['startYaw', -360, 360], ['padding', 0, 0.4]]) {
    if (!Number.isFinite(options[key]) || options[key] < min || options[key] > max) throw new Error(`${key} 必须在 ${min}–${max} 之间。`);
  }
  if (!Array.isArray(options.pivot) || options.pivot.length !== 2 || options.pivot.some(v => !Number.isFinite(v) || v < 0.01 || v > 0.99)) throw new Error('轴心必须是两个 0.01–0.99 的坐标。');
  if (!Array.isArray(options.actions) || options.actions.length > 8 || options.actions.some(v => typeof v !== 'string' || !v.trim() || v.length > 200) || new Set(options.actions).size !== options.actions.length) throw new Error('最多选择 8 个不同的动作名称。');
  const width = options.frameSize * options.framesPerAction;
  const height = options.frameSize * options.directions * Math.max(1, options.actions.length);
  if (width > 8192 || height > 8192 || width * height > 64_000_000) throw new Error('图集过大，请减少动作、帧数或单帧尺寸（最大边长 8192）。');
  return { ...options, actions: [...options.actions], pivot: [...options.pivot] };
}

export function spriteSnapshot(data = {}) {
  const inputPath = String(data.spriteInputPath || '').trim();
  if (!inputPath || !/\.(glb|fbx)$/i.test(inputPath) || !/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(inputPath) || /^(?:\\\\|\/\/)/.test(inputPath)) throw new Error('请输入本机 GLB 或 FBX 的绝对路径。');
  const options = validateSpriteOptions(data.spriteOptions);
  return { inputPath, options, signature: JSON.stringify([inputPath, options]) };
}

export function spriteFiles(job) {
  if (job?.status !== 'done' || !/^spa_[a-f0-9]{32}$/.test(job.id || '')) throw new Error('精灵图尚未成功完成。');
  const names = { albedo: 'albedo.png', normal: 'normal.png', metadata: 'atlas.json' };
  for (const [key, name] of Object.entries(names)) {
    if (job.files?.[key] !== `/api/sprite-atlas/jobs/${job.id}/files/${name}`) throw new Error('精灵图输出身份不匹配。');
  }
  return { ...job.files };
}

export async function spriteRequest(path, { fetchImpl = fetch, ...options } = {}) {
  const response = await fetchImpl(`/api/sprite-atlas${path}`, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || `精灵图服务失败（${response.status}）。`), { status: response.status });
  return body;
}

export const spritePost = payload => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

const pollDelay = (milliseconds, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('已取消', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
  signal?.addEventListener('abort', abort, { once: true });
});

// Poll only this Blender job. This module never submits a ComfyUI prompt.
export async function waitForSpriteJob(id, { signal, onProgress = () => {}, fetchImpl = fetch, interval = 1000 } = {}) {
  if (!/^spa_[a-f0-9]{32}$/.test(id || '')) throw new Error('无效的精灵图任务 ID。');
  for (;;) {
    signal?.throwIfAborted();
    const job = await spriteRequest(`/jobs/${id}`, { signal, fetchImpl });
    if (job.id !== id) throw new Error('精灵图任务身份不匹配。');
    onProgress(job);
    if (job.status === 'done') { spriteFiles(job); return job; }
    if (job.status === 'error' || job.status === 'cancelled') throw Object.assign(new Error(job.error || (job.status === 'cancelled' ? '精灵图任务已取消。' : '精灵图渲染失败。')), { code: job.status === 'cancelled' ? 'SPRITE_CANCELLED' : 'SPRITE_FAILED' });
    if (!['queued', 'running'].includes(job.status)) throw new Error('精灵图任务状态无效。');
    await pollDelay(interval, signal);
  }
}
