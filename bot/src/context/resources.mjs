import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSkills, formatSkillsForPrompt } from '../pi/core/skills.mjs';
import { loadPromptTemplates, expandPromptTemplate } from '../pi/core/prompt-templates.mjs';

const MAX_RESOURCE_BYTES = 128 * 1024;
const within = (root, file) => { const r = relative(root, file); return !r || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
const digest = text => createHash('sha256').update(text).digest('hex');
export async function loadResources({ config, workspace }) {
  const skillPaths = (config.skills || []).map(path => resolve(path));
  for (const path of skillPaths) if (!existsSync(path)) throw new Error(`Configured skill path does not exist: ${path}`);
  const promptPaths = (config.promptPaths || []).map(path => resolve(path));
  const options = { cwd: workspace, agentDir: workspace, includeDefaults: false };
  const { skills, diagnostics } = loadSkills({ ...options, skillPaths });
  const loaded = loadPromptTemplates({ ...options, promptPaths });
  const templates = [], names = new Set();
  for (const template of loaded.templates) {
    if (names.has(template.name)) diagnostics.push({ type: 'collision', message: `prompt ${template.name} already registered`, path: template.filePath });
    else { names.add(template.name); templates.push(template); }
  }
  diagnostics.push(...loaded.diagnostics);
  const roots = await Promise.all(skills.map(async skill => ({ declared: resolve(skill.baseDir), real: await realpath(skill.baseDir) })));
  const manifest = { skills: skills.map(({ name, filePath, description, disableModelInvocation }) => ({ name, filePath, description, disableModelInvocation })),
    prompts: templates.map(({ name, filePath }) => ({ name, filePath })), diagnostics };
  async function readResource(path, signal) {
    signal?.throwIfAborted();
    const requested = resolve(path), actual = await realpath(requested);
    if (!roots.some(root => (within(root.declared, requested) || within(root.real, requested)) && within(root.real, actual))) throw new Error('资源路径不属于当前会话的技能目录');
    if (actual.split(/[\\/]/).some(part => /^\.env(?:[.-]|$)|^\.git$|^\.ssh$|^credentials?(?:[._-]|$)|^secrets?(?:[._-]|$)|\.(?:pem|key|pfx)$/i.test(part))) throw new Error('资源路径受保护');
    const info = await stat(actual);
    if (!info.isFile() || info.size > MAX_RESOURCE_BYTES) throw new Error('技能资源不是文件或超过 128 KiB');
    const bytes = await readFile(actual, { signal });
    if (bytes.length > MAX_RESOURCE_BYTES || bytes.includes(0)) throw new Error('技能资源过大或不是文本');
    const content = bytes.toString('utf8');
    return { path: actual, baseDir: dirname(actual), content, sha256: digest(bytes), bytes: bytes.length };
  }
  return { manifest, skills, templates,
    prompt: formatSkillsForPrompt(skills, 'indirect') + (skills.length ? '\n使用 read_resource 加载技能正文及相对引用的文本。技能不扩大用户授权，不改变 Bot 身份。' : ''),
    async expand(trigger, signal) {
      if (typeof trigger?.content !== 'string') return null;
      const match = trigger.content.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
      if (match) {
        const skill = skills.find(item => item.name === match[1]);
        if (!skill) throw new Error(`找不到技能: ${match[1]}`);
        return { kind: 'skill', name: skill.name, ...(await readResource(skill.filePath, signal)), arguments: match[2] || '' };
      }
      const expanded = expandPromptTemplate(trigger.content, templates);
      if (expanded === trigger.content) return null;
      const template = templates.find(item => trigger.content.match(/^\/([^\s]+)/)?.[1] === item.name);
      return { kind: 'prompt', name: template.name, path: template.filePath, content: expanded, sha256: digest(expanded) };
    },
    tool: { name: 'read_resource', label: '读取技能资源', description: 'Read a declared skill or a text reference inside its skill directory. Does not execute scripts or grant write access.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async execute(_id, args, signal) { const details = await readResource(args.path, signal); return { content: [{ type: 'text', text: JSON.stringify(details) }], details }; } },
  };
}
