import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from './errors.js';

const execute = promisify(execFile);
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

export async function directoryPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw new ApiError(400, 'invalid_directory_target', 'Use an absolute authorized directory. No message was sent.');
  let cwd;
  try { cwd = await realpath(value); if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory'); }
  catch { throw new ApiError(400, 'invalid_directory_target', 'The authorized directory is not available. No message was sent.'); }
  return cwd;
}

// Codex Desktop's native open-path handler registers directories through its
// project manager (including folder consent). Never edit its persisted state.
async function openDirectory(cwd) {
  if (process.platform !== 'win32') throw new ApiError(501, 'directory_target_unavailable', 'Native directory registration is available on Windows only. No message was sent.');
  const script = "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -match 'OpenAI[.]Codex_[^\\\\]+\\\\app\\\\ChatGPT[.]exe$' } | Select-Object -First 1 -ExpandProperty ExecutablePath";
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
  const executable = stdout.trim();
  if (!path.isAbsolute(executable) || !/OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/i.test(executable))
    throw new ApiError(503, 'directory_target_unavailable', 'The running Codex Desktop application could not be located. No message was sent.');
  try { await execute(executable, ['--open-project', cwd], { windowsHide: true, timeout: 10000, maxBuffer: 8192 }); }
  catch { throw new ApiError(503, 'directory_registration_unconfirmed', 'Desktop did not confirm its native directory-open request. No message was sent.'); }
}

export async function resolveDirectoryTarget(value, listProjects, beforeOpen) {
  const cwd = await directoryPath(value);
  const find = async () => {
    const { projects = [] } = await listProjects();
    for (const project of projects) {
      if (project.projectKind !== 'local' || project.hostId !== 'local' || !project.path) continue;
      let actual; try { actual = await realpath(project.path); } catch { continue; }
      if (samePath(cwd, actual)) return { cwd, projectId: project.projectId, hostId: 'local' };
    }
    return null;
  };
  let target = await find();
  if (target) return target;
  beforeOpen?.();
  await openDirectory(cwd);
  const deadline = Date.now() + 10000;
  do { await delay(400); target = await find(); if (target) return target; } while (Date.now() < deadline);
  throw new ApiError(409, 'directory_registration_unconfirmed', 'The authorized folder is not yet available in Desktop projects. Any native folder-consent request remains in Desktop; no chat or message was created.',
    { cwd, requiresConfirmation: true, action: 'confirm_native_directory', promptSubmitted: false });
}

export async function matchesDirectoryTarget(actual, expected) {
  try { return samePath(await directoryPath(actual), expected); } catch { return false; }
}
