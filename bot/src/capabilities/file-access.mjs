import { resolve, basename } from 'node:path';
import { taskSource, workExecution } from '../context/sources.mjs';
import { assertPathPolicy, assertCommandPolicy } from './file-policy.mjs';

const fileNames = text => [...new Set([...text.matchAll(/(?:[A-Za-z]:[\\/][^\s`"'<>，。；：]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,16})/g)]
  .map(match => match[0].replace(/[),;]+$/, '')).filter(path => !/^https?:/i.test(path)))];
const noBypass = /(?:不要|不得|禁止|不能).{0,24}(?:绕过|绕行)|(?:do\s+not|must\s+not|never).{0,24}(?:bypass|circumvent)/i;
const negative = /不要|不得|禁止|不能|不许|不可|切勿|别|不再|先不|暂不|完全不|不(?=读|写|访问|修改|删除)|\b(?:do\s+not|don['’]t|must\s+not|never)\b/i;
const positive = /请|允许|可以|继续|重新|\b(?:please|you\s+may|you\s+can|allowed\s+to)\b/i;
const imperative = /^\s*(?:(?:now|again)\s+|现在|这次)?(?:读取|查看|打开|写入|修改|修订|删除|\b(?:read|write|open|edit|modify|update|delete)\b)/i;
const operations = /不读不写|读写|访问|读取|读(?!成)|查看|打开|写入|改写|修改|修订|覆盖|删除|重命名|移动|写(?!成|法)|\b(?:read|write|access|open|edit|modify|update|overwrite|delete|remove|rename|move)\b/gi;
const operationKinds = word => /读写|不读不写|访问|access/i.test(word) ? ['read', 'write'] :
  /读|查看|打开|read|open/i.test(word) ? ['read'] : ['write'];
const fileOperations = name => name === 'edit_file' ? ['read', 'write'] : name === 'write_file' ? ['write'] : ['read'];
const canonical = new Set(['read_file', 'write_file', 'edit_file']);
const boundaryReasons = new Set(['outside_allowed_roots', 'protected_path', 'resolved_outside_allowed_roots', 'resolved_protected_path', 'os_permission_denied']);
const pathKey = (workspace, path) => resolve(workspace, path).toLowerCase();
const refusalCondition = /(?:若|如果|一旦|当|\bif\b|\bonce\b).{0,60}(?:拒绝|受保护|denied|refus(?:ed|al)|protected)/i;
const alternativeChannel = /(?:换(?:成|用)?|使用|用|通过|借助|切换到)\s*(?:shell\b|命令(?:行|通道))|\bshell\s*(?:来|去)?(?:读|写|访问|修改)|其他(?:通道|工具|\s*API)|另(?:一|个)种?通道|\b(?:via|use|using|with|switch\s+to)\s+(?:the\s+)?shell\b|\b(?:another|alternative|other)\s+(?:tool|api|channel)\b/i;
const excludedSubject = /(?:这份|该|这个|此|它|\b(?:this|that)\b)\s*(?:文件|材料|file|document)?\s*(?:以外|之外)|\b(?:except(?:\s+for)?|other\s+than|outside\s+(?:this|that)\s+file)\b/i;
const directiveTargets = text => fileNames(text).filter(name => {
  const index = text.indexOf(name), before = text.slice(0, index), after = text.slice(index + name.length);
  return !/(?:以外|之外)(?:的|$)/.test(name) && !/^\s*[`"']*\s*(?:以外|之外)/.test(after) &&
    !/(?:除(?:了)?|\bexcept(?:\s+for)?|\bother\s+than)\s*[`"']*\s*$/i.test(before);
});

// Restrict explicit file-access clauses, not every filename in a sentence.
// Within a clause each verb binds the following targets; adjacent verbs may
// share a target. Pronouns use the preceding named subject, never a later file.
function fileDirectives(content) {
  const result = []; let previous = [], lastDirective;
  for (const sentence of content.split(/[。；;\n]+/)) {
    let afterRefusal = false;
    for (const clause of sentence.split(/[，,]+|\b(?:but|however)\b|(?:但是|但)(?=可以|允许|请|继续)/i)) {
      const names = fileNames(clause), refusal = negative.exec(clause), permit = !refusal && (positive.exec(clause) || imperative.exec(clause));
      const marker = refusal || permit;
      afterRefusal ||= refusalCondition.test(clause);
      // A condition on a future refusal is not a present file prohibition. Real
      // refusals below supply the alternate-channel guard after they occur.
      if (marker && !(refusal && afterRefusal)) {
        const action = clause.slice(marker.index), verbs = [...action.matchAll(operations)];
        let pending = [];
        for (let i = 0; i < verbs.length; i++) {
          const verb = verbs[i], fragment = action.slice(verb.index + verb[0].length, verbs[i + 1]?.index);
          pending.push(...operationKinds(verb[0]));
          let targets = directiveTargets(fragment);
          if (!targets.length && i === verbs.length - 1) {
            targets = directiveTargets(clause.slice(0, marker.index));
            // In “do not read anything other than this file”, this file is the
            // excluded subject of the ban, not the target of that prohibition.
            if (!targets.length && !excludedSubject.test(fragment) && /它|该文件|这份|\bit\b|this\s+file/i.test(fragment)) targets = previous.slice(-1);
          }
          if (targets.length) { lastDirective = { targets, operations: [...new Set(pending)], denied: Boolean(refusal),
            alternativesOnly: alternativeChannel.test(clause) }; result.push(lastDirective); pending = []; }
        }
      } else if (!marker && !afterRefusal && names.length && lastDirective) {
        const rest = names.reduce((value, name) => value.replace(name, ''), clause).replace(/\b(?:and|or)\b|[、和及与\s`"']/gi, '');
        if (!rest) { lastDirective = { ...lastDirective, targets: names }; result.push(lastDirective); }
      }
      if (names.length) previous = names;
    }
  }
  return result;
}

/** Only authenticated original requests/steering supply user restrictions.
 * Handoff prose, peer claims and document contents cannot add or lift them.
 * Rebuild from durable causal sources after compaction or continuation.
 */
export function taskFileAccessPolicy(task, store, workspace) {
  const execution = task.workId ? workExecution(task, store) : null;
  const origin = task.workId ? store.getTask(execution.requestTaskId) : task;
  const requests = [origin, ...store.listTasks({ limit: 10000 }).filter(item => item.steeredIntoTaskId === task.id)].filter(Boolean);
  const constraints = [], originals = [], userRules = new Map();
  for (const request of requests) {
    const source = taskSource(request, store);
    if (source.actor !== 'user') continue;
    const form = source.formId && source.input?.originalRequest?.content;
    const content = form ? [form.goal, form.constraints].filter(Boolean).join('\n') :
      typeof source.input === 'string' ? source.input : source.input?.trigger?.content;
    if (typeof content !== 'string') continue;
    originals.push(content);
    for (const directive of fileDirectives(content)) for (const path of directive.targets) {
      const key = JSON.stringify([pathKey(workspace, path), directive.alternativesOnly]), prior = userRules.get(key), denied = new Set(prior?.operations || []);
      for (const operation of directive.operations) if (directive.denied) denied.add(operation); else denied.delete(operation);
      userRules.set(key, { path: resolve(workspace, path), reason: 'explicit_user_file_restriction', operations: [...denied],
        ...(directive.alternativesOnly ? { alternativesOnly: true } : {}), sourceMessageId: source.replyTo || source.messageId });
    }
  }
  constraints.push(...[...userRules.values()].filter(rule => rule.operations.length));
  const currentFiles = fileNames(originals.join('\n')).map(path => resolve(workspace, path).toLowerCase());
  const preservePrevious = originals.some(text => noBypass.test(text));
  const tasks = task.workId ? store.listTasks({ limit: 10000 }).filter(item => item.workId === task.workId) : [task];
  const sameAction = item => item.id === task.id || Boolean(task.workId && execution.actionId && workExecution(item, store).actionId === execution.actionId);
  const rechecks = tasks.filter(sameAction).flatMap(item => store.listTools(item.id)).filter(record => record.status === 'completed' && canonical.has(record.name));
  for (const item of tasks) {
    const current = sameAction(item);
    if (!current && !preservePrevious) continue;
    for (const record of store.listTools(item.id)) {
      const error = record.error || (record.output?.isError ? record.output.details || record.output.structuredContent : null);
      const denial = error?.accessDenial;
      if (!denial?.path || error?.code !== 'FILE_ACCESS_DENIED') continue;
      const originReason = denial.originReason || denial.reason;
      if (!boundaryReasons.has(originReason)) continue;
      if (!current && !currentFiles.some(path => path === pathKey(workspace, denial.path) || basename(path) === basename(denial.path).toLowerCase())) continue;
      // The original file tool may legitimately recheck permissions. Only its
      // actual success after the refusal releases that operation's shell guard;
      // a new user/peer assertion by itself cannot override the real boundary.
      const remaining = ['read', 'write'].filter(operation => !rechecks.some(check => fileOperations(check.name).includes(operation) &&
        Date.parse(check.finishedAt) > Date.parse(record.finishedAt) &&
        [check.args?.path, check.output?.details?.path, check.output?.structuredContent?.path].some(path => typeof path === 'string' && pathKey(workspace, path) === pathKey(workspace, denial.path))));
      if (remaining.length) constraints.push({ ...denial, operations: remaining, alternativesOnly: true, reason: 'prior_access_refusal', originReason, toolRunId: record.id });
    }
  }
  return { deniedPaths: [...new Map(constraints.map(item => [JSON.stringify([item.path.toLowerCase(), item.operations, Boolean(item.alternativesOnly), item.originReason]), item])).values()] };
}

export async function assertFileToolAccess(name, args, task, store, workspace) {
  if (!['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'run_command', 'publish_file'].includes(name)) return;
  const policy = taskFileAccessPolicy(task, store, workspace);
  if (name === 'run_command') await assertCommandPolicy(String(args.command || ''), resolve(workspace, args.cwd || '.'), policy, () => {});
  else assertPathPolicy(resolve(workspace, args.path || '.'), policy, { operations: fileOperations(name), alternative: name === 'publish_file' });
}
