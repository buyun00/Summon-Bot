import { chmod, copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import builder from 'electron-builder';
import { buildRelease, copyProductionDependencies, exportCommittedPaths } from '../scripts/build/build.mjs';
import { readJson, writeJson } from '../scripts/build/files.mjs';
import { removeInside } from '../scripts/release/repository.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shellFiles = ['main.cjs', 'preload.cjs', 'connection.cjs', 'setup.html', 'setup.css', 'setup.js', 'package.json'];
const macIcon = 'ios/Summon/Assets.xcassets/SummonIcon.imageset/summon-icon.png';

export async function buildDesktop({ platform, arch, output, candidate, commit }) {
  if (platform !== (process.platform === 'darwin' ? 'macos' : 'windows')) throw new Error('Build desktop packages on their target operating system');
  if (arch !== process.arch || arch !== (platform === 'macos' ? 'arm64' : 'x64')) throw new Error('Build with native Node for Apple Silicon or Windows x64');
  const signing = platform === 'macos' && !candidate;
  if (signing) {
    const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
      APPLE_TEAM_ID, APPLE_KEYCHAIN_PROFILE } = process.env;
    if (!(APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER)
      && !(APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) && !APPLE_KEYCHAIN_PROFILE) {
      throw new Error('Provide the Apple notarization credentials or keychain profile for the Developer ID release');
    }
  }
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, 'desktop-'));
  const runtime = join(stage, 'summon-runtime');
  const app = join(stage, 'desktop');
  const target = platform === 'macos' ? builder.Platform.MAC : builder.Platform.WINDOWS;
  try {
    const bundled = await buildRelease({ sourceRoot: root, releaseRoot: runtime, committedOnly: !candidate, commit });
    const inputs = [...shellFiles, 'package-lock.json', ...(platform === 'macos' ? ['summon', 'entitlements.mac.plist'] : ['summon.cmd'])]
      .map(name => 'desktop/' + name);
    if (platform === 'macos') inputs.push(macIcon);
    if (candidate) {
      for (const input of inputs) {
        await mkdir(dirname(join(stage, input)), { recursive: true });
        await copyFile(join(root, input), join(stage, input));
      }
    } else {
      await exportCommittedPaths(root, stage, bundled.sourceCommit, inputs);
    }
    const release = await readJson(join(runtime, 'release.json'));
    const pkg = await readJson(join(app, 'package.json'));
    await copyProductionDependencies(join(root, 'desktop'), app);
    const updatePath = `/api/releases/${platform}/${arch}/`;
    await writeJson(join(app, 'release.json'), { version: release.version, buildNumber: release.buildNumber,
      githubRepository: release.githubRepository, updatePath, updateMode: platform === 'macos' ? 'manual' : 'automatic' });
    if (platform === 'macos') {
      await chmod(join(runtime, 'runtime/node'), 0o755);
      await chmod(join(app, 'summon'), 0o755);
    }
    if (platform === 'windows') {
      // Pack node_modules into a single tar archive so Windows NSIS installs ~150 files
      // in a few seconds instead of extracting thousands of loose JS files one by one.
      const archive = join(runtime, 'node_modules.tar');
      const packed = spawnSync('tar', ['-cf', archive, '-C', runtime, 'node_modules'], { encoding: 'utf8', windowsHide: true });
      if (packed.status !== 0) throw new Error(`Failed to pack runtime node_modules.tar: ${packed.stderr || packed.error?.message || 'tar failed'}`);
      await rm(join(runtime, 'node_modules'), { recursive: true, force: true });
    }
    const artifacts = await builder.build({ projectDir: app, targets: target.createTarget(undefined, builder.Arch[arch]), publish: 'never',
      config: {
        appId: 'org.lin0.relay.desktop', productName: 'Summon Bot', electronVersion: pkg.devDependencies.electron,
        ...(signing ? { forceCodeSigning: true } : {}),
        ...(process.env.SUMMON_ELECTRON_DIST ? { electronDist: resolve(process.env.SUMMON_ELECTRON_DIST) } : {}),
        directories: { app, output },
        files: [...shellFiles, 'release.json'],
        // electron-builder drops node_modules at the root of a resource source.
        extraResources: [{ from: stage, to: '.', filter: ['summon-runtime'] },
          ...(platform === 'macos' ? [{ from: join(app, 'summon'), to: 'summon' }] : [])],
        extraFiles: platform === 'windows' ? [{ from: join(app, 'summon.cmd'), to: 'summon.cmd' }] : [],
        extraMetadata: { version: release.version },
        artifactName: 'Summon-Bot-${version}-' + release.buildNumber + '-${os}-${arch}.${ext}',
        publish: platform === 'windows' ? [{ provider: 'generic', url: new URL(updatePath, release.appUrl).href, useMultipleRangeRequest: false }] : null,
        win: { target: ['nsis'], icon: join(runtime, 'web/frontend/icons/icon-512.png') },
        nsis: { oneClick: true, perMachine: false, differentialPackage: false, runAfterFinish: true,
          shortcutName: 'Summon Bot', createDesktopShortcut: true, deleteAppDataOnUninstall: false },
        mac: { target: ['dmg'], type: 'distribution', icon: join(stage, macIcon),
          ...(signing ? {} : { identity: null }), binaries: ['Contents/Resources/summon-runtime/runtime/node'],
          category: 'public.app-category.productivity', notarize: signing, hardenedRuntime: signing,
          entitlements: join(app, 'entitlements.mac.plist'), entitlementsInherit: join(app, 'entitlements.mac.plist') },
        dmg: { sign: signing },
      },
    });
    const extension = platform === 'macos' ? '.dmg' : '.exe';
    const mainFile = artifacts.find(path => path.endsWith(extension));
    return { release, mainFile: mainFile && basename(mainFile), sourceCommit: candidate ? null : bundled.sourceCommit };
  } finally { await removeInside(output, stage); }
}
