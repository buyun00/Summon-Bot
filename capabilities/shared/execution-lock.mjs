function abortError(signal) {
  const error = new Error(signal?.reason instanceof Error ? signal.reason.message : 'Execution cancelled');
  error.name = 'AbortError';
  return error;
}

/** One FIFO lock shared by Bot mutations and Codex work on the local checkout. */
export class ExecutionLock {
  #active = null;
  #queue = [];

  get owner() { return this.#active?.owner ?? null; }
  get pending() { return this.#queue.length; }

  async acquire(owner, signal) {
    if (signal?.aborted) throw abortError(signal);
    return new Promise((resolve, reject) => {
      const ticket = { owner, resolve, reject, signal, abort: null };
      ticket.abort = () => {
        const index = this.#queue.indexOf(ticket);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        signal.removeEventListener('abort', ticket.abort);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', ticket.abort, { once: true });
      this.#queue.push(ticket);
      this.#drain();
    });
  }

  #drain() {
    if (this.#active || !this.#queue.length) return;
    const ticket = this.#queue.shift();
    this.#active = ticket;
    ticket.signal?.removeEventListener('abort', ticket.abort);
    let released = false;
    ticket.resolve(() => {
      if (released) return;
      released = true;
      this.#active = null;
      this.#drain();
    });
  }

  async withLock(owner, fn, signal) {
    const release = await this.acquire(owner, signal);
    try {
      if (signal?.aborted) throw abortError(signal);
      return await fn();
    } finally { release(); }
  }
}
