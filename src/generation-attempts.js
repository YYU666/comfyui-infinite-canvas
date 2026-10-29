export class GenerationAttempts {
  constructor() { this.values = new Map(); }

  begin(id) {
    const value = (this.values.get(id) || 0) + 1;
    this.values.set(id, value);
    return value;
  }

  cancel(id) { return this.begin(id); }

  isCurrent(id, attempt) { return this.values.get(id) === attempt; }

  assert(id, attempt) {
    if (!this.isCurrent(id, attempt)) {
      const error = new Error('本次生成已取消。');
      error.code = 'GENERATION_CANCELLED';
      throw error;
    }
  }
}
