import { chmod, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';
import { buildRelease } from '../scripts/build/build.mjs';
import { removeInside } from '../scripts/release/repository.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildDesktop({ platform, arch, output }) {
  if (platform !== (process.platform === 'darwin' ? 'macos' : 'windows')) throw new Error('Build desktop packages on their target operating system');
  if (arch !== process.arch || arch !== (platform === 'macos' ? 'arm64' : 'x64')) throw new Error('Build with native Node for Apple Silicon or Windows x64');
  if (platform === 'macos') {
    if (arch !== 'arm64') throw new Error('macOS supports Apple Silicon (arm64) only');
    const missing = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].filter(name => !process.env[name]);
    if (missing.length) throw new Error(`macOS Developer ID signing and notarization require: ${missing.join(', ')}`);
  }
  const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
  const electronChecksums = JSON.parse(await readFile(join(root, 'desktop/node_modules/electron/checksums.json'), 'utf8'));
  const updatePath = `/api/releases/${platform}/${arch}/`;
  const updateMode = platform === 'macos' ? 'manual' : 'automatic';
  await writeFile(join(root, 'desktop/release.json'), JSON.stringify({
    version: release.version, buildNumber: release.buildNumber, githubRepository: release.githubRepository, updatePath, updateMode,
  }, null, 2) + '\n');
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, 'runtime-'));
  const runtime = join(stage, 'summon-runtime');
  const target = platform === 'macos' ? builder.Platform.MAC : builder.Platform.WINDOWS;
  try {
    await buildRelease({ sourceRoot: root, releaseRoot: runtime, committedOnly: true });
    if (platform === 'macos') await chmod(join(runtime, 'runtime/node'), 0o755);
    return await builder.build({ projectDir: join(root, 'desktop'), targets: target.createTarget(undefined, builder.Arch[arch]), publish: 'never',
    config: {
      appId: 'org.lin0.relay.desktop', productName: 'Summon Bot', electronVersion: '45.2.1',
      ...(platform === 'macos' ? { forceCodeSigning: true } : {}),
      electronDownload: { checksums: electronChecksums },
      ...(process.env.SUMMON_ELECTRON_DIST ? { electronDist: resolve(process.env.SUMMON_ELECTRON_DIST) } : {}),
      directories: { app: join(root, 'desktop'), output },
      files: ['main.cjs', 'preload.cjs', 'workspace.cjs', 'setup.html', 'setup.css', 'setup.js', 'release.json', 'package.json',
        { from: join(root, 'web/frontend/icons/icon-192.png'), to: 'setup-icon.png' }],
      // electron-builder drops node_modules at the root of a resource source.
      extraResources: [{ from: stage, to: '.', filter: ['summon-runtime'] },
        ...(platform === 'macos' ? [{ from: join(root, 'desktop/summon'), to: 'summon' }] : [])],
      extraFiles: platform === 'windows' ? [{ from: join(root, 'desktop/summon.cmd'), to: 'summon.cmd' }] : [],
      extraMetadata: { version: release.version },
      artifactName: 'Summon-Bot-${version}-${os}-${arch}.${ext}',
      publish: [{ provider: 'generic', url: new URL(updatePath, release.appUrl).href, useMultipleRangeRequest: false }],
      win: { target: ['nsis'], icon: join(root, 'web/frontend/icons/icon-512.png') },
      nsis: { oneClick: true, perMachine: false, differentialPackage: false, runAfterFinish: false,
        shortcutName: 'Summon Bot',
        createDesktopShortcut: true, deleteAppDataOnUninstall: false },
      mac: { target: ['dmg', 'zip'], icon: join(root, 'ios/Summon/Assets.xcassets/SummonIcon.imageset/summon-icon.png'),
        binaries: ['Contents/Resources/summon-runtime/runtime/node'],
        category: 'public.app-category.productivity', notarize: true, hardenedRuntime: true,
        entitlements: join(root, 'desktop/entitlements.mac.plist'),
        entitlementsInherit: join(root, 'desktop/entitlements.mac.plist') },
      dmg: { sign: true },
    },
    });
  } finally { await removeInside(output, stage); }
}
