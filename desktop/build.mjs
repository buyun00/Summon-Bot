import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildDesktop({ platform, arch, output }) {
  if (platform !== (process.platform === 'darwin' ? 'macos' : 'windows')) throw new Error('Build desktop packages on their target operating system');
  const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
  const electronChecksums = JSON.parse(await readFile(join(root, 'desktop/node_modules/electron/checksums.json'), 'utf8'));
  await writeFile(join(root, 'desktop/release.json'), JSON.stringify(release, null, 2) + '\n');
  await mkdir(output, { recursive: true });
  const target = platform === 'macos' ? builder.Platform.MAC : builder.Platform.WINDOWS;
  return builder.build({ projectDir: join(root, 'desktop'), targets: target.createTarget(undefined, builder.Arch[arch]), publish: 'never',
    config: {
      appId: 'org.lin0.relay.desktop', productName: 'Relay', electronVersion: '45.2.1',
      electronDownload: { checksums: electronChecksums },
      ...(process.env.RELAY_ELECTRON_DIST ? { electronDist: resolve(process.env.RELAY_ELECTRON_DIST) } : {}),
      directories: { app: join(root, 'desktop'), output },
      files: ['main.cjs', 'preload.cjs', 'release.json', 'package.json'],
      extraMetadata: { version: release.version },
      artifactName: 'Relay-${version}-${os}-${arch}.${ext}',
      publish: [{ provider: 'generic', url: `${release.appUrl}/api/releases/${platform}/${arch}/`, useMultipleRangeRequest: false }],
      win: { target: ['nsis'], icon: join(root, 'web/frontend/icons/icon-512.png') },
      nsis: { oneClick: true, perMachine: false, differentialPackage: false, runAfterFinish: false,
        createDesktopShortcut: true, deleteAppDataOnUninstall: false },
      mac: { target: ['dmg', 'zip'], icon: join(root, 'ios/Relay/Assets.xcassets/AppIcon.appiconset/AppIcon.png'),
        category: 'public.app-category.productivity', forceCodeSigning: true, hardenedRuntime: true },
    },
  });
}
