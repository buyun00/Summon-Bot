import { appendFile, copyFile, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { copyTree, parseArgs, readJson, writeJson } from '../build/files.mjs';
import { describeArtifacts, inside, publishRelease, removeInside, validateRelease } from './repository.mjs';
import { publishGithub } from './github.mjs';
import { localWindowsRelease } from './availability.mjs';
import { installationStatePath, readInstallationState } from '../installation/installation-state.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const buildRoot = join(sourceRoot, '.relay/client-builds');
const { options, positional } = parseArgs(process.argv.slice(2));
const command = positional[0] || 'help';
const flag = name => options[name] === true || options[name] === 'true';
const dataRoot = resolve(options['data-root'] || process.env.SUMMON_DATA_ROOT || (process.platform === 'win32' ? 'D:/Relay-Bot-data' : join(sourceRoot, '../Relay-Bot-data')));
const appRoot = resolve(options['app-root'] || (process.platform === 'win32' ? 'D:/Relay-Bot-app' : join(sourceRoot, '../Relay-Bot-app')));
const repositoryRoot = join(dataRoot, 'client-releases');

async function run(executable, args, { cwd = sourceRoot, env = process.env } = {}) {
  await new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? done() : fail(new Error(`${basename(executable)} exited with code ${code}`)));
  });
}
const sourceCommit = () => {
  const result = spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
};
const buildSourceCommit = ['web', 'desktop', 'desktop-tauri', 'android', 'ios', 'all'].includes(command) ? sourceCommit() : null;
async function outputDirectory(name) {
  await mkdir(buildRoot, { recursive: true });
  return mkdtemp(join(buildRoot, name + '-'));
}
async function describeBuild(input, platform, arch, { release, sourceCommit, candidate, mainFile }) {
  const files = await describeArtifacts(input);
  const metadata = validateRelease({ platform, arch, ...release, files, mainFile, sourceCommit, notes: options.notes || '' });
  await writeJson(join(input, 'artifact.json'), { ...metadata, ...(candidate ? { candidate: true } : {}) });
}
async function reportCandidate(platform, arch, output) {
  console.log(JSON.stringify({ built: true, platform, arch, output }));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `output=${output.replaceAll('\\', '/')}\n`);
}
async function publish(input, release) {
  const artifact = await readJson(join(input, 'artifact.json'));
  if (artifact.candidate || !artifact.sourceCommit) throw new Error('Build the release from its selected commit before publishing');
  const metadata = validateRelease(artifact);
  if (flag('github')) {
    await publishGithub(input, (release || await readJson(join(sourceRoot, 'release.json'))).githubRepository);
  } else {
    if (metadata.platform !== 'windows' || process.platform !== 'win32') throw new Error('Local publishing is for Windows packages only; GitHub releases build in GitHub Actions');
    const record = await publishRelease(repositoryRoot, input, metadata);
    console.log(JSON.stringify({ published: true, platform: record.platform, arch: record.arch, version: record.version,
      directory: join(repositoryRoot, record.platform, record.arch, record.directory), ...(record.cleanupPending ? { cleanupPending: record.cleanupPending } : {}) }));
  }
  if (inside(buildRoot, input)) await removeInside(buildRoot, input).catch(error => console.warn(`Published package; build cleanup pending: ${error.message}`));
}
async function buildDesktopTauri() {
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Tauri desktop builds run on Windows or macOS');
  const platform = process.platform === 'win32' ? 'windows' : 'macos';
  const baseArch = (options.arch || (platform === 'macos' ? 'arm64' : process.arch)).replace(/-tauri$/, '');
  if (baseArch !== (platform === 'macos' ? 'arm64' : 'x64')) throw new Error('Unsupported Tauri desktop architecture');
  const arch = `${baseArch}-tauri`;
  const candidate = flag('candidate');
  if (candidate && (flag('github') || flag('publish') || command === 'all')) throw new Error('Candidate builds cannot publish');
  if (!candidate && !buildSourceCommit) throw new Error('Select a Git commit to build a Tauri desktop release');
  const output = await outputDirectory(`${platform}-${arch}`);
  const { buildTauriDesktop } = await import(pathToFileURL(join(sourceRoot, 'desktop-tauri/build.mjs')));
  const built = await buildTauriDesktop({ platform, arch, output, candidate, commit: buildSourceCommit });
  await describeBuild(output, platform, arch, { ...built, candidate });
  if (!candidate && (platform === 'windows' || flag('publish') || flag('github'))) await publish(output, built.release);
  else await reportCandidate(platform, arch, output);
}

async function buildDesktop(expected) {
  if (options.engine === 'tauri') return buildDesktopTauri();
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Desktop builds run on Windows or macOS');
  const platform = process.platform === 'win32' ? 'windows' : 'macos';
  const arch = options.arch || (platform === 'macos' ? 'arm64' : process.arch);
  if (arch !== (platform === 'macos' ? 'arm64' : 'x64')) throw new Error('Unsupported desktop architecture');
  const candidate = flag('candidate');
  if (candidate && (flag('github') || flag('publish') || command === 'all')) throw new Error('Candidate builds cannot publish');
  if (!candidate && !buildSourceCommit) throw new Error('Select a Git commit to build a desktop release');
  if (expected && platform === 'windows' && await localWindowsRelease(repositoryRoot, expected)) return;
  const output = await outputDirectory(`${platform}-${arch}`);
  const { buildDesktop } = await import(pathToFileURL(join(sourceRoot, 'desktop/build.mjs')));
  const built = await buildDesktop({ platform, arch, output, candidate, commit: buildSourceCommit });
  await describeBuild(output, platform, arch, { ...built, candidate });
  if (!candidate && (platform === 'windows' || flag('publish') || flag('github'))) await publish(output, built.release);
  else await reportCandidate(platform, arch, output);
  if (options.engine === 'both') await buildDesktopTauri();
}

async function androidEnvironment() {
  const javaHome = process.env.JAVA_HOME || (process.platform === 'win32' ? 'C:/Program Files/Android/Android Studio/jbr' : '');
  const java = javaHome ? join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const signingVariables = ['SUMMON_ANDROID_KEYSTORE', 'SUMMON_ANDROID_KEY_ALIAS', 'SUMMON_ANDROID_STORE_PASSWORD', 'SUMMON_ANDROID_KEY_PASSWORD'];
  if (signingVariables.some(name => process.env[name]) || process.env.CI) {
    if (!signingVariables.every(name => process.env[name])) throw new Error('Provide all four existing Android signing credentials; CI never generates a new signing identity');
    return { java, env: { ...process.env } };
  }
  const signingPath = join(dataRoot, 'config/signing/android.json');
  const signing = await readJson(signingPath).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Configure the existing Android signing identity before building an APK');
    throw error;
  });
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Android/Sdk') : '');
  return { java, env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}), ...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}),
    SUMMON_ANDROID_KEYSTORE: resolve(dirname(signingPath), signing.keystore), SUMMON_ANDROID_KEY_ALIAS: signing.alias,
    SUMMON_ANDROID_STORE_PASSWORD: signing.storePassword, SUMMON_ANDROID_KEY_PASSWORD: signing.keyPassword } };
}
async function buildAndroid() {
  const { java, env } = await androidEnvironment();
  const candidate = flag('candidate') || !flag('github');
  if (flag('publish') || flag('candidate') && flag('github')) throw new Error('Publish Android through the GitHub Actions release job');
  if (!candidate && !buildSourceCommit) throw new Error('Select a Git commit to build the Android release');
  const output = await outputDirectory('android-universal');
  const stage = await mkdtemp(join(output, 'source-'));
  let release;
  try {
    if (candidate) {
      await copyFile(join(sourceRoot, 'release.json'), join(stage, 'release.json'));
      await copyTree(join(sourceRoot, 'android'), join(stage, 'android'), name =>
        !name.split('/').some(part => ['build', '.gradle', '.kotlin'].includes(part)));
    } else {
      const { exportCommittedPaths } = await import('../build/build.mjs');
      await exportCommittedPaths(sourceRoot, stage, buildSourceCommit, ['android', 'release.json']);
    }
    const wrapper = join(stage, 'android/gradle/wrapper/gradle-wrapper.properties');
    if (env.SUMMON_GRADLE_DISTRIBUTION) {
      const properties = await readFile(wrapper, 'utf8');
      await writeFile(wrapper, properties.replace(/^distributionUrl=.*$/m, `distributionUrl=${pathToFileURL(env.SUMMON_GRADLE_DISTRIBUTION).href}`));
    }
    const android = join(stage, 'android');
    await run(java, ['-classpath', join(android, 'gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain',
      '--no-daemon', '--console=plain', 'assembleRelease'], { cwd: android, env });
    release = await readJson(join(stage, 'release.json'));
    const mainFile = `Summon-Bot-${release.version}-${release.buildNumber}-android.apk`;
    await copyFile(join(android, 'app/build/outputs/apk/release/app-release.apk'), join(output, mainFile));
    await describeBuild(output, 'android', 'universal', { release, candidate, mainFile, sourceCommit: candidate ? null : buildSourceCommit });
  } finally {
    if (!flag('keep-build-cache')) await removeInside(output, stage);
  }
  if (candidate) await reportCandidate('android', 'universal', output);
  else await publish(output, release);
}
async function buildIos() {
  if (process.platform !== 'darwin') throw new Error('iOS archives must be built on Mac with Xcode');
  const release = await readJson(join(sourceRoot, 'release.json'));
  const output = await outputDirectory('ios');
  const archive = join(output, 'Summon Bot.xcarchive');
  await run('xcodebuild', ['-project', join(sourceRoot, 'ios/Summon.xcodeproj'), '-scheme', 'SummonBot', '-configuration', 'Release',
    '-destination', 'generic/platform=iOS', '-archivePath', archive, '-derivedDataPath', join(output, 'DerivedData'),
    '-allowProvisioningUpdates', `MARKETING_VERSION=${release.version}`, `CURRENT_PROJECT_VERSION=${release.buildNumber}`,
    ...(process.env.SUMMON_APPLE_TEAM_ID ? [`DEVELOPMENT_TEAM=${process.env.SUMMON_APPLE_TEAM_ID}`] : []), 'archive']);
  await removeInside(output, join(output, 'DerivedData'));
  if (options['export-options']) await run('xcodebuild', ['-exportArchive', '-archivePath', archive,
    '-exportPath', join(output, 'export'), '-exportOptionsPlist', resolve(options['export-options']), '-allowProvisioningUpdates']);
  console.log(JSON.stringify({ built: true, platform: 'ios', version: release.version, output, sourceCommit: buildSourceCommit }));
}
async function prepareWeb({ committedOnly = false, reuse = false } = {}) {
  if (process.platform !== 'win32') throw new Error('The existing production installation runs on Windows');
  const state = await readInstallationState(dataRoot);
  if (state && state.phase !== 'done' && !flag('replace-pending')) {
    const expected = await readJson(join(state.release_root, 'release-manifest.json'));
    return { releaseRoot: state.release_root, expected, resuming: true };
  }
  const base = state && (['runtime_ready', 'done'].includes(state.phase) ? state.release_root : state.previous_release);
  const previous = base && await readJson(join(base, 'release-manifest.json'));
  if (committedOnly && !buildSourceCommit) throw new Error('Select a Git commit for the web release');
  if (reuse && state?.phase === 'done' && previous?.sourceMode === 'git-archive' && previous.sourceCommit === buildSourceCommit) {
    return { releaseRoot: base, expected: previous };
  }
  const { buildRelease } = await import('../build/build.mjs');
  const { releaseRoot } = await buildRelease({ sourceRoot, bundleNode: true, committedOnly, commit: committedOnly ? buildSourceCommit : undefined });
  const expected = await readJson(join(releaseRoot, 'release-manifest.json'));
  return { releaseRoot, expected, protocolChanged: Boolean(previous && previous.protocolVersion !== expected.protocolVersion) };
}

async function deployWeb({ releaseRoot }) {
  const { runInstallation } = await import('../installation/install.mjs');
  const installed = await runInstallation({ releaseRoot, appRoot, dataRoot, sourceRoot, replacePending: flag('replace-pending'),
    drainTimeoutMs: Number(options['drain-timeout-ms']),
    onProgress: result => console.log(JSON.stringify(result)) });
  console.log(JSON.stringify({ deployed: true, buildId: installed.buildId, sourceCommit: installed.sourceCommit, state: installed.runtimeState,
    ...(installed.cleanupPending ? { cleanupPending: installed.cleanupPending } : {}) }));
}
async function setVersion() {
  const current = await readJson(join(sourceRoot, 'release.json'));
  const nextVersion = current.version.split('.').map(Number); nextVersion[2]++;
  const release = { ...current, version: options.version || nextVersion.join('.'), buildNumber: Number(options['build-number'] || current.buildNumber + 1) };
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || !Number.isSafeInteger(release.buildNumber) || release.buildNumber < 1) throw new Error('Use a numeric x.y.z version and a positive build number');
  await writeJson(join(sourceRoot, 'release.json'), release);
  for (const directory of ['', 'bot', 'web', 'capabilities', 'desktop', 'desktop-tauri']) {
    const path = join(sourceRoot, directory, 'package.json');
    if (!existsSync(path)) continue;
    const value = await readJson(path); await writeJson(path, { ...value, version: release.version });
  }
  for (const directory of ['', 'desktop', 'desktop-tauri']) {
    const path = join(sourceRoot, directory, 'package-lock.json');
    if (!existsSync(path)) continue;
    const value = await readJson(path); value.version = release.version;
    for (const [name, entry] of Object.entries(value.packages || {})) if (name === '' || (!directory && ['bot', 'web', 'capabilities'].includes(name))) entry.version = release.version;
    await writeJson(path, value);
  }
  const tauriConf = join(sourceRoot, 'desktop-tauri/src-tauri/tauri.conf.json');
  if (existsSync(tauriConf)) {
    const value = await readJson(tauriConf);
    await writeJson(tauriConf, { ...value, version: release.version });
  }
  const cargoToml = join(sourceRoot, 'desktop-tauri/src-tauri/Cargo.toml');
  if (existsSync(cargoToml)) {
    await writeFile(cargoToml, (await readFile(cargoToml, 'utf8')).replace(/^version = "[^"]+"$/m, `version = "${release.version}"`));
  }
  const project = join(sourceRoot, 'ios/Summon.xcodeproj/project.pbxproj');
  await writeFile(project, (await readFile(project, 'utf8')).replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${release.buildNumber};`)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${release.version};`));
  console.log(JSON.stringify(release));
}
async function main() {
  if (command === 'help') { console.log('Summon Bot release: version | web | desktop | desktop-tauri | android | ios | publish --input DIR | all; Windows desktop builds publish locally; --publish (Windows local only) | --github (GitHub Actions only)'); return; }
  if (flag('github') && process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub packages must build and publish in GitHub Actions; local Windows builds stay in the local release directory');
  if (command === 'version') return setVersion();
  if (command === 'web') return deployWeb(await prepareWeb({ committedOnly: flag('committed-only') }));
  if (command === 'desktop') return buildDesktop();
  if (command === 'desktop-tauri') return buildDesktopTauri();
  if (command === 'android') return buildAndroid();
  if (command === 'ios') return buildIos();
  if (command === 'publish') { if (!options.input) throw new Error('Provide --input with the completed build directory'); return publish(resolve(options.input)); }
  if (command === 'all') {
    if (process.platform === 'win32') {
      const next = await prepareWeb({ committedOnly: true, reuse: true });
      if (next.protocolChanged) { await buildDesktop(next.expected); await buildDesktopTauri(); }
      await deployWeb(next);
      if (!next.protocolChanged && (!next.resuming || next.expected?.sourceCommit === buildSourceCommit && next.expected.sourceMode === 'git-archive')) {
        await buildDesktop(next.expected);
        await buildDesktopTauri();
      }
    }
    else if (process.platform === 'darwin') { await buildDesktop(); await buildDesktopTauri(); }
    else throw new Error('Run platform builds on Windows or Mac');
    return;
  }
  throw new Error(`Unknown release command: ${command}`);
}

// npm may run on the old global Node. The installer must not keep a removed
// release's node.exe open, so execute on a temporary copy of the current runtime.
if (process.platform === 'win32' && ['web', 'desktop', 'desktop-tauri', 'all'].includes(command)
    && ['24.15.0', '25.8.0'].includes(process.versions.node) && !process.env.SUMMON_RELEASE_RUNNER) {
  try {
    const relayRoot = join(sourceRoot, '.relay');
    await mkdir(relayRoot, { recursive: true });
    const runnerRoot = await mkdtemp(join(relayRoot, 'release-runner-'));
    const runner = join(runnerRoot, 'node.exe');
    try {
      const installation = existsSync(installationStatePath(dataRoot)) ? await readInstallationState(dataRoot) : null;
      let runtime = process.env.SUMMON_RELEASE_NODE;
      if (!runtime) {
        const selected = installation?.release_root || (await readJson(join(appRoot, 'current.json'))).releaseRoot;
        runtime = join(selected, 'runtime/node.exe');
      }
      if (!existsSync(runtime)) throw new Error('Set SUMMON_RELEASE_NODE to an installed Node runtime with the Windows TCP keepalive fix');
      await copyFile(runtime, runner);
      await run(runner, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...process.env, SUMMON_RELEASE_RUNNER: '1' } });
    } finally { await removeInside(relayRoot, runnerRoot); }
  } catch (error) { console.error(`Release runner failed: ${error.message}. Use a Node runtime with the Windows TCP keepalive fix.`); process.exitCode = 1; }
} else main().catch(error => { console.error(error.message); process.exit(1); });
