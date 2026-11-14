import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseline } from './inspect-104.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const originalShutdown = "if (req.method === 'POST' && req.url === '/shutdown') {";
const originalGateway = "join(config.releaseRoot, 'capabilities/gateway/index.mjs')";
const handoffGateway = "join(config.releaseRoot, 'scripts/installation/first-cutover/gateway.mjs')";
const markedControlRoute = "if (req.url === '/installation' && type === 'gateway') {";
const configRead = 'const config = await readJson(resolve(options.config));';
const launchRestriction = 'The first cutover is controlled by the installation program';

async function replace(path, value) {
  const temporary = path + '.handoff.tmp';
  await writeFile(temporary, value);
  await rename(temporary, path);
}

export async function prepare104(container) {
  const root = await realpath(container);
  const builds = await realpath(join(here, '..', '..', '..', 'dist'));
  const part = relative(builds, root);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) {
    throw new Error('Prepare the handoff in an existing container under the source build directory');
  }
  const manifestPath = join(root, 'release-manifest.json');
  const manifest = await read(manifestPath);
  const release = await read(join(root, 'release.json'));
  if (manifest.sourceCommit !== baseline || manifest.format !== 2 || manifest.dataFormat || manifest.contentHash ||
      release.version !== '0.3.100' || release.buildNumber !== 104) {
    throw new Error('The handoff container must carry the development-profile 0.3.100 build 104');
  }
  const service = join(root, 'scripts', 'installation', 'service.mjs');
  let source = await readFile(service, 'utf8');
  const support = `${markedControlRoute}
      const identity = { pid: process.pid, bootId, supportsDrain: typeof app?.installationDrain === 'function' };
      if (req.method === 'GET') return json(res, 200, identity);
      if (req.method === 'POST') {
        try {
          const state = await readJson(join(config.dataRoot, 'config', 'installation_state.json'));
          if (state.phase !== 'draining' || resolve(state.previous_release) !== resolve(config.releaseRoot)) {
            return json(res, 409, { error: 'This gateway does not own the installation window' });
          }
          const report = await app.installationDrain(state);
          return json(res, 200, { ...report, ...identity, migration_id: state.migration_id });
        } catch {
          return json(res, 503, { error: 'Installation drain is unavailable' });
        }
      }
    }
    `;
  if (!source.includes(markedControlRoute)) {
    if (!source.includes(originalShutdown) || !source.includes(originalGateway)) throw new Error('The handoff container has a different managed service entry');
    source = source.replace(originalShutdown, support + originalShutdown).replace(originalGateway, handoffGateway);
  } else if (!source.includes(handoffGateway)) throw new Error('The handoff container has an inconsistent managed service entry');
  const priorRestriction = source.indexOf('\n  const handoffState = ');
  if (priorRestriction >= 0) {
    const next = source.indexOf('\n  const type = options.type;', priorRestriction);
    if (next < 0) throw new Error('The handoff container has an inconsistent deployment guard');
    source = source.slice(0, priorRestriction) + source.slice(next);
  }
  if (!source.includes(configRead)) throw new Error('The handoff container has a different deployment loader');
  source = source.replace(configRead, `${configRead}
  const handoffState = await readJson(join(config.dataRoot, 'config', 'first_cutover_104.json'));
  const installation = await readJson(join(config.dataRoot, 'config', 'installation_state.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const mayResume = installation?.phase === 'prepared' ||
    (installation?.phase === 'draining' && (!installation.intake_closed || options.type === 'gateway'));
  if (config.runIntent !== 'stopped' || handoffState.phase !== 'handoff_selected' ||
      resolve(handoffState.handoff_release) !== resolve(config.releaseRoot) ||
      (installation && (!mayResume || installation.migration_id !== handoffState.id ||
        resolve(installation.previous_release) !== resolve(config.releaseRoot)))) {
    throw new Error('${launchRestriction}');
  }`);
  const cli = join(root, 'scripts', 'installation', 'cli.mjs');
  let launcher = await readFile(cli, 'utf8');
  const originalStart = "else if (command === 'start') {";
  if (!launcher.includes(launchRestriction)) {
    const start = launcher.indexOf(originalStart);
    const unknown = launcher.indexOf('} else throw new Error(', start);
    if (start < 0 || unknown < 0) throw new Error('The handoff container has a different start command');
    launcher = launcher.slice(0, start) + originalStart + "\n    throw new Error('" + launchRestriction + "');\n  " + launcher.slice(unknown);
  }
  const targetScripts = join(root, 'scripts', 'installation', 'first-cutover');
  await mkdir(targetScripts, { recursive: true });
  await copyFile(join(here, 'gateway.mjs'), join(targetScripts, 'gateway.mjs'));
  await copyFile(join(here, 'finish-installation.mjs'), join(root, 'scripts', 'installation', 'finish-installation.mjs'));
  await replace(service, source);
  await replace(cli, launcher);
  const buildId = manifest.firstCutover104 ? manifest.buildId : `first-cutover-104-${randomUUID()}`;
  await replace(manifestPath, JSON.stringify({ ...manifest, buildId, firstCutover104: true }, null, 2) + '\n');
  return buildId;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node prepare-104.mjs <existing-0.3.100-build-container>');
    console.log(await prepare104(process.argv[2]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
