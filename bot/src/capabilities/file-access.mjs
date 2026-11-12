import { resolve, basename, extname, parse } from 'node:path';
import { taskSource, workExecution } from '../context/sources.mjs';
import { assertPathPolicy, assertCommandPolicy, filePathKey, resolveFilePath, samePath } from './file-policy.mjs';

const localStart = /^(?:[A-Za-z]:[\\/]|[/\\]{2}[^/\\]|\/|\.{1,2}[\\/])/;
const localRelative = /^(?:[^:/\\]+[/\\][^/\\]+|[^:/\\]+\.[\p{L}\p{N}]{1,16})$/u;
const pathPattern = /\x60([^\x60\r\n]+)\x60|"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’|(?<![\p{L}\p{N}:/\\])((?:[A-Za-z]:[\\/]|[/\\]{2}[^/\\]|\/|\.{1,2}[\\/])[^\r\n\x60"'<>，。；！？、,;]+)/gu;

function pathMentions(text) {
  return [...text.matchAll(pathPattern)].flatMap(match => {
    const quoted = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    const path = (quoted ?? match[6]?.replace(/[)\]}>]+$/, ''))?.trim();
    if (!path || /^(?:https?|file):/i.test(path) || !localStart.test(path) && !(quoted && localRelative.test(path))) return [];
    return [{ path, start: match.index, end: match.index + match[0].length }];
  });
}

const fileNames = text => [...new Set([...pathMentions(text).map(item => item.path),
  ...[...text.replace(pathPattern, ' ').matchAll(/(?<![\w./\\:])[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,16}\b/g)].map(match => match[0])])];
const noBypass = /(?:不要|不得|禁止|不能).{0,24}(?:绕过|绕行)|(?:do\s+not|must\s+not|never).{0,24}(?:bypass|circumvent)/i;
const negative = /不要|不得|禁止|不能|不许|不可|切勿|别|不再|先不|暂不|完全不|不(?=读|写|访问|修改|删除|运行|执行|发布)|拒绝|\b(?:do\s+not|don['’]t|must\s+not|never|deny|refuse)\b/i;
const positive = /请|允许|可以|继续|重新|\b(?:please|you\s+may|you\s+can|allowed\s+to)\b/i;
const imperative = /^\s*(?:(?:now|again)\s+|现在|这次)?(?:读取|查看|打开|写入|修改|修订|删除|\b(?:read|write|open|edit|modify|update|delete)\b)/i;
const operations = /不读不写|读写|访问|读取|读(?!成)|查看|打开|写入|改写|修改|修订|覆盖|删除|重命名|移动|写(?!成|法)|执行|运行|调用|发布|上传|\b(?:read|write|access|open|edit|modify|update|overwrite|delete|remove|rename|move|run|execute|publish|upload)\b/gi;
const operationKinds = word => /访问|access/i.test(word) ? ['read', 'write', 'execute', 'publish'] :
  /读写|不读不写/i.test(word) ? ['read', 'write', 'publish'] :
  /读|查看|打开|read|open/i.test(word) ? ['read', 'publish'] :
  /执行|运行|调用|run|execute/i.test(word) ? ['execute'] :
  /发布|上传|publish|upload/i.test(word) ? ['publish'] : ['write'];
const fileOperations = name => name === 'edit_file' ? ['read', 'write'] :
  name === 'write_file' ? ['write'] : name === 'publish_file' ? ['read', 'publish'] : ['read'];
const canonical = new Set(['read_file', 'write_file', 'edit_file']);
const boundaryReasons = new Set(['outside_allowed_roots', 'operation_not_granted', 'protected_path', 'resolved_outside_allowed_roots',
  'resolved_protected_path', 'os_permission_denied', 'unresolved_reparse_point']);
const pathKey = (workspace, path) => filePathKey(resolve(workspace, path));
const refusalCondition = /(?:若|如果|一旦|当|\bif\b|\bonce\b).{0,60}(?:拒绝|受保护|denied|refus(?:ed|al)|protected)/i;
const alternativeChannel = /(?:换(?:成|用)?|使用|用|通过|借助|切换到)\s*(?:shell\b|命令(?:行|通道))|\bshell\s*(?:来|去)?(?:读|写|访问|修改)|其他(?:通道|工具|\s*API)|另(?:一|个)种?通道|\b(?:via|use|using|with|switch\s+to)\s+(?:the\s+)?shell\b|\b(?:another|alternative|other)\s+(?:tool|api|channel)\b/i;
const excludedSubject = /(?:这份|该|这个|此|它|\b(?:this|that)\b)\s*(?:文件|材料|file|document)?\s*(?:以外|之外)|\b(?:except(?:\s+for)?|other\s+than|outside\s+(?:this|that)\s+file)\b/i;
const directiveTargets = text => fileNames(text).filter(name => {
  const index = text.indexOf(name), before = text.slice(0, index), after = text.slice(index + name.length);
  return !/(?:以外|之外)(?:的|$)/.test(name) && !/^\s*[`"']*\s*(?:以外|之外)/.test(after) &&
    !/(?:除(?:了)?|\bexcept(?:\s+for)?|\bother\s+than)\s*[`"']*\s*$/i.test(before);
});

const scopeFields = { inputs: 'input', executables: 'executable', outputDirectories: 'output-directory', outputFiles: 'output-file' };
const purposeOperations = { cwd: ['read'], input: ['read'], executable: ['execute'], 'output-directory': ['read', 'write', 'publish'], 'output-file': ['read', 'write', 'publish'] };
const purposeKinds = { cwd: 'directory', input: 'existing', executable: 'file', 'output-directory': 'directory', 'output-file': 'file' };
const scopeLabel = /(?:工作目录|项目目录|运行目录|执行目录|工程目录|仓库目录|仓库)\s*(?:是|在|为|用|设为)?|\b(?:working|project|repository)\s+directory\s*(?:is|:|=)?/i;
const inputLabel = /(?:素材|输入(?:资料|目录|文件)?|原件|原图|补片|数据|资料|来源)(?:目录|文件|位置|路径|夹)?\s*(?:都在|在|是|位于|为|来自|用|[:：=])|(?:读取|查看|打开|读)\s*(?:这个|这份|这些|目录|文件|路径|素材|资料|下的)*\s*|\b(?:read|open|inspect|use input|input\s+(?:is|at|in|from)|(?:files|materials|inputs|assets)\s+(?:are\s+)?(?:at|in|from))\s*/i;
const executableLabel = /(?:执行|调用|运行|使用)\s*(?:工具|程序|可执行文件|入口)?\s*|(?:便携版入口|程序入口|工具入口|可执行(?:文件|入口)|入口)\s*(?:在|是|为|用|[:：=])|\b(?:execute|run|invoke|executable\s*(?:is|at|:|=)|entry\s+point\s*(?:is|at|:|=))\s*/i;
const outputLabel = /(?:保存|放|写入|写|输出|生成|交付|导出|打包|存)(?:到|进|在|至|入)?\s*(?:这个|目录|文件)?|(?:结果|输出|交付)(?:目录|文件|路径|位置)\s*(?:是|为|[:：=])|(?:创建|新建|建立)\s*(?:一个|这个)?\s*(?:目录|文件夹)|\b(?:save|write|put|export|deliver|output)\s*(?:to|in|under|at|:|=)|\b(?:output|destination)\s+(?:directory|file|path)\s*(?:is|:|=)?/i;
const conditionalMention = /(?:例如|举例|假如|如果|要是|假设|引用|转述|报错|未经|等.+(?:确认|批准|授权)|以后再|稍后再|(?:他|她|有人|对方|日志|工具|助手).{0,12}(?:说|写道|声称|提到)|\b(?:example|e\.g\.|if|suppose|quoted|hypothetical|once approved|(?:he|she|they|the log) said)\b)/i;

function namedFileScopes(text) {
  let previous = 0;
  return pathMentions(text).flatMap(({ path, start, end }) => {
    const leading = text.slice(previous, start);
    previous = end;
    const clause = leading.split(/[，,。；;！？!?\r\n]+/).at(-1).trimEnd();
    if (negative.test(clause) || conditionalMention.test(clause)) return [];
    const role = [[scopeLabel, 'cwd'], [inputLabel, 'input'], [executableLabel, 'executable'], [outputLabel, 'output']]
      .find(([pattern]) => new RegExp('(?:' + pattern.source + ')\\s*(?:[:：=]\\s*)?$', 'i').test(clause))?.[1];
    if (!role) return [];
    const explicitFile = /(?:输出|结果|交付)文件|\b(?:output|destination)\s+file\b/i.test(clause);
    const explicitDirectory = /(?:目录|文件夹)\s*(?:是|为)?\s*[:：]?$|\bdirectory\s*(?:is)?\s*:?$/i.test(clause);
    const purpose = role === 'output' ? explicitFile || !explicitDirectory && !/[\\/]$/.test(path) && extname(path)
      ? 'output-file' : 'output-directory' : role;
    return [{ path, purpose }];
  });
}

export function workFormFileScope(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(scopeFields, key)))
    throw Object.assign(new Error('请按用途分别提供输入资料、可执行文件和输出位置。'), { status: 400 });
  const scope = {};
  for (const key of Object.keys(scopeFields)) {
    const paths = value[key];
    if (paths === undefined) continue;
    if (!Array.isArray(paths) || paths.length > 24 || paths.some(path =>
      typeof path !== 'string' || !path.trim() || path.length > 2048 || path.includes('\0')))
      throw Object.assign(new Error('每项文件授权需要有效的本机文件或目录路径。'), { status: 400 });
    if (paths.length) scope[key] = [...new Set(paths.map(path => path.trim()))];
  }
  return scope;
}

function authenticatedFileSource(task, store) {
  const saved = task?.id && store.getTask(task.id);
  const accepted = saved?.messageId && store.getMessage(saved.messageId);
  if (!saved || accepted?.taskId !== saved.id || accepted.from !== 'controller' ||
    accepted.kind !== 'request' || accepted.metadata?.actor !== 'user') return null;
  const source = taskSource(saved, store), trigger = source.input?.trigger;
  if (source.formId) {
    const form = source.input?.originalRequest?.content;
    if (!form || typeof form.goal !== 'string') return null;
    return { ...source, text: [form.goal, form.constraints].filter(Boolean).join('\n'),
      scopes: Object.entries(scopeFields).flatMap(([key, purpose]) => (form.fileScope?.[key] || []).map(path => ({ path, purpose }))) };
  }
  if (saved.workId && source.input?.type === 'user-work-input' &&
    accepted.sourceMessageId?.startsWith('work-input:' + saved.workId + ':') && typeof source.input.instruction === 'string')
    return { ...source, text: source.input.instruction, replyTo: null };
  if (source.input?.peerAnswer || source.roomId && (trigger?.senderId !== 'user' || trigger.id !== source.replyTo) ||
    typeof (trigger?.content ?? source.input) !== 'string') return null;
  return { ...source, text: trigger?.content ?? source.input };
}

export function sourceFileScopes(task, store) {
  const source = authenticatedFileSource(task, store);
  return source ? [...namedFileScopes(source.text), ...(source.scopes || [])] : [];
}

export const WORK_FILE_ACCESS = 'work-file-access';
export const WORK_FILE_ANSWERS = 'work-file-answers';
export function fileAccessAnswer(value) {
  return /^(?:允许|allow)$/i.test(value) ? 'allowed' : /^(?:拒绝|deny)$/i.test(value) ? 'denied' : null;
}

function recordedFileDenial(record) {
  return record.error?.accessDenial || record.output?.details?.accessDenial ||
    record.output?.structuredContent?.accessDenial;
}

export function pendingFileScope(task, store, base, path) {
  const execution = workExecution(task, store);
  const origin = authenticatedFileSource(store.getTask(execution.requestTaskId), store);
  if (!origin || !execution.actionId || !execution.executionEventId) return null;
  const requested = resolveFilePath(base, path);
  const earlier = carriedFileSources(origin, execution.authorization?.production, store);
  if (requested === parse(requested).root || ![...earlier, origin].some(source =>
    [...pathMentions(source.text), ...(source.scopes || [])].some(item => {
      try { return samePath(resolveFilePath(base, item.path), requested); } catch { return false; }
    }))) return null;
  const sameAction = store.listTasks({ limit: 10000 }).filter(item => item.workId === task.workId &&
    workExecution(item, store).actionId === execution.actionId);
  const match = sameAction.flatMap(item => store.listTools(item.id)).reverse().find(record => {
    const denial = recordedFileDenial(record);
    return denial?.path && samePath(denial.path, requested) && ['outside_allowed_roots', 'operation_not_granted'].includes(denial.reason);
  });
  if (!match) return null;
  const denial = recordedFileDenial(match);
  const operations = [...new Set(denial.blockedOperations || denial.operations || [])];
  if (!operations.length || operations.some(operation => !['read', 'write', 'execute', 'publish'].includes(operation))) return null;
  const kind = denial.kind || (match.name === 'list_files' ? 'directory' : ['read_file', 'write_file', 'edit_file', 'publish_file'].includes(match.name) ? 'file' : null);
  if (!kind || operations.includes('execute') && kind !== 'file') return null;
  const explicitDenials = taskFileAccessPolicy(task, store, base).deniedPaths.filter(item => !item.alternativesOnly);
  assertPathPolicy(requested, { deniedPaths: explicitDenials }, { operations });
  return { path: requested, kind, operations, failedToolRunId: match.id, originTaskId: origin.taskId,
    sourceMessageId: origin.replyTo || origin.messageId, roomId: origin.roomId, actionId: execution.actionId,
    executionEventId: execution.executionEventId };
}

// Earlier material supplies a grant only when the production decision adopts
// an original discussion that has not already been bound to a separate work.
export function earlierFileSources(task, store, evidence) {
  const source = authenticatedFileSource(task, store);
  if (!source?.roomId || task.workId) return [];
  const selected = new Map(evidence.filter(item => item.author === 'user' && item.reference?.type === 'room' &&
    item.reference.roomId === source.roomId && !item.reference.attachmentId && item.reference.offset === 0 &&
    item.nextOffset === null && item.fullCharacters === item.content?.length).map(item => [item.reference.messageId, item.content]));
  if (!selected.size) return [];
  const used = new Set(store.listRecords('work-events').flatMap(event => event.authorization?.production?.fileScopeSourceTaskIds || []));
  return store.listTasks({ limit: 10000 }).flatMap(prior => {
    if (prior.workId || used.has(prior.id) || prior.id === task.id || prior.conversationId !== task.conversationId) return [];
    const original = authenticatedFileSource(prior, store);
    if (original?.roomId !== source.roomId || !selected.has(original.replyTo) || selected.get(original.replyTo) !== original.text ||
      !(Date.parse(original.receivedAt) <= Date.parse(source.receivedAt))) return [];
    const routing = store.getRecord('request-routing', prior.id);
    if (routing?.intent !== 'discuss' || routing.messageId !== original.replyTo || routing.roomId !== source.roomId) return [];
    const scopes = namedFileScopes(original.text).filter(item => ['input', 'executable'].includes(item.purpose));
    return scopes.length ? [{ taskId: prior.id, messageId: original.replyTo, text: original.text, scopes }] : [];
  });
}

// Restrict explicit file-access clauses, not every filename in a sentence.
// Within a clause each verb binds the following targets; adjacent verbs may
// share a target. Pronouns use the preceding named subject, never a later file.
function fileDirectives(content) {
  const result = []; let previous = [], lastDirective;
  for (const sentence of content.split(/[。；;\n]+/)) {
    let afterRefusal = false;
    for (const clause of sentence.split(/[，,]+|\b(?:but|however)\b|(?:但是|但)(?=可以|允许|请|继续)/i)) {
      const names = fileNames(clause);
      const masked = clause.replace(pathPattern, value => ' '.repeat(value.length));
      const refusal = negative.exec(masked), permit = !refusal && (positive.exec(masked) || imperative.exec(masked));
      const marker = refusal || permit;
      afterRefusal ||= refusalCondition.test(clause);
      // A condition on a future refusal is not a present file prohibition. Real
      // refusals below supply the alternate-channel guard after they occur.
      if (marker && !(refusal && afterRefusal)) {
        const action = clause.slice(marker.index), verbs = [...masked.slice(marker.index).matchAll(operations)];
        let pending = [];
        for (let i = 0; i < verbs.length; i++) {
          const verb = verbs[i], fragment = action.slice(verb.index + verb[0].length, verbs[i + 1]?.index);
          pending.push(...operationKinds(verb[0]));
          let targets = directiveTargets(fragment);
          if (!targets.length && i === verbs.length - 1) {
            targets = directiveTargets(clause.slice(0, marker.index));
            // In “do not read anything other than this file”, this file is the
            // excluded subject of the ban, not the target of that prohibition.
            if (!targets.length && !excludedSubject.test(fragment) &&
              /它|(?:该|这个|这个指定的)(?:文件|目录|路径|工具)|这份|\bit\b|this\s+(?:file|directory|path|tool)/i.test(fragment)) targets = previous.slice(-1);
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

function priorFileActions(task, store, execution, current) {
  if (!task.workId || !current || !execution?.executionEventId) return [];
  const actions = store.listRecords('work-events').filter(event => event.workId === task.workId && event.kind === 'request');
  const boundary = actions.findIndex(event => event.id === execution.executionEventId);
  if (boundary < 0) return [];
  return actions.slice(0, boundary).filter(event => event.receipt?.accepted && event.authorization?.source?.actor === 'user')
    .flatMap(event => {
      const origin = authenticatedFileSource(store.getTask(event.authorization.requestTaskId), store);
      if (!origin || origin.taskId === current.taskId || origin.roomId !== current.roomId) return [];
      return [{ origin, executionEventId: event.id, production: event.authorization.production }];
    });
}

function carriedFileSources(origin, production, store) {
  if (!production || production.taskId !== origin.taskId || production.acceptedMessageId !== origin.messageId ||
    production.messageId !== origin.replyTo || production.roomId !== origin.roomId) return [];
  return (production.fileScopeSourceTaskIds || []).flatMap(id => {
    const task = store.getTask(id), earlier = authenticatedFileSource(task, store);
    if (!earlier || task.workId || earlier.conversationId !== origin.conversationId || earlier.roomId !== origin.roomId) return [];
    return [{ ...earlier, inputsOnly: true }];
  });
}

function actionFileSource(origin, production) {
  const ranges = production?.fileScopeRanges;
  return ranges ? { ...origin, fileScopeText: ranges.map(([start, end]) => origin.text.slice(start, end)).join('\n') } : origin;
}

/** The authenticated envelope and accepted work actions remain the authority
 * after a resume, native event or compaction. Handoff text is never a grant.
 */
export function taskFileAccessPolicy(task, store, base) {
  const execution = task.workId ? workExecution(task, store) : null;
  const origin = authenticatedFileSource(task.workId ? store.getTask(execution.requestTaskId) : task, store);
  const tasks = store.listTasks({ limit: 10000 });
  const causal = tasks.filter(item => item.steeredIntoTaskId === task.id && item.conversationId === task.conversationId);
  const earlier = priorFileActions(task, store, execution, origin);
  const originals = [...earlier.flatMap(item => [...carriedFileSources(item.origin, item.production, store), actionFileSource(item.origin, item.production)]),
    ...(origin ? [...carriedFileSources(origin, execution?.authorization?.production, store), actionFileSource(origin, execution?.authorization?.production)] : []),
    ...causal.map(item => authenticatedFileSource(item, store)).filter(Boolean)];
  const constraints = [], userRules = new Map(), grants = new Map(), approvedFailures = new Map();
  for (const source of originals) {
    const sourceMessageId = source.replyTo || source.messageId;
    for (const directive of fileDirectives(source.text)) for (const path of directive.targets) {
      let resolved;
      try { resolved = resolveFilePath(base, path); } catch { continue; }
      const key = JSON.stringify([filePathKey(resolved), directive.alternativesOnly]), prior = userRules.get(key), denied = new Set(prior?.operations || []);
      for (const operation of directive.operations) if (directive.denied) denied.add(operation); else denied.delete(operation);
      userRules.set(key, { path: resolved, reason: 'explicit_user_file_restriction', operations: [...denied],
        ...(directive.alternativesOnly ? { alternativesOnly: true } : {}), sourceMessageId });
    }
    const scoped = [...namedFileScopes(source.fileScopeText ?? source.text), ...(source.scopes || [])].filter(({ purpose }) =>
      purpose === 'input' || purpose === 'executable' || !source.inputsOnly && Boolean(task.workId) === (purpose !== 'cwd'));
    if (scoped.some(({ purpose }) => purpose.startsWith('output-'))) {
      for (const [key, grant] of grants) if (grant.operations.includes('write'))
        grants.set(key, { ...grant, operations: grant.operations.filter(operation => operation !== 'write') });
    }
    for (const { path, purpose } of scoped) {
      let resolved;
      try { resolved = resolveFilePath(base, path); } catch { continue; }
      if (resolved === parse(resolved).root) continue;
      const grant = { path: resolved, kind: purposeKinds[purpose], operations: purposeOperations[purpose],
        sourceMessageId, sourceRoomId: source.roomId, sourceTaskId: source.taskId };
      grants.set(JSON.stringify([filePathKey(resolved), purpose]), grant);
    }
  }
  if (task.workId && execution?.actionId) {
    const events = new Set([execution.executionEventId, ...earlier.map(item => item.executionEventId)]);
    for (const record of store.listRecords(WORK_FILE_ACCESS)) {
      if (record.workId !== task.workId || !events.has(record.executionEventId) || !record.answerMessageId) continue;
      const scope = { path: record.path, operations: record.operations, sourceMessageId: record.answerMessageId };
      if (record.status === 'allowed' && record.actionId === execution.actionId) {
        grants.set(record.id, { ...scope, kind: record.kind });
        approvedFailures.set(record.failedToolRunId, record.operations);
      }
      if (record.status === 'denied') constraints.push({ ...scope, reason: 'explicit_user_file_restriction' });
    }
  }
  constraints.push(...[...userRules.values()].filter(rule => rule.operations.length));
  const currentFiles = fileNames(originals.map(source => source.text).join('\n')).map(path => pathKey(base, path));
  const preservePrevious = originals.some(source => noBypass.test(source.text));
  const workTasks = task.workId ? tasks.filter(item => item.workId === task.workId) : [task];
  const sameAction = item => item.id === task.id || Boolean(task.workId && execution.actionId && workExecution(item, store).actionId === execution.actionId);
  const rechecks = workTasks.filter(sameAction).flatMap(item => store.listTools(item.id)).filter(record => record.status === 'completed' && canonical.has(record.name));
  for (const item of workTasks) {
    const current = sameAction(item);
    if (!current && !preservePrevious) continue;
    for (const record of store.listTools(item.id)) {
      const error = record.error || (record.output?.isError ? record.output.details || record.output.structuredContent : null);
      const denial = error?.accessDenial;
      if (!denial?.path || error?.code !== 'FILE_ACCESS_DENIED') continue;
      const originReason = denial.originReason || denial.reason;
      if (!boundaryReasons.has(originReason)) continue;
      if (!current && !currentFiles.some(path => path === pathKey(base, denial.path) || filePathKey(basename(path)) === filePathKey(basename(denial.path)))) continue;
      // A scoped decision can reopen this exact missing grant for a canonical
      // recheck. Success can release its guard. Hard boundaries still apply.
      const blocked = denial.blockedOperations || denial.operations || ['read', 'write'];
      const remaining = blocked.filter(operation => !approvedFailures.get(record.id)?.includes(operation) &&
        !rechecks.some(check => fileOperations(check.name).includes(operation) &&
        Date.parse(check.finishedAt) > Date.parse(record.finishedAt) &&
        [check.args?.path, check.output?.details?.path, check.output?.structuredContent?.path].some(path => typeof path === 'string' && pathKey(base, path) === pathKey(base, denial.path))));
      if (remaining.length) constraints.push({ ...denial, operations: remaining, alternativesOnly: true, reason: 'prior_access_refusal', originReason, toolRunId: record.id });
    }
  }
  return { grants: [...grants.values()],
    deniedPaths: [...new Map(constraints.map(item => [JSON.stringify([filePathKey(item.path), item.operations, Boolean(item.alternativesOnly), item.originReason]), item])).values()] };
}

export async function assertFileToolAccess(name, args, task, store, workspace) {
  if (!['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'run_command', 'publish_file'].includes(name)) return;
  const base = task.workId && store.getRecord('works', task.workId)?.project?.cwd || workspace;
  const policy = taskFileAccessPolicy(task, store, base);
  if (name === 'run_command') await assertCommandPolicy(String(args.command || ''), resolveFilePath(base, args.cwd || '.'), policy, () => {});
  else assertPathPolicy(resolveFilePath(base, args.path || '.'), policy, { operations: fileOperations(name), alternative: name === 'publish_file' });
}
