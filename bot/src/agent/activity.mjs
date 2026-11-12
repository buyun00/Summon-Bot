export const ACTIVITY_MOTIONS = ['idle', 'thinking', 'wink', 'wide', 'alert', 'notify', 'exclaim', 'sleep', 'egg', 'hexagon', 'play', 'orbit', 'burst', 'comet', 'swirl',
  ...['attentif', 'surpris', 'excite', 'heureux', 'hilare', 'colere', 'triste', 'effraye', 'mefiant', 'confus', 'curieux', 'fier', 'timide', 'blase', 'somnolent'].map(id => `expression:${id}`)];
const line = (value, limit = 64) => typeof value === 'string' ? [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, limit).join('') : '';
export const maintenanceActivity = kind => ({
  phase: kind, label: ({ compact: '正在压缩对话，保留关键事实', organize: '正在整理记忆和可复用经验', assemble: '正在组装本次任务的上下文' })[kind] || '正在整理任务资料',
  motion: ({ compact: 'egg', organize: 'hexagon', assemble: 'swirl' })[kind] || 'hexagon', source: 'execution',
});
export function toolActivity(name, args = {}) {
  args ||= {};
  const rules = [
    [/image|draw|paint|design|figma/i, '正在制作图像和设计', 'orbit'],
    [/video|audio|speech|music|tts/i, '正在处理影音内容', 'comet'],
    [/codex|execute|command|terminal|shell|build|deploy|publish/i, '正在执行工作引擎操作', 'play'],
    [/^copy_file$/, '正在复制文件', 'hexagon'],
    [/write|edit|patch|create_file|save_file/i, '正在修改和保存内容', 'hexagon'],
    [/search|browse|fetch|web|lookup/i, '正在搜索相关资料', 'wide'],
    [/read|list|resource|get/i, '正在读取相关资料', 'wide'],
    [/work_wait|await|wait/i, '正在等待外部结果', 'notify'],
    [/work_create|work_dispatch/i, '正在安排独立工作', 'exclaim'],
    [/send|message|chat|contact|consult/i, '正在联系同伴或发送消息', 'wink'],
    [/knowledge|skill|memory/i, '正在整理知识和方法', 'hexagon'],
  ];
  const selected = rules.find(([pattern]) => pattern.test(name));
  const target = line(String(args.path || args.filePath || '').split(/[\\/]/).at(-1), 40);
  return { phase: 'tool', label: `${selected?.[1] || '正在执行任务操作'}${target ? ` · ${target}` : ''}`, motion: selected?.[2] || 'orbit', source: 'execution' };
}
/** Status is derived from actual execution events; it never invokes a model. */
export class TaskActivity {
  constructor({ task, store, emit, clean, signal, refs }) {
    Object.assign(this, { task, store, emit, clean, signal, refs }); this.closed = false;
  }
  update(activity) {
    if (this.closed || this.signal.aborted || this.store.closed) return;
    const current = this.store.getTask(this.task.id);
    if (!current || !['accepted', 'queued', 'running'].includes(current.status)) return;
    const value = this.clean({ ...activity, updatedAt: new Date().toISOString() });
    this.store.updateTask(this.task.id, { activity: value }); this.emit('engine.activity', { activity: value }, this.refs);
  }
  model() { this.update({ phase: 'model', label: '正在理解消息并准备回复', motion: 'thinking', source: 'execution' }); }
  start() { this.update({ phase: 'preparing', label: '已接收消息', motion: 'wink', source: 'execution' }); return this; }
  close() { this.closed = true; }
}
