import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ApiError, unavailable } from './errors.js';

export function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  constructor(maxBytes = 64 * 1024 * 1024) { this.maxBytes = maxBytes; this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE();
      if (length < 2 || length > this.maxBytes) throw new Error('Invalid desktop frame size.');
      if (this.buffer.length < length + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }
}

export class FramedPipe extends EventEmitter {
  constructor(path, { maxBytes, timeoutMs = 15000 } = {}) {
    super();
    this.path = path; this.timeoutMs = timeoutMs; this.decoder = new FrameDecoder(maxBytes);
    this.pending = new Map(); this.connected = false;
  }
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      this.decoder.buffer = Buffer.alloc(0);
      const socket = this.socket = net.createConnection(this.path);
      const timer = setTimeout(() => socket.destroy(new Error('Connection timed out.')), this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); this.connected = true; resolve(); });
      socket.on('data', chunk => {
        try { for (const message of this.decoder.push(chunk)) this.receive(message); }
        catch (error) { socket.destroy(error); }
      });
      socket.on('error', error => { clearTimeout(timer); reject(unavailable(error.message)); });
      socket.on('close', () => {
        clearTimeout(timer); this.connected = false;
        reject(unavailable());
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new ApiError(503, 'connection_lost', 'Desktop connection closed; a submitted operation may have completed.', { outcome: 'unknown' }));
        }
        this.pending.clear(); this.emit('disconnected');
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  receive(message) {
    const id = message.requestId ?? message.id;
    const pending = this.pending.get(id);
    if (pending && (message.type === 'response' || ('jsonrpc' in message && ('result' in message || 'error' in message)))) {
      clearTimeout(pending.timer); this.pending.delete(id);
      if (message.resultType === 'error' || message.error) {
        pending.reject(new ApiError(502, 'desktop_error', typeof message.error === 'string' ? message.error : message.error.message));
      } else pending.resolve(message);
    } else this.emit('message', message);
  }
  send(message) {
    if (!this.connected || this.socket.destroyed) throw unavailable();
    this.socket.write(encodeFrame(message));
  }
  request(message, timeoutMs = this.timeoutMs) {
    const id = message.requestId ?? message.id ?? randomUUID();
    if (!this.connected) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError(504, 'desktop_timeout', 'Desktop did not confirm the operation before timeout. Do not retry with a new idempotency key.', { outcome: 'unknown' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send(message); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { this.socket?.destroy(); }
}
