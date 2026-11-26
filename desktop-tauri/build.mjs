import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { buildRelease, exportCommittedPaths } from '../scripts/build/build.mjs';
import { readJson, writeJson } from '../scripts/build/files.mjs';
import { removeInside } from '../scripts/release/repository.mjs';

const tauriDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(tauriDir, '..');
const srcTauriDir = join(tauriDir, 'src-tauri');
const setupDistDir = join(tauriDir, 'setup-dist');
const stagedResourcesDir = join(srcTauriDir, 'staged-resources');
const buildConfigOverridePath = join(srcTauriDir, 'tauri.build.conf.json');

async function runCommand(executable, args, { cwd = tauriDir, env = process.env } = {}) {
  await new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? done() : fail(new Error(`${basename(executable)} exited with code ${code}`)));
  });
}

async function findArtifact(dir, ext) {
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) return full;
    if (entry.isDirectory()) {
      const nested = await findArtifact(full, ext);
      if (nested) return nested;
    }
  }
  return null;
}

export async function buildTauriDesktop({ platform, arch, output, candidate, commit }) {
  if (platform !== (process.platform === 'darwin' ? 'macos' : 'windows')) {
    throw new Error('Build Tauri desktop packages on their target operating system');
  }
  const baseArch = arch.replace(/-tauri$/, '');
  if (baseArch !== process.arch || baseArch !== (platform === 'macos' ? 'arm64' : 'x64')) {
    throw new Error('Build with native Node for Apple Silicon or Windows x64');
  }
  const signing = platform === 'macos' && !candidate;
  if (signing) {
    const { APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,
      APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID } = process.env;
    const hasCert = Boolean((APPLE_CERTIFICATE && APPLE_CERTIFICATE_PASSWORD) || APPLE_SIGNING_IDENTITY);
    const hasNotary = Boolean((APPLE_API_KEY && APPLE_API_ISSUER && APPLE_API_KEY_PATH)
      || (APPLE_ID && APPLE_PASSWORD && APPLE_TEAM_ID));
    if (!hasCert || !hasNotary) {
      throw new Error('Provide APPLE_CERTIFICATE/APPLE_CERTIFICATE_PASSWORD (or APPLE_SIGNING_IDENTITY) and Apple notarization credentials for the macOS Tauri release');
    }
  }

  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, 'tauri-stage-'));
  const runtime = join(stagedResourcesDir, 'summon-runtime');

  try {
    await rm(stagedResourcesDir, { recursive: true, force: true });
    await mkdir(stagedResourcesDir, { recursive: true });
    await rm(setupDistDir, { recursive: true, force: true });
    await mkdir(setupDistDir, { recursive: true });

    // 1. Build summon-runtime (with bundled Node 24.21+ LTS) directly into staged-resources
    const bundled = await buildRelease({
      sourceRoot: root,
      releaseRoot: runtime,
      committedOnly: !candidate,
      commit,
      includeLaunchers: false,
    });

    // 2. Stage desktop setup assets & helper from commit or workspace
    const helperFiles = [
      'desktop/setup.html',
      'desktop/setup.css',
      'desktop/setup.js',
      'desktop-tauri/boot-helper.mjs',
      ...(platform === 'macos' ? ['desktop-tauri/summon'] : ['desktop-tauri/summon.cmd']),
    ];
    if (candidate) {
      for (const rel of helperFiles) {
        const dest = join(stage, rel);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(root, rel), dest);
      }
    } else {
      await exportCommittedPaths(root, stage, bundled.sourceCommit, helperFiles);
    }

    await copyFile(join(stage, 'desktop/setup.html'), join(setupDistDir, 'index.html'));
    await copyFile(join(stage, 'desktop/setup.css'), join(setupDistDir, 'setup.css'));
    await copyFile(join(stage, 'desktop/setup.js'), join(setupDistDir, 'setup.js'));
    await copyFile(join(runtime, 'web/frontend/icons/icon-192.png'), join(setupDistDir, 'icon.png'));
    await copyFile(join(stage, 'desktop-tauri/boot-helper.mjs'), join(runtime, 'tauri-boot-helper.mjs'));

    const release = await readJson(join(runtime, 'release.json'));
    const tauriArch = `${baseArch}-tauri`;
    const updatePath = `/api/releases/${platform}/${tauriArch}/`;
    const releaseMeta = {
      version: release.version,
      buildNumber: release.buildNumber,
      githubRepository: release.githubRepository,
      updatePath,
      updateMode: platform === 'macos' ? 'manual' : 'automatic',
      engine: 'tauri',
    };
    await writeJson(join(stagedResourcesDir, 'release.json'), releaseMeta);

    if (platform === 'macos') {
      await chmod(join(runtime, 'runtime/node'), 0o755);
      await copyFile(join(stage, 'desktop-tauri/summon'), join(stagedResourcesDir, 'summon'));
      await chmod(join(stagedResourcesDir, 'summon'), 0o755);
    } else {
      await copyFile(join(stage, 'desktop-tauri/summon.cmd'), join(stagedResourcesDir, 'summon.cmd'));
      // Pack node_modules into a single tar archive so Windows NSIS installs fast
      const archive = join(runtime, 'node_modules.tar');
      const packed = spawnSync('tar', ['-cf', archive, '-C', runtime, 'node_modules'], { encoding: 'utf8', windowsHide: true });
      if (packed.status !== 0) {
        throw new Error(`Failed to pack runtime node_modules.tar: ${packed.stderr || packed.error?.message || 'tar failed'}`);
      }
      await rm(join(runtime, 'node_modules'), { recursive: true, force: true });
    }

    // 3. Write temporary Tauri config override with version and staged resources
    const resourcesMap = {
      'staged-resources/release.json': 'release.json',
      'staged-resources/summon-runtime': 'summon-runtime',
      ...(platform === 'macos'
        ? { 'staged-resources/summon': 'summon' }
        : { 'staged-resources/summon.cmd': 'summon.cmd' }),
    };
    await writeJson(buildConfigOverridePath, {
      version: release.version,
      bundle: {
        resources: resourcesMap,
        ...(platform === 'macos'
          ? { macOS: { bundleVersion: String(release.buildNumber) } }
          : {}),
      },
    });

    // 4. Invoke Tauri CLI build directly through Node (avoids Windows cmd shell warning)
    const tauriCliJs = join(tauriDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
    const bundleType = platform === 'macos' ? 'dmg' : 'nsis';
    const targetTriple = platform === 'macos' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc';
    const buildEnv = { ...process.env };
    if (platform === 'macos' && !signing) {
      for (const key of [
        'APPLE_CERTIFICATE',
        'APPLE_CERTIFICATE_PASSWORD',
        'APPLE_SIGNING_IDENTITY',
        'APPLE_API_KEY',
        'APPLE_API_ISSUER',
        'APPLE_API_KEY_PATH',
        'APPLE_ID',
        'APPLE_PASSWORD',
        'APPLE_APP_SPECIFIC_PASSWORD',
        'APPLE_TEAM_ID',
        'APPLE_PROVIDER_SHORT_NAME',
      ]) {
        delete buildEnv[key];
      }
    } else if (platform === 'macos' && signing && buildEnv.APPLE_APP_SPECIFIC_PASSWORD && !buildEnv.APPLE_PASSWORD) {
      buildEnv.APPLE_PASSWORD = buildEnv.APPLE_APP_SPECIFIC_PASSWORD;
    }

    await runCommand(process.execPath, [
      tauriCliJs,
      'build',
      '--bundles', bundleType,
      '--target', targetTriple,
      '--config', buildConfigOverridePath,
    ], { cwd: tauriDir, env: buildEnv });

    // 5. Locate and copy the produced installer to output directory
    const bundleDir = join(srcTauriDir, 'target', targetTriple, 'release', 'bundle', bundleType);
    const ext = platform === 'macos' ? '.dmg' : '.exe';
    const produced = await findArtifact(bundleDir, ext);
    if (!produced) {
      throw new Error(`Tauri build did not produce a ${ext} artifact in ${bundleDir}`);
    }
    const osSlug = platform === 'macos' ? 'mac' : 'win';
    const mainFile = `Summon-Bot-${release.version}-${release.buildNumber}-${osSlug}-${baseArch}-tauri${ext}`;
    const destination = join(output, mainFile);
    if (platform === 'macos') {
      await rm(destination, { force: true });
      await runCommand('hdiutil', [
        'convert', produced,
        '-format', 'ULMO',
        '-ov',
        '-o', destination,
      ], { cwd: tauriDir });
      const { size } = await stat(destination);
      console.log(`Compressed macOS DMG (ULMO/LZMA): ${mainFile} (${(size / 1024 / 1024).toFixed(2)} MiB, ${size} bytes)`);
    } else {
      await copyFile(produced, destination);
    }

    return {
      release,
      mainFile,
      sourceCommit: candidate ? null : bundled.sourceCommit,
    };
  } finally {
    await rm(buildConfigOverridePath, { force: true }).catch(() => {});
    await rm(stagedResourcesDir, { recursive: true, force: true }).catch(() => {});
    await removeInside(output, stage).catch(() => {});
  }
}
