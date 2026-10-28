import { ApiError } from './errors.js';
export const bad = message => { throw new ApiError(400, 'invalid_request', message); };
export function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('Expected a JSON object.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`Unknown field: ${key}`);
  return value;
}
export function string(value, name, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) bad(`${name} must be a nonempty string of at most ${max} characters.`);
  return value;
}
export function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) bad(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
export function boolean(value, name) { if (typeof value !== 'boolean') bad(`${name} must be boolean.`); return value; }
export function threadId(value) { string(value, 'threadId', 128); if (!/^[a-zA-Z0-9_-]+$/.test(value)) bad('Invalid threadId.'); return value; }
export function hostId(value = 'local') { string(value, 'hostId', 256); if (!/^[a-zA-Z0-9._:-]+$/.test(value)) bad('Invalid hostId.'); return value; }
export function modelOptions(body) {
  if (body.model !== undefined) string(body.model, 'model', 128);
  if (body.thinking !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(body.thinking)) bad('Invalid thinking value.');
}
export function createBody(body) {
  object(body, ['prompt', 'title', 'target', 'model', 'thinking']); string(body.prompt, 'prompt', 100000);
  if (body.title !== undefined) string(body.title, 'title', 200);
  modelOptions(body);
  body.target ??= { type: 'projectless' };
  if (body.target.type === 'projectless') {
    object(body.target, ['type', 'directoryName']);
    if (body.target.directoryName !== undefined) {
      string(body.target.directoryName, 'directoryName', 100);
      if (!/^[\p{L}\p{N}_ -]+$/u.test(body.target.directoryName)) bad('directoryName must be a simple folder name.');
    }
  } else if (body.target.type === 'project') {
    object(body.target, ['type', 'projectId', 'environment']); string(body.target.projectId, 'projectId', 512);
    body.target.environment ??= { type: 'local' };
    object(body.target.environment, ['type']);
    if (body.target.environment.type !== 'local') bad('V1 creates tasks in existing projects or projectless folders; worktree creation is not exposed.');
  } else bad('target.type must be project or projectless.');
  return body;
}
