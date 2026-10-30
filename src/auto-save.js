const RUNTIME_FIELDS = new Set(['status', 'progress', 'stage', 'runs', 'error', 'promptId', 'queueJobId', 'output', 'resultUrl', 'takePending']);
const deferredSave = () => Object.assign(new Error('请等待拖动、调整大小或素材导入完成后再保存。'), { code: 'SAVE_DEFERRED' });

export function persistentCanvas(canvas) {
  return {
    ...canvas,
    nodes: (canvas.nodes || []).map((node) => {
      const { measured, selected, dragging, resizing, positionAbsolute, ...stable } = node;
      const { file, ...data } = node.data || {};
      if (!data.error) delete data.error;
      if ((data.assetPath && !data.output) || data.url?.startsWith('blob:')) delete data.url;
      return { ...stable, data };
    }),
    edges: (canvas.edges || []).map(({ selected, ...edge }) => edge),
  };
}

export function autoSaveSignatures(name, canvas) {
  const { viewport, ...stable } = persistentCanvas(canvas);
  const signature = (editing) => JSON.stringify([name, {
    ...stable, nodes: stable.nodes.map((node) => ({ ...node, data: Object.fromEntries(
      Object.entries(node.data).filter(([key]) => editing ? !RUNTIME_FIELDS.has(key) : !['progress', 'stage', 'runs'].includes(key)),
    ) })),
  }]);
  return { editing: signature(true), full: signature(false) };
}

/** One immutable write at a time; interactions and imports defer the final snapshot. */
export class AutoSaveController {
  constructor({ name, canvas, write, onStateChange = () => {}, onError = () => {},
    debounceMs = 400, minIntervalMs = 1000,
    now = () => Date.now(), schedule = (callback, delay) => setTimeout(callback, delay), cancel = (timer) => clearTimeout(timer),
  }) {
    Object.assign(this, { write, onStateChange, onError, debounceMs, minIntervalMs, now, schedule, cancel });
    this.latest = { name, canvas };
    this.signatures = autoSaveSignatures(name, canvas);
    this.saved = this.signatures;
    this.inflight = false;
    this.timer = null;
    this.suspended = false;
    this.lastWrite = -Infinity;
    this.idleWaiters = [];
    this.disposed = false;
    this.failure = null;
    this.conflict = null;
    this.state = 'saved';
    this.forceFlush = false;
  }

  suspend() {
    this.suspended = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this._resolveIdle();
  }

  observe(name, canvas, { defer = false } = {}) {
    if (this.disposed) return;
    this.latest = { name, canvas };
    if (defer) { this.suspend(); return; } // No whole-canvas stringify during a drag/resize/import.
    this.suspended = false;
    const previous = this.signatures;
    this.signatures = autoSaveSignatures(name, canvas);
    if (this.failure) return; // Both transient failures and conflicts require deliberate recovery.
    if (this.signatures.full === this.saved.full) {
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null;
      if (!this.inflight) this._state('saved');
      this._resolveIdle();
      return;
    }
    const edited = this.signatures.editing !== this.saved.editing;
    if (edited) this._state('dirty');
    if (this.timer === null || this.signatures.full !== previous.full) this._schedule(edited ? this.debounceMs : 0);
  }

  hasUnsaved() {
    return Boolean(this.conflict) || this.suspended || this.signatures.full !== this.saved.full || this.inflight;
  }

  flush({ retry = false } = {}) {
    if (this.disposed) return Promise.reject(deferredSave());
    if (this.conflict || (this.failure && !retry)) return Promise.reject(this.conflict || this.failure);
    if (this.suspended) return Promise.reject(deferredSave());
    if (retry) this.failure = null;
    if (this.hasUnsaved()) { this.forceFlush = true; this._schedule(0); }
    return this.waitForIdle().then(() => {
      // Idle IO is not a successful save if an interaction cancelled the queued flush.
      if (this.disposed || this.hasUnsaved()) throw deferredSave();
    });
  }

  waitForIdle() {
    const idle = !this.inflight && this.timer === null ? Promise.resolve()
      : new Promise((resolve) => this.idleWaiters.push(resolve));
    return idle.then(() => { if (this.failure) throw this.failure; });
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  _state(state) {
    if (this.state !== state) { this.state = state; this.onStateChange(state); }
  }

  _schedule(delay) {
    if (this.disposed || this.inflight || this.failure || this.suspended) return;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => { this.timer = null; this._begin(); }, delay);
  }

  async _begin() {
    if (this.disposed || this.inflight || this.failure || this.suspended) return;
    if (!this.hasUnsaved()) { this._resolveIdle(); return; }
    const wait = this.minIntervalMs - (this.now() - this.lastWrite);
    if (!this.forceFlush && wait > 0) { this._schedule(wait); return; }
    this.forceFlush = false;
    const snapshot = { name: this.latest.name, canvas: persistentCanvas(this.latest.canvas), signatures: this.signatures };
    this.inflight = true;
    const edited = snapshot.signatures.editing !== this.saved.editing;
    if (edited) this._state('saving');
    try {
      await this.write(snapshot);
      this.lastWrite = this.now();
      this.saved = snapshot.signatures;
      if (edited && !this.suspended) this._state(this.signatures.editing === this.saved.editing ? 'saved' : 'dirty');
    } catch (error) {
      this.failure = error;
      if (error.code === 'REVISION_CONFLICT' || error.status === 409) this.conflict = error;
      this._state('error');
      this.onError(error);
    } finally {
      this.inflight = false;
      if (this.signatures.full !== this.saved.full) this._schedule(this.debounceMs);
      this._resolveIdle();
    }
  }

  _resolveIdle() {
    if (this.inflight || this.timer !== null) return;
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }
}
