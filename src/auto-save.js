const RUNTIME_FIELDS = new Set(['status', 'progress', 'stage', 'runs', 'error', 'promptId', 'queueJobId', 'output', 'resultUrl']);
const TERMINAL_STATES = new Set(['done', 'error', 'cancelled']);

function signatureCanvas(canvas, editing) {
  return {
    ...canvas,
    nodes: (canvas.nodes || []).map((node) => {
      const { selected, dragging, ...stableNode } = node;
      const data = editing
        ? Object.fromEntries(Object.entries(node.data || {}).filter(([key]) => !RUNTIME_FIELDS.has(key)))
        : node.data;
      return { ...stableNode, data };
    }),
  };
}

export function autoSaveSignatures(name, canvas) {
  return {
    editing: JSON.stringify([name, signatureCanvas(canvas, true)]),
    full: JSON.stringify([name, signatureCanvas(canvas, false)]),
  };
}

function terminalToken(canvas) {
  return JSON.stringify((canvas.nodes || []).filter((node) => TERMINAL_STATES.has(node.data?.status))
    .map((node) => [node.id, node.data.status]));
}

/** One writer, one trailing edit, independent 5-second runtime snapshots. */
export class AutoSaveController {
  constructor({
    name, canvas, write, onStateChange = () => {}, onNotice = () => {}, onError = () => {},
    debounceMs = 400, runtimeMs = 5000, minIntervalMs = 1000, quietMs = 2000, noticeMs = 5000,
    now = () => Date.now(), schedule = (callback, delay) => setTimeout(callback, delay), cancel = (timer) => clearTimeout(timer),
  }) {
    this.write = write;
    this.onStateChange = onStateChange;
    this.onNotice = onNotice;
    this.onError = onError;
    this.debounceMs = debounceMs;
    this.runtimeMs = runtimeMs;
    this.minIntervalMs = minIntervalMs;
    this.quietMs = quietMs;
    this.noticeMs = noticeMs;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.latest = { name, canvas };
    this.signatures = autoSaveSignatures(name, canvas);
    this.lastSavedFull = this.signatures.full;
    this.savedEdit = this.signatures.editing;
    this.terminalToken = terminalToken(canvas);
    this.needsEdit = false;
    this.inflight = false;
    this.timer = null;
    this.timerDue = 0;
    this.runtimeDue = null;
    this.lastWrite = -Infinity;
    this.lastEdit = -Infinity;
    this.lastNotice = -Infinity;
    this.noticeTimer = null;
    this.idleWaiters = [];
    this.disposed = false;
    this.forceFlush = false;
    this.failure = null;
  }

  observe(name, canvas) {
    if (this.disposed) return;
    const signatures = autoSaveSignatures(name, canvas);
    const editChanged = signatures.editing !== this.signatures.editing;
    const fullChanged = signatures.full !== this.signatures.full;
    const nextTerminalToken = terminalToken(canvas);
    const terminalChanged = nextTerminalToken !== this.terminalToken;
    this.terminalToken = nextTerminalToken;
    this.latest = { name, canvas };
    this.signatures = signatures;
    if (fullChanged) this.failure = null;
    if (editChanged) {
      this.needsEdit = true;
      this.lastEdit = this.now();
      this.onStateChange('dirty');
      this.runtimeDue = null;
      this._schedule(this.debounceMs, true);
      this._scheduleNotice();
    } else if (fullChanged) {
      if (terminalChanged) {
        this.runtimeDue = this.now();
        this._schedule(0);
      } else {
        if (this.runtimeDue === null) this.runtimeDue = this.now() + this.runtimeMs;
        this._schedule(Math.max(0, this.runtimeDue - this.now()));
      }
    }
  }

  hasUnsaved() {
    return this.needsEdit || this.signatures.full !== this.lastSavedFull || this.inflight;
  }

  flush() {
    if (this.disposed) return Promise.resolve();
    if (this.hasUnsaved()) {
      this.failure = null;
      this.forceFlush = true;
      this.runtimeDue = this.now();
      this._schedule(0, true);
    }
    return this.waitForIdle();
  }

  waitForIdle() {
    const idle = !this.inflight && !this.timer
      ? Promise.resolve()
      : new Promise((resolve) => this.idleWaiters.push(resolve));
    return idle.then(() => { if (this.failure) throw this.failure; });
  }

  dispose() {
    this.disposed = true;
    if (this.timer) this.cancel(this.timer);
    if (this.noticeTimer) this.cancel(this.noticeTimer);
    this.timer = null;
    this.noticeTimer = null;
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  _schedule(delay, postpone = false) {
    if (this.disposed || this.inflight) return;
    const due = this.now() + Math.max(0, delay);
    if (this.timer) {
      if (!postpone && due >= this.timerDue) return;
      this.cancel(this.timer);
    }
    this.timerDue = due;
    this.timer = this.schedule(() => {
      this.timer = null;
      this._begin();
    }, Math.max(0, delay));
  }

  async _begin() {
    if (this.disposed || this.inflight) return;
    if (!this.hasUnsaved()) { this._resolveIdle(); return; }
    const wait = this.minIntervalMs - (this.now() - this.lastWrite);
    if (!this.forceFlush && wait > 0) { this._schedule(wait); return; }
    const snapshot = {
      ...this.latest,
      signatures: this.signatures,
      editWrite: this.needsEdit,
    };
    this.forceFlush = false;
    this.inflight = true;
    if (snapshot.editWrite) this.onStateChange('saving');
    try {
      await this.write(snapshot);
      this.failure = null;
      this.lastWrite = this.now();
      this.lastSavedFull = snapshot.signatures.full;
      if (snapshot.editWrite) {
        this.savedEdit = snapshot.signatures.editing;
        this.needsEdit = this.signatures.editing !== this.savedEdit;
        this.onStateChange(this.needsEdit ? 'dirty' : 'saved');
      }
      this.runtimeDue = null;
      this._scheduleNotice();
    } catch (error) {
      this.failure = error;
      this.onStateChange('error');
      this.onError(error);
    } finally {
      this.inflight = false;
      if (!this.failure) {
        if (this.needsEdit) this._schedule(this.debounceMs);
        else if (this.signatures.full !== this.lastSavedFull) {
          if (this.runtimeDue === null) this.runtimeDue = this.now() + this.runtimeMs;
          this._schedule(Math.max(0, this.runtimeDue - this.now()));
        }
      }
      this._resolveIdle();
    }
  }

  _scheduleNotice() {
    if (this.noticeTimer || this.needsEdit || this.lastEdit === -Infinity) return;
    const quiet = this.quietMs - (this.now() - this.lastEdit);
    if (quiet > 0) {
      this.noticeTimer = this.schedule(() => {
        this.noticeTimer = null;
        this._scheduleNotice();
      }, quiet);
      return;
    }
    if (this.now() - this.lastNotice >= this.noticeMs) {
      this.lastNotice = this.now();
      this.onNotice();
    }
  }

  _resolveIdle() {
    if (this.inflight || this.timer) return;
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }
}
