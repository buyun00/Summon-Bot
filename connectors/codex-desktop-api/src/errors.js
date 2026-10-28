export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export const unavailable = (message = 'Codex desktop is unavailable.') => new ApiError(503, 'desktop_unavailable', message);
export function publicError(error) {
  return { code: error.code || 'internal_error', message: error.status ? error.message : 'Unexpected server error.', ...(error.details ? { details: error.details } : {}) };
}
