import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readJson } from '../build/files.mjs';
import { validateRelease } from './repository.mjs';
import { githubBase, releaseTargets } from './targets.mjs';

const run = promisify(execFile);
const matches = (current, expected) => current.sourceCommit === expected.sourceCommit &&
  current.version === expected.version && current.buildNumber === expected.buildNumber;

export async function localWindowsRelease(root, expected) {
  const folder = join(root, 'windows', 'x64');
  const current = await readJson(join(folder, 'current.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!current || !matches(current, expected)) return null;
  const release = validateRelease(current);
  if (release.platform !== 'windows' || release.arch !== 'x64' || !/^release-[A-Za-z0-9._-]+$/.test(current.directory)) {
    throw new Error('Invalid local Windows release pointer');
  }
  try {
    if (!(await stat(join(folder, current.directory, release.mainFile))).isFile()) return null;
    if (!(await stat(join(folder, current.directory, 'latest.yml'))).isFile()) return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return current;
}

async function githubPackage(repository, platform, arch, expected) {
  const base = githubBase(repository, platform, arch);
  const options = { signal: AbortSignal.timeout(15000), cache: 'no-store' };
  const response = await fetch(base + 'latest.json', options);
  if (!response.ok) throw new Error(`GitHub ${platform}/${arch} release metadata returned HTTP ${response.status}`);
  const release = validateRelease(await response.json());
  if (release.platform !== platform || release.arch !== arch || !matches(release, expected)) {
    throw new Error(`GitHub ${platform}/${arch} is serving build ${release.buildNumber}; expected ${expected.buildNumber} from the selected commit`);
  }
  const download = await fetch(base + encodeURIComponent(release.mainFile), { ...options, method: 'HEAD', signal: AbortSignal.timeout(15000) });
  if (!download.ok) throw new Error(`GitHub ${platform}/${arch} download returned HTTP ${download.status}`);
}

async function githubMetadata(endpoint) {
  const { stdout } = await run('gh', ['api', endpoint], { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function testFlightBuild(repository, expected) {
  const endpoint = `repos/${repository}/actions`;
  const query = new URLSearchParams({ head_sha: expected.sourceCommit, status: 'success', per_page: '10' });
  const { workflow_runs } = await githubMetadata(`${endpoint}/workflows/ios-testflight.yml/runs?${query}`);
  for (const run of workflow_runs) {
    if (run.head_sha !== expected.sourceCommit || run.conclusion !== 'success') continue;
    const { jobs } = await githubMetadata(`${endpoint}/runs/${run.id}/attempts/${run.run_attempt}/jobs`);
    const distributed = jobs.some(job => job.conclusion === 'success' && job.steps?.some(step =>
      step.name === 'Wait for exact build and internal TestFlight distribution' && step.conclusion === 'success'));
    if (distributed) return;
  }
  throw new Error(`Internal TestFlight distribution has not completed for build ${expected.buildNumber} from the selected commit`);
}

/** A protocol cutover waits for downloads from the existing release channels. */
export async function assertClientAvailability({ dataRoot, release, expected }) {
  if (expected.sourceMode !== 'git-archive' || !expected.sourceCommit || release.version !== expected.version ||
      release.buildNumber !== expected.buildNumber) {
    throw new Error('Build the protocol update from the same committed release as the clients');
  }
  githubBase(release.githubRepository, 'windows', 'x64');
  const outcomes = await Promise.allSettled([
    localWindowsRelease(join(dataRoot, 'client-releases'), expected).then(current => {
      if (!current) throw new Error(`The local Windows release needs build ${expected.buildNumber} from the selected commit`);
    }),
    ...releaseTargets.map(([platform, arch]) => githubPackage(release.githubRepository, platform, arch, expected)),
    testFlightBuild(release.githubRepository, expected),
  ]);
  const failures = outcomes.filter(result => result.status === 'rejected');
  if (failures.length) throw Object.assign(new Error(failures.map(result => result.reason.message).join('\n')), { code: 'CLIENT_RELEASES_PENDING' });
}
