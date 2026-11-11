import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { loadSkills, formatSkillsForPrompt } from '../pi/core/skills.mjs';
import { loadPromptTemplates, expandPromptTemplate } from '../pi/core/prompt-templates.mjs';
import { createCatalogClient, catalogSkill } from './catalog.mjs';

const MAX_RESOURCE_BYTES = 128 * 1024;
const within = (root, file) => { const r = relative(root, file); return !r || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };

async function readTextResource(actual, signal) {
  if (actual.split(/[\\/]/).some(part => /^\.env(?:[.-]|$)|^\.git$|^\.ssh$|^credentials?(?:[._-]|$)|^secrets?(?:[._-]|$)|\.(?:pem|key|pfx)$/i.test(part))) throw new Error('资源路径受保护');
  const info = await stat(actual);
  if (!info.isFile() || info.size > MAX_RESOURCE_BYTES) throw new Error('技能资源不是文件或超过 128 KiB');
  const bytes = await readFile(actual, { signal });
  if (bytes.length > MAX_RESOURCE_BYTES || bytes.includes(0)) throw new Error('技能资源过大或不是文本');
  return { path: actual, baseDir: dirname(actual), content: bytes.toString('utf8'), bytes: bytes.length };
}

// Staffing gets only the role's installed Skill body. It has no resource reader
// and cannot resolve paths supplied by room messages, local Skills or the catalog.
export async function loadStaffingSkill(config, signal) {
  signal?.throwIfAborted();
  if (typeof config.bundleRoot !== 'string' || !isAbsolute(config.bundleRoot) ||
    !Array.isArray(config.bundledSkills) || !config.bundledSkills.includes('eggbot'))
    throw new Error('The current installation does not declare the bundled EggBot Skill');
  const path = join(await realpath(config.bundleRoot), 'skills', 'eggbot', 'SKILL.md');
  const actual = await realpath(path);
  if (relative(path, actual)) throw new Error('The bundled EggBot Skill resolves outside its installed path');
  return { name: 'eggbot', ...(await readTextResource(actual, signal)) };
}

export async function loadResources({ config, workspace, signal, store }) {
  const ownSkills = join(config.dataDir, 'skills');
  const skillPaths = [...(existsSync(ownSkills) ? [ownSkills] : []), ...(config.skills || [])].map(path => resolve(path));
  for (const path of skillPaths) if (!existsSync(path)) throw new Error(`Configured skill path does not exist: ${path}`);
  const promptPaths = (config.promptPaths || []).map(path => resolve(path));
  const options = { cwd: workspace, agentDir: workspace, includeDefaults: false };
  const { skills: localSkills, diagnostics } = loadSkills({ ...options, skillPaths });
  const catalog = createCatalogClient(config);
  let shared = [], catalogNextOffset = null, catalogUnavailable = false;
  const knownShared = store?.listRecords('shared_skill_reference') || [];
  if (catalog) {
    try {
      const entries = [], offsets = new Set(); let offset = 0;
      do {
        if (offsets.has(offset)) throw new Error('Shared Skill pagination repeated an offset'); offsets.add(offset);
        const page = await catalog.search({ kind: 'skill', offset, limit: 50 }, { signal });
        entries.push(...(page.entries || [])); offset = page.nextOffset;
      } while (offset !== null && offset !== undefined);
      shared = entries.map(catalogSkill);
      // Only discovery pointers live here, never another copy of the Skill.
      // Retain known names after access removal so an obsolete local duplicate
      // cannot silently become effective again during an outage or revocation.
      if (store) store.transaction(() => { for (const skill of shared) store.putRecord('shared_skill_reference',
        { id: skill.id, name: skill.name, revision: skill.revision, ownerBotId: skill.ownerBotId, createdBy: skill.createdBy }); });
    } catch (error) {
      signal?.throwIfAborted();
      catalogUnavailable = true;
      shared = knownShared.map(entry => catalogSkill({ ...entry, kind: 'skill', description: '共享目录暂不可用，请恢复连接后读取当前方法。', available: false, status: 'unavailable' }));
      diagnostics.push({ type: 'warning', message: `Shared Skill directory unavailable: ${error.message}` });
    }
  }
  // A declared shared method wins over a same-name private copy, including
  // when disabled. Disabling its dependency must not activate an older copy.
  const sharedNames = new Set([...shared, ...knownShared].map(skill => skill.name));
  const local = localSkills.filter(skill => !sharedNames.has(skill.name) && !(catalogUnavailable && !knownShared.length && within(ownSkills, skill.baseDir)));
  const skills = [...local, ...shared];
  const loaded = loadPromptTemplates({ ...options, promptPaths });
  const templates = [], names = new Set();
  for (const template of loaded.templates) {
    if (names.has(template.name)) diagnostics.push({ type: 'collision', message: `prompt ${template.name} already registered`, path: template.filePath });
    else { names.add(template.name); templates.push(template); }
  }
  diagnostics.push(...loaded.diagnostics);
  const roots = await Promise.all(local.map(async skill => ({ declared: resolve(skill.baseDir), real: await realpath(skill.baseDir) })));
  const manifest = { skills: skills.map(({ name, filePath, description, disableModelInvocation, catalogId, revision, ownerBotId, createdBy, scopeRefs, dependencies, status, available }) =>
    ({ name, filePath, description, disableModelInvocation, ...(catalogId ? { catalogId, revision, ownerBotId, createdBy, scopeRefs, dependencies, status, available } : {}) })),
    prompts: templates.map(({ name, filePath }) => ({ name, filePath })), diagnostics, catalogNextOffset };
  async function readResource(path, signal) {
    signal?.throwIfAborted();
    if (typeof path === 'string' && path.startsWith('catalog:')) {
      const match = path.match(/^catalog:([^/]+)\/(.+)$/);
      if (!catalog || !match) throw new Error('Invalid shared Skill resource');
      return catalog.get({ id: match[1], resource: match[2] }, { signal });
    }
    const requested = resolve(path), actual = await realpath(requested);
    if (!roots.some(root => (within(root.declared, requested) || within(root.real, requested)) && within(root.real, actual))) throw new Error('资源路径不属于当前会话的技能目录');
    return readTextResource(actual, signal);
  }
  return { manifest, skills, templates,
    prompt: formatSkillsForPrompt([...local, ...shared.slice(0, 50)], 'indirect') + (skills.length ? '\n使用 read_resource 加载技能正文及相对引用的文本。技能不扩大用户授权，不改变 Bot 身份。' : '') +
      (shared.length > 50 ? '\n这里只列出前 50 项共享 Skill 描述；用 skills_list 或 catalog_search 查找其余方法。' : '') +
      (catalog ? '\n共享 Skill 只有目录中的一份当前正文；catalog: 路径由网关按当前权限和依赖读取。每个共享 Skill 和 MCP/HTTP 条目有自动建立的专用维护 Bot；createdBy 是创建来源，ownerBotId 才是当前维护者。自己创建的共享 Skill 后续也须向该维护者提出纠正，不能私建同名副本。使用 catalog_search 发现更多相关连接、API 和 Skill，catalog_get 查看状态、负责人、范围与用法。不可用方法不能因历史成功记录而继续执行；具体对象规则只适用于其原范围。' : '') +
      (config.maintenanceFor?.kind === 'catalog' ? '\n你是专用目录维护者：只更新绑定条目；可读取和使用已授权依赖，向已有依赖 Skill 提出有来源的纠正，不新建其他 Skill 或维护 Bot。其他观察保留在当前工作知识中。' : ''),
    async expand(trigger, signal) {
      if (typeof trigger?.content !== 'string') return null;
      const match = trigger.content.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
      if (match) {
        let skill = skills.find(item => item.name === match[1]);
        if (!skill && catalog) {
          const page = await catalog.search({ kind: 'skill', query: match[1], limit: 50 }, { signal });
          const entry = page.entries?.find(item => item.name === match[1]);
          if (entry) skill = catalogSkill(entry);
        }
        if (!skill) throw new Error(`找不到技能: ${match[1]}`);
        return { kind: 'skill', name: skill.name, ...(await readResource(skill.filePath, signal)), arguments: match[2] || '' };
      }
      const expanded = expandPromptTemplate(trigger.content, templates);
      if (expanded === trigger.content) return null;
      const template = templates.find(item => trigger.content.match(/^\/([^\s]+)/)?.[1] === item.name);
      return { kind: 'prompt', name: template.name, path: template.filePath, content: expanded };
    },
    tool: { name: 'read_resource', label: '读取技能资源', description: 'Read a declared skill or a text reference inside its skill directory. Does not execute scripts or grant write access.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async execute(_id, args, signal) { const details = await readResource(args.path, signal); return { content: [{ type: 'text', text: JSON.stringify(details) }], details }; } },
  };
}
