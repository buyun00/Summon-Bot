const serviceTypes = ['gateway', 'web'];
const scrub = value => String(value || '').slice(0, 1000)
  .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[redacted]')
  .replace(/\b(token|api[_-]?key|authorization|password|secret)(\s*[:=]\s*)(["']?)[^\s,;"']+\3/gi, '$1$2[redacted]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');

function diagnostic(error, depth = 0) {
  if (!error || depth >= 4) return undefined;
  return { name: scrub(error.name || 'Error'), code: error.code === undefined ? undefined : scrub(error.code),
    message: scrub(error.message || error), ...(error.cause ? { cause: diagnostic(error.cause, depth + 1) } : {}) };
}
const classification = error => error && { name: error.name, code: error.code, cause: classification(error.cause) };
const writeEvent = event => process.stdout.write(`${JSON.stringify(event)}\n`);

/** Observe existing services only. Uncertain identity never authorizes a restart. */
export function superviseServices({ inspect, shutdown, report = writeEvent, signals = process, intervalMs = 5000 } = {}) {
  if (typeof inspect !== 'function' || typeof shutdown !== 'function') throw new TypeError('Service supervision requires inspect and shutdown functions');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Supervision interval must be a positive integer');
  return new Promise((accept, reject) => {
    const previous = new Map(); let timer, pending, stopping = false, finished = false;
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(timer);
      signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
      error ? reject(error) : accept();
    };
    const announce = (type, service, details = {}) => report({ type, at: new Date().toISOString(), service, ...details });
    const schedule = () => { if (!stopping && !finished) timer = setTimeout(check, intervalMs); };
    async function check() {
      timer = undefined;
      try {
        // inspectService already bounds identity and HTTP handshakes. Serial
        // rounds prevent slow checks from stacking or racing signal shutdown.
        const current = Promise.allSettled(serviceTypes.map(type => Promise.resolve().then(() => inspect(type))));
        pending = current; const results = await current; if (pending === current) pending = undefined;
        if (stopping || finished) return;
        for (let index = 0; index < serviceTypes.length; index++) {
          const service = serviceTypes[index], result = results[index], prior = previous.get(service);
          const state = result.status === 'fulfilled' ? result.value?.state : 'unknown';
          if (state === 'stopped') {
            announce('service.monitor.stopped', service, { state: 'stopped' });
            return finish(Object.assign(new Error(`${service} is confirmed stopped; inspect managed service logs`), { code: 'SERVICE_STOPPED', service }));
          }
          if (state === 'ready') {
            if (prior && prior !== 'ready') announce('service.monitor.recovered', service, { state: 'ready' });
            previous.set(service, 'ready'); continue;
          }
          const error = result.status === 'rejected' ? diagnostic(result.reason) : undefined;
          const observed = ['starting', 'stopping', 'unreachable'].includes(state) ? state : 'unknown';
          const key = JSON.stringify({ state: observed, error: classification(error) });
          if (key !== prior) announce('service.monitor.warning', service, { state: observed, action: 'retain-and-recheck', ...(error ? { error } : {}) });
          previous.set(service, key);
        }
        schedule();
      } catch (error) { finish(error); }
    }
    async function stop() {
      if (stopping || finished) return;
      stopping = true; clearTimeout(timer);
      try {
        // Stop owns shutdown once. An already-running, bounded observation is
        // allowed to finish but cannot report, reschedule, or reject afterward.
        await pending; await shutdown(); finish();
      } catch (error) { finish(error); }
    }
    signals.on('SIGINT', stop); signals.on('SIGTERM', stop); schedule();
  });
}
