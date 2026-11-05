export const releaseTargets = [
  ['windows', 'x64'], ['windows', 'arm64'],
  ['macos', 'arm64'], ['android', 'universal'],
];
export const validTarget = (platform, arch) => releaseTargets.some(target => target[0] === platform && target[1] === arch);
export const releaseTag = (platform, arch) => `client-${platform}-${arch}`;
export function githubBase(repository, platform, arch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !validTarget(platform, arch)) throw new Error('Invalid GitHub release target');
  return `https://github.com/${repository}/releases/download/${releaseTag(platform, arch)}/`;
}
