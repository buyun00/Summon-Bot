import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { ExecutionLock } from './execution-lock.mjs';

// The kernel owns this lock for the whole mutation, including Codex work.
// It survives neither a crash nor PID reuse, and needs no central broker.
export class WorkspaceExecutionLock extends ExecutionLock {
  constructor(cwd) {
    super();
    const physical = realpathSync(resolve(cwd));
    const canonical = process.platform === 'win32' ? physical.toLowerCase() : physical;
    const key = createHash('sha256').update(canonical).digest('hex').slice(0, 40);
    this.endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\relay-workspace-${key}` :
      process.platform === 'linux' ? `\0relay-workspace-${key}` : join(tmpdir(), `relay-workspace-${key}.sock`);
  }
  async acquire(owner, signal) {
    const releaseLocal = await super.acquire(owner, signal);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const server = createServer(socket => socket.end());
        const locked = await new Promise((resolveReady, reject) => {
          server.once('error', error => error.code === 'EADDRINUSE' ? resolveReady(false) : reject(error));
          server.listen(this.endpoint, () => resolveReady(true));
        });
        if (locked) {
          let released = false;
          return () => {
            if (released) return;
            released = true;
            server.close(releaseLocal);
          };
        }
        await new Promise(done => setTimeout(done, 40));
      }
    } catch (error) { releaseLocal(); throw error; }
  }
}
