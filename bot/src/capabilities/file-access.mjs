import { resolve, basename } from 'node:path';
import { taskSource, workExecution } from '../context/sources.mjs';
import { assertPathPolicy, assertCommandPolicy } from './file-policy.mjs';

const fileNames = text => [...new Set([...text.matchAll(/(?:[A-Za-z]:[\\/][^\s`"'<>，。；：]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,16})/g)]
  .map(match => match[0].replace(/[),;]+$/, '')).filter(path => !/^https?:/i.test(path)))];
const noAccess = /(?:不要|不得|禁止|不能|不再|先不|暂不).{0,12}(?:读写|读取|读.{0,4}写|写.{0,4}读|访问)|(?:不读不写|完全不读|do\s+not\s+(?:read|write|access)|must\s+not\s+(?:read|write|access))/i;
const noBypass = /(?:不要|不得|禁止|不能).{0,24}(?:绕过|绕行)|(?:do\s+not|must\s+not|never).{0,24}(?:bypass|circumvent)/i;

/** Only authenticated original requests/steering supply user restrictions.
 * Handoff prose, peer claims and document contents cannot add or lift them.
 * Rebuild from durable causal sources after compaction or continuation.
 */
export function taskFileAccessPolicy(task, store, workspace) {
  const execution = task.workId ? workExecution(task, store) : null;
  const origin = task.workId ? store.getTask(execution.requestTaskId) : task;
  const requests = [origin, ...store.listTasks({ limit: 10000 }).filter(item => item.steeredIntoTaskId === task.id)].filter(Boolean);
  const constraints = [], originals = [];
  for (const request of requests) {
    const source = taskSource(request, store);
    if (source.actor !== 'user') continue;
    const content = typeof source.input === 'string' ? source.input : source.input?.trigger?.content;
    if (typeof content !== 'string') continue;
    originals.push(content);
    for (const sentence of content.split(/[。；;\n]+/)) if (noAccess.test(sentence))
      for (const path of fileNames(sentence)) constraints.push({ path: resolve(workspace, path), reason: 'explicit_user_file_restriction', sourceMessageId: source.replyTo || source.messageId });
  }
  const currentFiles = fileNames(originals.join('\n')).map(path => resolve(workspace, path).toLowerCase());
  const preservePrevious = originals.some(text => noBypass.test(text));
  const tasks = task.workId ? store.listTasks({ limit: 10000 }).filter(item => item.workId === task.workId) : [task];
  for (const item of tasks) {
    const sameAction = item.id === task.id || task.workId && execution.actionId && workExecution(item, store).actionId === execution.actionId;
    if (!sameAction && !preservePrevious) continue;
    for (const record of store.listTools(item.id)) {
      const error = record.error || (record.output?.isError ? record.output.details || record.output.structuredContent : null);
      const denial = error?.accessDenial;
      if (!denial?.path || error?.code !== 'FILE_ACCESS_DENIED') continue;
      if (!sameAction && !currentFiles.some(path => path === resolve(denial.path).toLowerCase() || basename(path) === basename(denial.path).toLowerCase())) continue;
      constraints.push({ ...denial, reason: 'prior_access_refusal', toolRunId: record.id });
    }
  }
  return { deniedPaths: [...new Map(constraints.map(item => [item.path.toLowerCase(), item])).values()] };
}

export async function assertFileToolAccess(name, args, task, store, workspace) {
  if (!['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'run_command'].includes(name)) return;
  const policy = taskFileAccessPolicy(task, store, workspace);
  if (name === 'run_command') await assertCommandPolicy(String(args.command || ''), resolve(workspace, args.cwd || '.'), policy, () => {});
  else assertPathPolicy(resolve(workspace, args.path || '.'), policy);
}
