export const releaseTargets = [
  ['windows', 'x64'],
  ['windows', 'x64-tauri'],
  ['macos', 'arm64'],
  ['macos', 'arm64-tauri'],
  ['android', 'universal'],
];

export const validTarget = (platform, arch) => releaseTargets.some(target => target[0] === platform && target[1] === arch);

export const releaseTag = (platform, arch) => `client-${platform}-${arch}`;

export function githubBase(repository, platform, arch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !validTarget(platform, arch)) throw new Error('Invalid GitHub release target');
  return `https://github.com/${repository}/releases/download/${releaseTag(platform, arch)}/`;
}

export function validateRelease(value) {
  if (!validTarget(value.platform, value.arch) || !/^\d+\.\d+\.\d+$/.test(value.version)
    || !Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1
    || !Array.isArray(value.files) || !value.files.length
    || value.files.some(file => !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|dmg|zip|apk|yml|blockmap)$/.test(file.name)
      || !Number.isSafeInteger(file.size) || file.size < 1)
    || new Set(value.files.map(file => file.name)).size !== value.files.length
    || !value.files.some(file => file.name === value.mainFile)) throw new Error('Invalid client release');
  const extension = value.platform === 'windows' ? '.exe' : value.platform === 'macos' ? '.dmg' : '.apk';
  if (!value.mainFile.endsWith(extension)) throw new Error('Incorrect primary package for platform');
  if (value.platform === 'windows' && value.arch === 'x64' && !value.files.some(file => file.name === 'latest.yml')) throw new Error('Windows update metadata missing');
  return {
    platform: value.platform,
    arch: value.arch,
    version: value.version,
    buildNumber: value.buildNumber,
    updateMode: value.platform === 'macos' ? 'manual' : 'automatic',
    sourceCommit: typeof value.sourceCommit === 'string' ? value.sourceCommit.slice(0, 80) : null,
    notes: typeof value.notes === 'string' ? value.notes.slice(0, 8000) : '',
    mainFile: value.mainFile,
    files: value.files.map(file => ({ name: file.name, size: file.size })),
  };
}
