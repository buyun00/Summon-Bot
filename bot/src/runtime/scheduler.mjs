/** Limited business slots, serial conversations, foreground before background. */
export class ConversationScheduler {
  constructor(concurrency) { this.concurrency = concurrency; this.pending = []; this.active = new Map(); this.closed = false; }
  run(key, execute, { signal, priority = 'foreground' } = {}) {
    if (this.closed) return Promise.reject(new Error('Scheduler closed'));
    return new Promise((resolve, reject) => {
      const job = { key, execute, signal, priority, resolve, reject };
      this.pending.push(job); signal?.addEventListener('abort', () => this.drain(), { once: true }); this.drain();
    });
  }
  drain() {
    for (const job of [...this.pending]) if (job.signal?.aborted || this.closed) {
      this.pending.splice(this.pending.indexOf(job), 1); job.reject(job.signal?.reason || new Error('Scheduler closed'));
    }
    while (!this.closed && this.active.size < this.concurrency) {
      const runnable = this.pending.filter(job => !this.active.has(job.key));
      const job = runnable.find(job => job.priority !== 'background') || runnable[0]; if (!job) break;
      this.pending.splice(this.pending.indexOf(job), 1);
      const promise = Promise.resolve().then(job.execute);
      this.active.set(job.key, promise);
      promise.then(job.resolve, job.reject).finally(() => { this.active.delete(job.key); this.drain(); });
    }
  }
  close() { this.closed = true; this.drain(); }
}
