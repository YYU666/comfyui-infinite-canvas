// Only small server derivatives pass through this queue. Browser HTTP caching
// still revalidates ETags; object URLs live only while visible subscribers exist.
export class ThumbnailLoader {
  constructor({ fetcher = (...args) => fetch(...args), createUrl = (blob) => URL.createObjectURL(blob),
    revokeUrl = (url) => URL.revokeObjectURL(url), retryDelays = [300, 900] } = {}) {
    Object.assign(this, { fetcher, createUrl, revokeUrl, retryDelays });
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
  }

  subscribe(url, onLoad, onError) {
    let job = this.jobs.get(url);
    if (!job) {
      job = { url, subscribers: new Set(), controller: new AbortController(), state: 'queued' };
      this.jobs.set(url, job);
      this.queue.push(job);
    }
    const subscriber = { onLoad, onError };
    job.subscribers.add(subscriber);
    if (job.state === 'done') onLoad(job.objectUrl);
    this.pump();
    return () => {
      job.subscribers.delete(subscriber);
      if (job.subscribers.size) return;
      if (this.jobs.get(url) === job) this.jobs.delete(url);
      job.controller.abort();
      this.queue = this.queue.filter((queued) => queued !== job);
      if (job.objectUrl) this.revokeUrl(job.objectUrl);
    };
  }

  pump() {
    while (this.running < 2 && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      job.state = 'loading';
      void this.run(job).finally(() => { this.running--; this.pump(); });
    }
  }

  async run(job) {
    const { signal } = job.controller;
    try {
      let response;
      for (let attempt = 0; ; attempt++) {
        response = await this.fetcher(job.url, { signal });
        signal.throwIfAborted();
        if (response.status !== 503 || attempt >= this.retryDelays.length) break;
        await response.body?.cancel();
        await this.delay(this.retryDelays[attempt], signal);
      }
      if (!response.ok) throw new Error('缩略图读取失败');
      const blob = await response.blob();
      signal.throwIfAborted();
      job.objectUrl = this.createUrl(blob);
      job.state = 'done';
      for (const subscriber of job.subscribers) subscriber.onLoad(job.objectUrl);
    } catch (error) {
      if (this.jobs.get(job.url) === job) this.jobs.delete(job.url);
      if (!signal.aborted) for (const subscriber of job.subscribers) subscriber.onError(error);
    }
  }

  delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export const thumbnailLoader = new ThumbnailLoader();
