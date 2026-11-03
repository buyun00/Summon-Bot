import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs, readJson, writeJson } from '../build/files.mjs';
import { describeArtifacts, inside, publishRelease, removeInside, validateRelease } from './repository.mjs';

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
async function outputDirectory(name) {
  const path = join(buildRoot, name);
  await mkdir(buildRoot, { recursive: true });
  await removeInside(buildRoot, path);
  await mkdir(path, { recursive: true });
  return path;
}
async function ensurePublishToken() {
  const path = join(dataRoot, 'config/client-releases-publish-token');
  await mkdir(dirname(path), { recursive: true });
  if (!existsSync(path)) await writeFile(path, randomBytes(36).toString('base64url'), { flag: 'wx', mode: 0o600 });
}
async function describeBuild(input, platform, arch) {
  const release = await readJson(join(sourceRoot, 'release.json'));
  const files = await describeArtifacts(input);
  const extension = platform === 'windows' ? '.exe' : platform === 'macos' ? '.dmg' : '.apk';
  const mainFile = files.find(file => file.name.endsWith(extension))?.name;
  const metadata = validateRelease({ platform, arch, ...release, files, mainFile, sourceCommit: sourceCommit(), notes: options.notes || '' });
  await writeJson(join(input, 'artifact.json'), metadata);
  return metadata;
}
async function publish(input) {
  const metadata = validateRelease(await readJson(join(input, 'artifact.json')));
  if (options.server) {
    const server = new URL(options.server);
    if (server.protocol !== 'https:' || server.username || server.password || server.pathname !== '/') throw new Error('--server must be an HTTPS origin');
    if (!options['token-file']) throw new Error('Remote publication requires --token-file pointing to the private publishing credential');
    const token = (await readFile(resolve(options['token-file']), 'utf8')).trim();
    const request = async (path, init) => {
      const response = await fetch(new URL(path, server), { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, redirect: 'error' });
      if (!response.ok) throw new Error(`Publication failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
      return response.json();
    };
    const { uploadId } = await request(`/api/releases/publish/${metadata.platform}/${metadata.arch}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata),
    });
    try {
      for (const file of metadata.files) for (let start = 0; start < file.size; start += 8 * 1024 * 1024) {
        const end = Math.min(start + 8 * 1024 * 1024, file.size) - 1;
        await request(`/api/releases/publish/${uploadId}/${file.name}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${file.size}` },
          body: createReadStream(join(input, file.name), { start, end }), duplex: 'half',
        });
      }
      const result = await request(`/api/releases/publish/${uploadId}/commit`, { method: 'POST' });
      console.log(JSON.stringify({ published: true, platform: metadata.platform, arch: metadata.arch, version: metadata.version, ...result }));
    } catch (error) {
      await request(`/api/releases/publish/${uploadId}/cancel`, { method: 'POST' }).catch(() => {});
      throw error;
    }
  } else {
    if (process.platform !== 'win32' && !options['data-root']) throw new Error('Mac builds publish to the running host using --server and --token-file');
    await ensurePublishToken();
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
  if (!['x64', 'arm64', ...(platform === 'macos' ? ['universal'] : [])].includes(arch)) throw new Error('Unsupported desktop architecture');
  const output = await outputDirectory(`${platform}-${arch}`);
  const { buildDesktop } = await import(pathToFileURL(join(sourceRoot, 'desktop/build.mjs')));
  await buildDesktop({ platform, arch, output });
  await describeBuild(output, platform, arch);
  if (options.publish || (command === 'all' && (process.platform === 'win32' || options.server))) await publish(output);
  else console.log(JSON.stringify({ built: true, platform, arch, output }));
}

async function androidEnvironment() {
  const javaHome = process.env.JAVA_HOME || (process.platform === 'win32' ? 'C:/Program Files/Android/Android Studio/jbr' : '');
  const java = javaHome ? join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const keytool = javaHome ? join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool';
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
  if (options.publish || command === 'all') {
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
  await run('xcodebuild', ['-project', join(sourceRoot, 'ios/Relay.xcodeproj'), '-scheme', 'SummonBot', '-configuration', 'Release',
    '-destination', 'generic/platform=iOS', '-archivePath', archive, '-derivedDataPath', join(output, 'DerivedData'),
    '-allowProvisioningUpdates', `MARKETING_VERSION=${release.version}`, `CURRENT_PROJECT_VERSION=${release.buildNumber}`,
    ...(process.env.SUMMON_APPLE_TEAM_ID ? [`DEVELOPMENT_TEAM=${process.env.SUMMON_APPLE_TEAM_ID}`] : []), 'archive']);
  await removeInside(output, join(output, 'DerivedData'));
  if (options['export-options']) await run('xcodebuild', ['-exportArchive', '-archivePath', archive,
    '-exportPath', join(output, 'export'), '-exportOptionsPlist', resolve(options['export-options']), '-allowProvisioningUpdates']);
  console.log(JSON.stringify({ built: true, platform: 'ios', version: release.version, output, sourceCommit: sourceCommit() }));
}
async function deployWeb() {
  if (process.platform !== 'win32') throw new Error('The existing production installation runs on Windows');
  await ensurePublishToken();
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
  const project = join(sourceRoot, 'ios/Relay.xcodeproj/project.pbxproj');
  await writeFile(project, (await readFile(project, 'utf8')).replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${release.buildNumber};`)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${release.version};`));
  console.log(JSON.stringify(release));
}
async function main() {
  if (command === 'help') { console.log('Summon Bot release: version | web | desktop | android | ios | publish --input DIR | all; --publish; --server HTTPS_ORIGIN --token-file PATH'); return; }
  if (command === 'version') return setVersion();
  if (command === 'web') return deployWeb();
  if (command === 'desktop') return buildDesktop();
  if (command === 'android') return buildAndroid();
  if (command === 'ios') return buildIos();
  if (command === 'publish') { if (!options.input) throw new Error('Provide --input with the completed build directory'); return publish(resolve(options.input)); }
  if (command === 'all') {
    if (process.platform === 'win32') { await deployWeb(); await buildDesktop(); await buildAndroid(); }
    else if (process.platform === 'darwin') { await buildDesktop(); await buildIos(); }
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
} else main().catch(error => { console.error(error.message); process.exitCode = 1; });
