import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ModelConnections } from '../../capabilities/models/service.mjs';
import { modelError } from '../../bot/src/agent/connections.mjs';
import { replay } from './run.mjs';
import { loadEggProfile } from './world.mjs';
import { compare } from './compare.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values: opt } = parseArgs({ options: Object.fromEntries([
  'cases', 'split', 'instructions', 'out', 'catalog-root', 'connection', 'model', 'jobs',
].map(k => [k, {type:'string'}]).concat([['retry-errors', {type:'boolean'}]])) });

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path, value) {
  const temp = path + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(value) + '\n', 'utf8');
  await rename(temp, path);
}
async function previous(path) {
  try { return await readJson(path); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
}
async function main() {
  for (const k of ['cases','split','instructions','out','catalog-root','connection','model'])
    if (!opt[k]) throw new Error('Missing --' + k);
  const jobs = Number(opt.jobs ?? 3);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) throw new Error('Invalid --jobs');
  const split = {dev:'开发集',holdout:'留出集'}[opt.split];
  if (!split) throw new Error('Invalid --split');
  const ids = await readJson(opt.cases);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !/^G\d+-[A-Z]+$/.test(id)))
    throw new Error('Invalid case list');
  const wanted = new Set(ids);
  const rows = async filename => new Map((await readFile(join(root,'docs','eggbot-replay',split,filename),'utf8'))
    .trimEnd().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => wanted.has(row.id)).map(row => [row.id,row]));
  const [inputs, gold] = await Promise.all([rows('回放输入.jsonl'),rows('期望反应.jsonl')]);
  if (inputs.size !== ids.length || gold.size !== ids.length) throw new Error('Missing case in selected split');
  const out = resolve(opt.out);
  await mkdir(out, {recursive:true});
  const lock = join(out, 'active.pid');
  if (await previous(lock)) {
    const pid = await readJson(lock);
    try { process.kill(pid, 0); throw new Error('Lane is already running'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; await rm(lock); }
  }
  const handle = await open(lock, 'wx');
  try {
    await handle.writeFile(String(process.pid));
    const hostRoot = resolve(process.env.SUMMON_DATA_ROOT || join(root,'../Relay-Bot-data'));
    const models = new ModelConnections({dataRoot:resolve(opt['catalog-root'])});
    const profile = await loadEggProfile(hostRoot, resolve(opt.instructions));
    const catalog = models.catalog();
    const conn = models.requireConnection(catalog, opt.connection);
    const official = conn.kind === 'codex' && conn.provider === 'openai-codex' && new URL(conn.baseUrl).origin === 'https://chatgpt.com'
      || conn.kind === 'api' && conn.provider === 'deepseek' && new URL(conn.baseUrl).origin === 'https://api.deepseek.com';
    if (!official || conn.model !== opt.model) throw new Error('Provider or model differs from requested lane');
    profile.modelBinding = models.selectBinding(conn.id);
    for (const purpose of ['fast_read','conversation']) {
      const binding = models.resolveForBot(profile.modelBinding, purpose);
      if (binding?.connection_id !== conn.id || binding?.id !== opt.model) throw new Error('Purpose selection differs from requested lane');
    }
    const meta = {version:basename(opt.instructions), instructions:resolve(opt.instructions), split:opt.split,
      connection:conn.id, provider:conn.provider, model:opt.model};
    const plan = join(out, 'plan.json');
    const old = await previous(plan);
    if (old && JSON.stringify(old) !== JSON.stringify({...meta,ids})) throw new Error('Output belongs to a different run');
    await save(plan, {...meta,ids});
    const queue = [];
    for (const id of ids) {
      const currentPath = join(out,id+'.json');
      let last = await previous(currentPath);
      // Recover a finished attempt if the runner stopped between the two renames.
      const staged = await previous(join(out, 'attempts', id+'.'+((last?.attempt || 0)+1)+'.json'));
      if (staged) { await save(currentPath, staged); last = staged; }
      if (!last || last.status !== 'completed' && opt['retry-errors']) queue.push([id,(last?.attempt || 0)+1]);
    }
    const stamp = () => new Date().toISOString();
    let blocked = null, consecutiveErrors = 0, lastError = null, cursor = 0;
    await save(join(out,'lane.json'), {...meta,state:'running',startedAt:stamp(),pid:process.pid});
    if (!await models.credentials.read(conn.id)) blocked = {kind:'credentials_missing',message:'No credential available at the selected project connection or its API key environment entry', at:stamp()};
    await mkdir(join(out,'attempts'), {recursive:true});
    const worker = async () => {
      while (!blocked && cursor < queue.length) {
        const [id, attempt] = queue[cursor++];
        const startedAt = stamp();
        let result;
        try {
          const observed = await replay(inputs.get(id),{hostRoot,releaseRoot:root,profile,models,signal:AbortSignal.timeout(600_000)});
          if (observed.modelRequests.some(r => r.connectionId !== conn.id || r.requestedModel !== opt.model || r.sentModel !== opt.model))
            throw Object.assign(new Error('Wire model or connection mismatch'), {observed});
          result = {status:'completed',...observed,comparison:compare(observed,gold.get(id)),expected:gold.get(id)};
          consecutiveErrors = 0;
        } catch (error) {
          const observed = error.observed ?? {};
          const fault = observed.modelRequests?.findLast(r => r.providerFault)?.providerFault;
          const requestError = observed.modelRequests?.findLast(r => r.error)?.error;
          result = {...observed,status:'error',code:fault?.code || error.code || 'replay_error',message:modelError(error.message),requestError};
          const signature = result.code + ':' + result.message;
          consecutiveErrors = lastError === signature ? consecutiveErrors+1 : 1;
          lastError = signature;
          if (fault || consecutiveErrors >= Math.max(3,jobs))
            blocked ??= {kind:fault?.code || 'repeated_errors', message:requestError || result.message,at:stamp()};
        }
        const record = {...meta,case:id,attempt,startedAt,finishedAt:stamp(),...result};
        await save(join(out,'attempts',id+'.'+attempt+'.json'), record);
        await save(join(out,id+'.json'), record);
        console.log(id,record.status,record.comparison?.status ?? record.code);
      }
    };
    await Promise.all(Array.from({length:Math.min(queue.length,jobs)},worker));
    await save(join(out,'lane.json'), {...meta,state:blocked ? 'blocked' : 'finished',finishedAt:stamp(),blocked,unattempted:queue.slice(cursor).map(x=>x[0])});
    if (blocked) console.error(blocked.kind, blocked.message);
  } finally { await handle.close(); await rm(lock); }
}
main().catch(e => {console.error(modelError(e.message)); process.exitCode=1;});
