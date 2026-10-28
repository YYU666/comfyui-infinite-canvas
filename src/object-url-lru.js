export class ObjectUrlLru {
  constructor(limit = 64, revoke = (url) => URL.revokeObjectURL(url)) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('LRU limit must be positive');
    this.limit = limit;
    this.revoke = revoke;
    this.entries = new Map();
  }

  get size() { return this.entries.size; }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key, pending) {
    this.delete(key);
    const entry = { pending, url: null };
    this.entries.set(key, entry);
    pending.then((url) => {
      entry.url = url;
      this.evict();
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    this.evict();
    return entry;
  }

  release(entry) {
    entry.pending.then((url) => this.revoke(url), () => {});
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.release(entry);
    return true;
  }

  evict() {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      this.delete(oldest);
    }
  }

  clear() {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
  }
}
