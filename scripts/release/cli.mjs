import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs, readJson, writeJson } from '../build/files.mjs';
import { describeArtifacts, inside, publishRelease, removeInside, validateRelease } from './repository.mjs';
import { publishGithub } from './github.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const buildRoot = join(sourceRoot, '.relay/client-builds');
const { options, positional } = parseArgs(process.argv.slice(2));
const command = positional[0] || 'help';
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
// Other chats may commit in this shared checkout while a package is building.
const buildSourceCommit = sourceCommit();
async function outputDirectory(name) {
  const path = join(buildRoot, name);
  await mkdir(buildRoot, { recursive: true });
  await removeInside(buildRoot, path);
  await mkdir(path, { recursive: true });
  return path;
}
async function describeBuild(input, platform, arch) {
  const release = await readJson(join(sourceRoot, 'release.json'));
  const files = await describeArtifacts(input);
  const extension = platform === 'windows' ? '.exe' : platform === 'macos' ? '.dmg' : '.apk';
  const mainFile = files.find(file => file.name.endsWith(extension))?.name;
  const metadata = validateRelease({ platform, arch, ...release, files, mainFile, sourceCommit: buildSourceCommit, notes: options.notes || '' });
  await writeJson(join(input, 'artifact.json'), metadata);
  return metadata;
}
async function publish(input) {
  const metadata = validateRelease(await readJson(join(input, 'artifact.json')));
  if (options.github) {
    const release = await readJson(join(sourceRoot, 'release.json'));
    await publishGithub(input, release.githubRepository);
  } else {
    if (metadata.platform !== 'windows' || process.platform !== 'win32') throw new Error('Local publishing is for Windows packages only; GitHub releases build in GitHub Actions');
    const record = await publishRelease(repositoryRoot, input, metadata);
    console.log(JSON.stringify({ published: true, platform: record.platform, arch: record.arch, version: record.version,
      directory: join(repositoryRoot, record.platform, record.arch, record.directory) }));
  }
  if (inside(buildRoot, input)) await removeInside(buildRoot, input);
}
async function buildDesktop() {
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Desktop builds run on Windows or macOS');
  const platform = process.platform === 'win32' ? 'windows' : 'macos';
  const arch = options.arch || (platform === 'macos' ? 'universal' : process.arch);
  if (!(platform === 'macos' ? ['universal'] : ['x64', 'arm64']).includes(arch)) throw new Error('Unsupported desktop architecture');
  const output = await outputDirectory(`${platform}-${arch}`);
  const { buildDesktop } = await import(pathToFileURL(join(sourceRoot, 'desktop/build.mjs')));
  await buildDesktop({ platform, arch, output });
  await describeBuild(output, platform, arch);
  if (platform === 'windows' || options.publish || options.github || command === 'all') await publish(output);
  else console.log(JSON.stringify({ built: true, platform, arch, output }));
}

async function androidEnvironment() {
  const javaHome = process.env.JAVA_HOME || (process.platform === 'win32' ? 'C:/Program Files/Android/Android Studio/jbr' : '');
  const java = javaHome ? join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const keytool = javaHome ? join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool';
  const signingVariables = ['SUMMON_ANDROID_KEYSTORE', 'SUMMON_ANDROID_KEY_ALIAS', 'SUMMON_ANDROID_STORE_PASSWORD', 'SUMMON_ANDROID_KEY_PASSWORD'];
  if (signingVariables.some(name => process.env[name]) || process.env.CI) {
    if (!signingVariables.every(name => process.env[name])) throw new Error('Provide all four existing Android signing credentials; CI never generates a new signing identity');
    return { java, env: { ...process.env } };
  }
  const signingPath = join(dataRoot, 'config/signing/android.json');
  await mkdir(dirname(signingPath), { recursive: true });
  if (!existsSync(signingPath)) {
    const signing = { keystore: join(dataRoot, 'config/signing/relay-android.p12'), alias: 'relay',
      storePassword: randomBytes(32).toString('base64url'), keyPassword: '' };
    signing.keyPassword = signing.storePassword;
    if (existsSync(signing.keystore)) throw new Error('Android signing credential missing beside the existing keystore');
    await run(keytool, ['-genkeypair', '-keystore', signing.keystore, '-storetype', 'PKCS12', '-alias', signing.alias,
      '-storepass:env', 'SUMMON_ANDROID_STORE_PASSWORD', '-keypass:env', 'SUMMON_ANDROID_KEY_PASSWORD',
      '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Relay, O=Relay'],
      { env: { ...process.env, SUMMON_ANDROID_STORE_PASSWORD: signing.storePassword, SUMMON_ANDROID_KEY_PASSWORD: signing.keyPassword } });
    await writeJson(signingPath, signing);
  }
  const signing = await readJson(signingPath);
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Android/Sdk') : '');
  return { java, env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}), ...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}),
    SUMMON_ANDROID_KEYSTORE: signing.keystore, SUMMON_ANDROID_KEY_ALIAS: signing.alias,
    SUMMON_ANDROID_STORE_PASSWORD: signing.storePassword, SUMMON_ANDROID_KEY_PASSWORD: signing.keyPassword } };
}
async function buildAndroid() {
  const { java, env } = await androidEnvironment();
  await run(java, ['-classpath', join(sourceRoot, 'android/gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain',
    '--no-daemon', '--console=plain', 'assembleRelease'], { cwd: join(sourceRoot, 'android'), env });
  const output = await outputDirectory('android-universal');
  const release = await readJson(join(sourceRoot, 'release.json'));
  await copyFile(join(sourceRoot, 'android/app/build/outputs/apk/release/app-release.apk'), join(output, `Summon-Bot-${release.version}-android.apk`));
  await describeBuild(output, 'android', 'universal');
  if (options.publish || options.github) {
    await publish(output);
    if (!options['keep-build-cache']) for (const path of ['android/app/build', 'android/build', 'android/.kotlin']) await removeInside(sourceRoot, join(sourceRoot, path));
    await removeInside(appRoot, join(appRoot, 'Summon-Bot-Android.apk'));
  } else console.log(JSON.stringify({ built: true, platform: 'android', output }));
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
async function deployWeb() {
  if (process.platform !== 'win32') throw new Error('The existing production installation runs on Windows');
  const { buildRelease } = await import('../build/build.mjs');
  const built = await buildRelease({ sourceRoot, bundleNode: true, committedOnly: Boolean(options['committed-only'] || command === 'all') });
  await run('pwsh.exe', ['-NoProfile', '-File', join(appRoot, 'Stop.ps1'), '-DataRoot', dataRoot]);
  await run('pwsh.exe', ['-NoProfile', '-File', join(sourceRoot, 'connectors/codex-desktop-api/Stop.ps1')]);
  const { installRelease } = await import('../installation/install.mjs');
  const installed = await installRelease({ releaseRoot: built.releaseRoot, appRoot, dataRoot, sourceRoot });
  await run('pwsh.exe', ['-NoProfile', '-File', join(appRoot, 'Start.ps1'), '-DataRoot', dataRoot]);
  await run('wscript.exe', ['//B', '//NoLogo', join(sourceRoot, 'connectors/codex-desktop-api/Start-Hidden.vbs')]);
  console.log(JSON.stringify({ deployed: true, buildId: built.buildId, sourceCommit: built.sourceCommit }));
}
async function setVersion() {
  const current = await readJson(join(sourceRoot, 'release.json'));
  const nextVersion = current.version.split('.').map(Number); nextVersion[2]++;
  const release = { ...current, version: options.version || nextVersion.join('.'), buildNumber: Number(options['build-number'] || current.buildNumber + 1) };
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || !Number.isSafeInteger(release.buildNumber) || release.buildNumber < 1) throw new Error('Use a numeric x.y.z version and a positive build number');
  await writeJson(join(sourceRoot, 'release.json'), release);
  for (const directory of ['', 'bot', 'web', 'capabilities', 'desktop']) {
    const path = join(sourceRoot, directory, 'package.json');
    const value = await readJson(path); await writeJson(path, { ...value, version: release.version });
  }
  for (const directory of ['', 'desktop']) {
    const path = join(sourceRoot, directory, 'package-lock.json');
    if (!existsSync(path)) continue;
    const value = await readJson(path); value.version = release.version;
    for (const [name, entry] of Object.entries(value.packages || {})) if (name === '' || (!directory && ['bot', 'web', 'capabilities'].includes(name))) entry.version = release.version;
    await writeJson(path, value);
  }
  const project = join(sourceRoot, 'ios/Summon.xcodeproj/project.pbxproj');
  await writeFile(project, (await readFile(project, 'utf8')).replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${release.buildNumber};`)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${release.version};`));
  console.log(JSON.stringify(release));
}
async function main() {
  if (command === 'help') { console.log('Summon Bot release: version | web | desktop | android | ios | publish --input DIR | all; Windows desktop builds publish locally; --publish (Windows local only) | --github (GitHub Actions only)'); return; }
  if (options.github && process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub packages must build and publish in GitHub Actions; local Windows builds stay in the local release directory');
  if (command === 'version') return setVersion();
  if (command === 'web') return deployWeb();
  if (command === 'desktop') return buildDesktop();
  if (command === 'android') return buildAndroid();
  if (command === 'ios') return buildIos();
  if (command === 'publish') { if (!options.input) throw new Error('Provide --input with the completed build directory'); return publish(resolve(options.input)); }
  if (command === 'all') {
    if (process.platform === 'win32') { await deployWeb(); await buildDesktop(); }
    else if (process.platform === 'darwin') await buildDesktop();
    else throw new Error('Run platform builds on Windows or Mac');
    return;
  }
  throw new Error(`Unknown release command: ${command}`);
}

// npm may run on the old global Node. The installer must not keep a removed
// release's node.exe open, so execute on a temporary copy of the current runtime.
if (process.platform === 'win32' && ['24.15.0', '25.8.0'].includes(process.versions.node) && !process.env.SUMMON_RELEASE_RUNNER) {
  try {
    const current = await readJson(join(appRoot, 'current.json'));
    const runnerRoot = join(sourceRoot, `.relay/release-runner-${process.pid}`);
    await mkdir(runnerRoot, { recursive: true });
    const runner = join(runnerRoot, 'node.exe');
    await copyFile(join(current.releaseRoot, 'runtime/node.exe'), runner);
    try { await run(runner, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...process.env, SUMMON_RELEASE_RUNNER: '1' } }); }
    finally { await removeInside(join(sourceRoot, '.relay'), runnerRoot); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else main().catch(error => { console.error(error.message); process.exit(1); });
