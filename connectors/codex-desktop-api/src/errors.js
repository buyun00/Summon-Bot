export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export const unavailable = (message = 'Codex desktop is unavailable.') => new ApiError(503, 'desktop_unavailable', message);
export const modelPreflightUnavailable = 'desktop_model_preflight_unavailable';
export const permissionPreflightUnavailable = 'desktop_permission_preflight_unavailable';
export const permissionReadPhases = new Set(['permission-ipc-connect', 'permission-ipc-initialize', 'permission-owner', 'permission-snapshot']);
export async function readBefore(deadline, read) {
  if (!Number.isFinite(deadline)) return read();
  const timeout = () => new ApiError(503, 'preflight_read_timeout', 'Desktop did not finish the preflight read.');
  if (Date.now() >= deadline) throw timeout();
  let timer;
  try { return await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), deadline - Date.now()); })]); }
  finally { clearTimeout(timer); }
}
export function publicError(error) {
  return { code: error.code || 'internal_error', message: error.status ? error.message : 'Unexpected server error.', ...(error.details ? { details: error.details } : {}) };
}
