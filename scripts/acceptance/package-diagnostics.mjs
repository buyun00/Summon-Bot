import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable runner only');
const root = process.env.ACCEPTANCE_ROOT, install = process.env.SUMMON_INSTALL_ROOT;
const release = join(install, 'resources/summon-runtime');
const manifest = JSON.parse(await readFile(join(release, 'release-manifest.json'), 'utf8'));
const required = ['node_modules', 'node_modules/@earendil-works/pi-agent-core/package.json', 'node_modules/@earendil-works/pi-ai/package.json', 'node_modules/@summon/bot/package.json', 'bot/package.json', 'web/frontend/index.html', 'web/frontend/onboarding.js', 'connectors/codex-desktop-api/src/main.js', 'runtime/node.exe'];
const result = { candidate: { version: manifest.version, buildId: manifest.buildId, sourceCommit: manifest.sourceCommit, runtime: manifest.runtime },
  files: required.map(path => ({ path, present: existsSync(join(release, path)), listedInBuildManifest: Object.hasOwn(manifest.files, path) })),
  rootDirectories: (await readdir(release, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name),
  dependencyResolution: [], commands: [] };
const require = createRequire(join(release, 'package.json'));
for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@summon/bot']) {
  try { require.resolve(name); result.dependencyResolution.push({ name, resolved: true }); }
  catch (error) { result.dependencyResolution.push({ name, resolved: false, code: error.code }); }
}
for (const command of ['help', 'status']) {
  const escaped = value => "'" + value.replaceAll("'", "''") + "'";
  const text = '& ' + escaped(join(install, 'summon.cmd')) + ' ' + command + ' --profile-root ' + escaped(join(root, 'diagnostic-profile'));
  const observed = await new Promise(resolve => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', text], { timeout: 20000 }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));
  result.commands.push({ command: 'installed/summon.cmd ' + command + ' --profile-root <empty temporary>', ...observed });
}
await writeFile(join(root, 'evidence/package-diagnostics.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
