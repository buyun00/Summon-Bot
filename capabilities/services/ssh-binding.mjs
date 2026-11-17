import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { reject } from '../platform/contract.mjs';

const parameter = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const safeValue = /^[a-zA-Z0-9_./,:@+-]{1,256}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function operationOf(item) {
  if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.command !== 'string' ||
      !item.command.trim() || item.command.length > 4096 || /[\0\r\n]/.test(item.command)) {
    reject('invalid_ssh_binding', 'Each SSH operation requires an identity and an approved command');
  }
  const parameters = item.parameters ?? {};
  const names = new Set([...item.command.matchAll(parameter)].map(([, name]) => name));
  if (!object(parameters) || names.size !== Object.keys(parameters).length || [...names].some(name =>
    !Object.hasOwn(parameters, name) || !Array.isArray(parameters[name]) || !parameters[name].length || parameters[name].length > 128 ||
    parameters[name].some(value => typeof value !== 'string' || !safeValue.test(value)))) {
    reject('invalid_ssh_binding', 'SSH parameter templates require host-approved literal values for each field');
  }
  return { ...item, ...(names.size ? { parameters } : {}) };
}

export function sshBinding(value) {
  const { host, user, port = 22, identity_file, operations } = value ?? {};
  const hostname = typeof host === 'string' && host.toLowerCase().replace(/\.$/, '');
  if (!hostname || !isIP(hostname) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) ||
      typeof user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      identity_file !== undefined && (typeof identity_file !== 'string' || !isAbsolute(identity_file) || identity_file.includes('\0')) ||
      !Array.isArray(operations) || !operations.length || operations.length > 128)
    reject('invalid_ssh_binding', 'SSH requires a fixed host, port, account and unique allowed operations');
  const methods = operations.map(operationOf);
  if (new Set(methods.map(item => item.id)).size !== methods.length)
    reject('invalid_ssh_binding', 'SSH operation IDs must be unique');
  return { host: hostname, user, port, ...(identity_file ? { identity_file } : {}), operations: methods };
}

export function sshArguments(binding, input) {
  const parameters = input?.parameters ?? {};
  if (!object(input) || typeof input.method !== 'string' || !object(parameters) ||
      Object.keys(input).some(key => !['method', 'parameters'].includes(key)))
    reject('invalid_ssh_input', 'Choose a configured SSH method and approved parameters');
  const method = binding.operations.find(item => item.id === input.method);
  if (!method) reject('method_not_found', 'The SSH operation is not configured', 404);
  const allowed = method.parameters ?? {};
  if (Object.keys(parameters).length !== Object.keys(allowed).length || Object.entries(allowed).some(([name, values]) =>
    !Object.hasOwn(parameters, name) || !values.includes(parameters[name])))
    reject('ssh_parameter_forbidden', 'Use only the values authorized for this SSH operation', 403);
  const command = method.command.replace(parameter, (_, name) => parameters[name]);
  return ['-F', 'none', '-T', '-n', '-a', '-x',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
    '-p', String(binding.port), '-l', binding.user,
    ...(binding.identity_file ? ['-o', 'IdentitiesOnly=yes', '-i', binding.identity_file] : []),
    '--', binding.host, command];
}
