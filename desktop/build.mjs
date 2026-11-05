import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildDesktop({ platform, arch, output }) {
  if (platform !== (process.platform === 'darwin' ? 'macos' : 'windows')) throw new Error('Build desktop packages on their target operating system');
  const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
  const electronChecksums = JSON.parse(await readFile(join(root, 'desktop/node_modules/electron/checksums.json'), 'utf8'));
  const updatePath = `/api/releases/${platform}/${arch}/`;
  const updateMode = platform === 'macos' ? 'manual' : 'automatic';
  await writeFile(join(root, 'desktop/release.json'), JSON.stringify({ ...release, updatePath, updateMode }, null, 2) + '\n');
  await mkdir(output, { recursive: true });
  const target = platform === 'macos' ? builder.Platform.MAC : builder.Platform.WINDOWS;
  return builder.build({ projectDir: join(root, 'desktop'), targets: target.createTarget(undefined, builder.Arch[arch]), publish: 'never',
    config: {
      appId: 'org.lin0.relay.desktop', productName: 'Summon Bot', electronVersion: '45.2.1',
      electronDownload: { checksums: electronChecksums },
      ...(process.env.SUMMON_ELECTRON_DIST ? { electronDist: resolve(process.env.SUMMON_ELECTRON_DIST) } : {}),
      directories: { app: join(root, 'desktop'), output },
      files: ['main.cjs', 'preload.cjs', 'release.json', 'package.json'],
      extraMetadata: { version: release.version },
      artifactName: 'Summon-Bot-${version}-${os}-${arch}.${ext}',
      publish: [{ provider: 'generic', url: new URL(updatePath, release.appUrl).href, useMultipleRangeRequest: false }],
      win: { target: ['nsis'], icon: join(root, 'web/frontend/icons/icon-512.png') },
      nsis: { oneClick: true, perMachine: false, differentialPackage: false, runAfterFinish: false,
        shortcutName: 'Summon Bot',
        createDesktopShortcut: true, deleteAppDataOnUninstall: false },
      mac: { target: ['dmg', 'zip'], icon: join(root, 'ios/Summon/Assets.xcassets/SummonIcon.imageset/summon-icon.png'),
        category: 'public.app-category.productivity', identity: '-', notarize: false, hardenedRuntime: false },
    },
  });
}
