const text = value => typeof value === 'string' ? value : JSON.stringify(value);

/** The gateway authenticates this client's existing per-Bot capability token.
 * Catalog metadata never grants a capability or changes the current work's
 * authority. There is no local copy of a shared Skill body. */
export function createCatalogClient(config) {
  if (!config.catalog) return null;
  const base = new URL(config.catalog.url);
  const token = config.catalog.token;
  const clean = value => String(value).split(token).join('[redacted]');
  async function call(name, args = {}, { signal } = {}) {
    const timeout = AbortSignal.timeout(name === 'catalog_skill_propose' ? 150000 : 30000);
    const response = await fetch(new URL(`/tools/${name}`, base), {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ arguments: args }),
    });
    const raw = await response.text();
    let value;
    try { value = raw ? JSON.parse(raw) : null; }
    catch { throw new Error(`Catalog returned invalid JSON (${response.status})`); }
    if (!response.ok || value?.isError) {
      const error = value?.error?.message || value?.error || value?.content?.find(item => item.type === 'text')?.text || `HTTP ${response.status}`;
      throw Object.assign(new Error(clean(text(error)).slice(0, 1600)), { status: response.status, code: value?.code });
    }
    // Gateway tools return plain values; accept a tool result envelope without
    // retaining its body as another permanent context representation.
    if (value?.details !== undefined) return value.details;
    return value;
  }
  return {
    call,
    search: (args, options) => call('catalog_search', args, options),
    get: (args, options) => call('catalog_get', args, options),
    writeSkill: (args, options) => call('catalog_skill_write', args, options),
    proposeSkill: (args, options) => call('catalog_skill_propose', args, options),
  };
}

export const catalogSkill = entry => ({ ...entry, catalogId: entry.id,
  name: entry.name || entry.id, description: entry.description || entry.purpose || '',
  filePath: `catalog:${entry.id}/SKILL.md`, baseDir: `catalog:${entry.id}/`,
  disableModelInvocation: entry.available === false || entry.enabled === false,
});

export function searchDirectory(entries, query) {
  if (!query) return entries;
  const terms = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => terms.some(term => JSON.stringify(entry).toLocaleLowerCase().includes(term)));
}
