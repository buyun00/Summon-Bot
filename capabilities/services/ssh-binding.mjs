import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { reject } from '../platform/contract.mjs';

const parameter = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function operationOf(item) {
  if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.command !== 'string' ||
      !item.command.trim() || item.command.length > 16_384 || item.command.includes('\0')) {
    reject('invalid_ssh_binding', 'Each SSH operation requires an identity and a command');
  }
  const parameters = item.parameters ?? {};
  if (!object(parameters)) reject('invalid_ssh_binding', 'SSH operation parameters must be an object');
  return { ...item, ...(Object.keys(parameters).length ? { parameters } : {}) };
}

export function sshBinding(value) {
  const { host, user, port = 22, identity_file, operations = [] } = value ?? {};
  const hostname = typeof host === 'string' && host.toLowerCase().replace(/\.$/, '');
  if (!hostname || !isIP(hostname) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) ||
      typeof user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      identity_file !== undefined && (typeof identity_file !== 'string' || !isAbsolute(identity_file) || identity_file.includes('\0')) ||
      !Array.isArray(operations) || operations.length > 128)
    reject('invalid_ssh_binding', 'SSH requires a host, port, and user account');
  const methods = operations.map(operationOf);
  if (new Set(methods.map(item => item.id)).size !== methods.length)
    reject('invalid_ssh_binding', 'SSH operation IDs must be unique');
  return { host: hostname, user, port, ...(identity_file ? { identity_file } : {}), operations: methods };
}

export function sshArguments(binding, input) {
  let command;
  if (typeof input === 'string') {
    command = input;
  } else if (object(input) && typeof input.command === 'string' && input.command.trim()) {
    command = input.command;
  } else {
    const parameters = input?.parameters ?? {};
    if (!object(input) || typeof input.method !== 'string' || !object(parameters))
      reject('invalid_ssh_input', 'Supply a command string or a configured SSH method');
    const method = (binding.operations || []).find(item => item.id === input.method);
    if (!method) reject('method_not_found', 'The SSH operation is not configured', 404);
    command = method.command.replace(parameter, (_, name) => {
      if (!Object.hasOwn(parameters, name) || !['string', 'number', 'boolean'].includes(typeof parameters[name]))
        reject('invalid_ssh_input', `Missing SSH parameter ${name}`);
      return String(parameters[name]);
    });
  }
  if (!command || command.includes('\0') || command.length > 32_768)
    reject('invalid_ssh_input', 'SSH command must be a non-empty string without NUL');
  return ['-T', '-n', '-o', 'BatchMode=yes',
    '-p', String(binding.port), '-l', binding.user,
    ...(binding.identity_file ? ['-o', 'IdentitiesOnly=yes', '-i', binding.identity_file] : []),
    '--', binding.host, command];
}
