import net from 'node:net';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

const handshakeError = (message, code) => Object.assign(new Error(message), { code });
const retryableHandshake = new Set(['IDENTITY_HANDSHAKE_INCOMPLETE', 'ECONNRESET', 'EPIPE']);

function addressFor(instanceDir) {
  let identity = realpathSync.native(instanceDir);
  if (process.platform === 'win32') identity = identity.toLowerCase();
  const hash = createHash('sha256').update(identity).digest('hex');
  // Named pipes are held by the kernel and disappear even on a hard process crash.
  if (process.platform === 'win32') return `\\\\.\\pipe\\relay-bot-instance-${hash.slice(0, 40)}`;
  // The Linux abstract socket namespace also has no stale filesystem entry.
  if (process.platform === 'linux') return `\0relay-bot-instance-${hash.slice(0, 40)}`;
  // Other platforms use an exclusive loopback listener. A hash collision fails
  // closed; it can never allow two owners for the same instance.
  return { host: '127.0.0.1', port: 30000 + (parseInt(hash.slice(0, 8), 16) % 25000) };
}

function queryIdentity(address, timeoutMs = 1200, strict = false) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const socket = net.createConnection(address);
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (strict && error && !['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
        const failure = new Error('Instance identity could not be verified; do not infer that its data is inactive', { cause: error });
        failure.code = 'INSTANCE_IDENTITY_UNAVAILABLE';
        reject(failure);
      } else resolve(value);
    };
    // An idle timeout can be prolonged forever by incomplete trickle data.
    const timer = setTimeout(() => finish(null, handshakeError('Identity handshake timed out', 'IDENTITY_HANDSHAKE_TIMEOUT')), timeoutMs);
    socket.on('error', error => finish(null, error));
    socket.on('end', () => finish(null, handshakeError('Identity handshake ended without a response', 'IDENTITY_HANDSHAKE_INCOMPLETE')));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 16384) return finish(null, new Error('Identity handshake exceeds the size limit'));
      if (data.includes('\n')) {
        try {
          const identity = JSON.parse(data.split('\n')[0]);
          if (!identity || typeof identity !== 'object' || Array.isArray(identity) || identity.protocol !== 'relay-instance-lock-v1') {
            throw handshakeError('Instance lock is occupied by an unknown protocol; stopped state cannot be verified', 'IDENTITY_PROTOCOL_INVALID');
          }
          finish(identity);
        } catch (error) { finish(null, error); }
      }
    });
  });
}

export async function inspectInstanceIdentity(instanceDir) {
  let address;
  try {
    address = addressFor(instanceDir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const deadline = Date.now() + 1200;
  for (let attempt = 0; ; attempt++) {
    try { return await queryIdentity(address, Math.max(1, deadline - Date.now()), true); }
    catch (error) {
      // Shutdown can interrupt an accepted connection. Reconnect to the OS-held
      // endpoint; never turn an incomplete response itself into a stopped result.
      if (attempt >= 2 || !retryableHandshake.has(error.cause?.code) || Date.now() + 25 >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export async function acquireIdentityLock(instanceDir, getIdentity) {
  const address = addressFor(instanceDir);
  const sockets = new Set();
  let closing;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.end(`${JSON.stringify({ protocol: 'relay-instance-lock-v1', ...getIdentity() })}\n`);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (cause) {
    if (!['EADDRINUSE', 'EACCES'].includes(cause.code)) throw cause;
    const existing = await queryIdentity(address);
    const error = new Error(existing?.protocol === 'relay-instance-lock-v1'
      ? `Instance already running (PID ${existing.pid}, boot ${existing.bootId})`
      : 'Instance startup lock is occupied; identity handshake unavailable');
    error.code = existing?.protocol === 'relay-instance-lock-v1' ? 'INSTANCE_ALREADY_RUNNING' : 'INSTANCE_LOCK_UNAVAILABLE';
    error.existing = existing;
    error.cause = cause;
    throw error;
  }
  server.on('error', () => {});
  return {
    address,
    unref() { server.unref(); },
    close() {
      return closing ||= new Promise(resolve => {
        if (!server.listening) return resolve();
        // Stop accepting first, then allow the already-written identity frames
        // to drain. A peer that never closes cannot hold shutdown indefinitely.
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 250);
        timer.unref();
        server.close(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
