import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { replay } from './run.mjs';
import { loadEggProfile } from './world.mjs';
import { compare } from './compare.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'node scripts/eggbot-replay/cli.mjs G01-A G01-F [--instructions file.md]\n' +
  'node scripts/eggbot-replay/cli.mjs --split dev|holdout [--limit N]';
const { values, positionals: ids } = parseArgs({ allowPositionals:true, options:{
  split:{type:'string'}, limit:{type:'string'}, instructions:{type:'string'}, help:{type:'boolean'},
} });

async function main() {
  if (values.help || (!ids.length && !values.split)) { console.log(usage); return; }
  if ((values.split && !['dev','holdout'].includes(values.split)) || (values.split && ids.length)) throw new Error(usage);
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (values.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
  const rows = new Map();
  const splits = values.split === 'dev' ? ['开发集'] : values.split === 'holdout' ? ['留出集'] : ['开发集','留出集'];
  for (const split of splits) {
    const dir = join(root, 'docs', 'eggbot-replay', split);
    const load = async name => (await readFile(join(dir,name),'utf8')).trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
    const [inputs, answers] = await Promise.all([load('回放输入.jsonl'),load('期望反应.jsonl')]);
    const key = new Map(answers.map(answer => [answer.id, answer]));
    for (const input of inputs) rows.set(input.id, {input, expected:key.get(input.id)});
  }
  const selected = (ids.length ? ids : [...rows.keys()]).slice(0,limit).map(id => {
    if (!rows.get(id)?.expected) throw new Error('Unknown or unpaired case: '+id);
    return rows.get(id);
  });
  const hostRoot = resolve(process.env.SUMMON_DATA_ROOT || join(root, '../Relay-Bot-data'));
  const path = resolve(values.instructions || join(root,'bundled-bots','eggbot','instructions.md'));
  const profile = await loadEggProfile(hostRoot, path);
  const cancel = new AbortController();
  const interrupt = () => cancel.abort(new Error('Replay interrupted'));
  process.once('SIGINT', interrupt);
  try {
    for (const {input, expected} of selected) {
      cancel.signal.throwIfAborted();
      console.error('EggBot replay '+ input.id);
      const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(180_000)]);
      try {
        const observed = await replay(input, {hostRoot, releaseRoot:root, profile, signal});
        // Gold is attached only after the model has finished. Semantic criteria
        // (e.g. an accurate public handoff) still require examining the reply.
        console.log(JSON.stringify({status:'completed', instructions:path, ...observed,
          comparison:compare(observed, expected), expected}));
      } catch (error) {
        console.log(JSON.stringify({case:input.id,status:'error',code:error.code,message:error.message}));
        process.exitCode=1;
        break;
      }
    }
  } finally { process.removeListener('SIGINT',interrupt); }
}

main().catch(error => { console.error(error.message); process.exitCode=1; });
