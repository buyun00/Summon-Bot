import { taskSource } from '../context/sources.mjs';

// A production artifact request, not an ordinary discussion about documents.
// Execution routing is enforced independently of the frontend model's prose.
export function formalDocumentRequest(task, store) {
  if (task.workId || task.metadata?.routeOnly || task.metadata?.notificationId) return false;
  const source = taskSource(task, store);
  if (source.actor !== 'user') return false;
  const text = typeof source.input === 'string' ? source.input : source.input?.trigger?.content;
  if (typeof text !== 'string' || /(?:先|暂时|现在)?(?:不|不要|无需)(?:写|制作|整理|生成)(?:正式)?(?:文档|需求|设计)/.test(text)) return false;
  if (/(?:暂停|停止|取消)(?:这份|当前|本次|此次|所有|全部)?(?:正式)?(?:文档|稿件|写作|修订)|(?:全部|所有|当前)(?:工作|制作).{0,4}(?:暂停|停止)|(?:暂停|停止)(?:本轮|当前)?(?:全部|所有)(?:工作|制作)|(?:不要|先别|暂不)(?:再|继续)?(?:写|编写|修订)(?:正式)?(?:文档|稿)/.test(text)) return false;
  if (/恢复开发|开始开发|现在(?:请)?(?:开始)?(?:开发|实现|写代码)|\b(?:start|resume)\s+(?:coding|implementation|development)\b/i.test(text)) return false;
  const artifact = /正式(?:稿|文档|需求|设计)|可(?:供)?评审|需求(?:和|与|及)?设计|需求文档|设计文档|架构文档|实施方案|验收文档|需求.*设计|\b(?:PRD|RFC|formal\s+(?:document|requirements|design)|reviewable\s+(?:document|spec))\b/i.test(text);
  const action = /整理|写|编写|制作|生成|交付|给我|出一|修订|修改|更新|补|改成|v\d|\b(?:write|draft|produce|prepare|revise|update)\b/i.test(text);
  if (artifact && action) return true;
  const revision = /文档|草案|正式稿|v\d+\.\d+|§\d|\b(?:document|draft|specification)\b/i.test(text) && /修订|修改|更新|补|改|整理|\b(?:revise|update|change)\b/i.test(text);
  return Boolean(revision);
}
