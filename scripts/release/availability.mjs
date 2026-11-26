import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { readJson } from '../build/files.mjs';
import { sameRelease, validateRelease } from './repository.mjs';
import { githubBase, releaseTargets } from './targets.mjs';
import { findTestFlightBuild, testFlightCredentials } from './testflight.mjs';

const run = promisify(execFile);

export async function localWindowsRelease(root, expected) {
  const folder = join(root, 'windows', 'x64');
  const current = await readJson(join(folder, 'current.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!current || !sameRelease(current, expected)) return null;
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
  const request = async (file, options) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(base + file, { ...options, signal: AbortSignal.timeout(20000), cache: 'no-store' });
        if (attempt || response.status !== 429 && response.status < 500) return response;
        await response.body?.cancel();
      } catch (error) {
        if (attempt) throw new Error(`Cannot currently reach GitHub ${platform}/${arch}`, { cause: error });
      }
      await pause(1000);
    }
  };
  const response = await request('latest.json');
  if (!response.ok) throw new Error(`GitHub ${platform}/${arch} release metadata returned HTTP ${response.status}`);
  const release = validateRelease(await response.json());
  if (release.platform !== platform || release.arch !== arch || !sameRelease(release, expected)) {
    throw new Error(`GitHub ${platform}/${arch} is serving build ${release.buildNumber}; expected ${expected.buildNumber} from the selected commit`);
  }
  const file = encodeURIComponent(release.mainFile);
  let download = await request(file, { method: 'HEAD' });
  if (!download.ok) download = await request(file, { headers: { Range: 'bytes=0-0' } });
  await download.body?.cancel().catch(() => {});
  if (!download.ok) throw new Error(`GitHub ${platform}/${arch} package download returned HTTP ${download.status}`);
}

async function githubMetadata(endpoint) {
  const { stdout } = await run('gh', ['api', endpoint], { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function testFlightBuild(repository, expected) {
  const endpoint = `repos/${repository}/actions/workflows/ios-testflight.yml/runs`;
  const builds = new Set(), attempts = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ head_sha: expected.sourceCommit, per_page: '50', page: String(page) });
    const { workflow_runs } = await githubMetadata(`${endpoint}?${query}`);
    for (const run of workflow_runs) {
      if (run.head_sha !== expected.sourceCommit) continue;
      for (let attempt = run.run_attempt; attempt >= 1; attempt--) {
        builds.add(`${expected.buildNumber}.${run.run_number}.${attempt}`);
        attempts.push({ id: run.id, attempt });
      }
    }
    if (workflow_runs.length < 50) break;
  }
  const group = process.env.TESTFLIGHT_GROUP;
  const auth = testFlightCredentials();
  if (builds.size && auth && await findTestFlightBuild(expected.version, builds, group || 'Personal', auth)) return;
  if (!auth) {
    const marker = 'TestFlight availability ';
    for (const { id, attempt } of attempts) {
      const logs = await run('gh', ['run', 'view', String(id), '--repo', repository, '--attempt', String(attempt), '--log'],
        { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).then(result => result.stdout, () => '');
      for (const line of logs.split(/\r?\n/)) {
        const index = line.indexOf(marker);
        if (index < 0) continue;
        try {
          const state = JSON.parse(line.slice(index + marker.length));
          if (state.available === true && state.version === expected.version && builds.has(state.build)
            && (!group || state.group === group)) return;
        } catch { /* Other log lines do not describe a distributed build. */ }
      }
    }
  }
  throw new Error(`TestFlight availability could not be confirmed for ${expected.version} from the selected commit`);
}

/** A protocol cutover waits for downloads from the existing release channels. */
export async function assertClientAvailability({ dataRoot, release, expected }) {
  if (expected.sourceMode !== 'git-archive' || !expected.sourceCommit || release.version !== expected.version ||
      release.buildNumber !== expected.buildNumber) {
    throw new Error('Build the protocol update from the same committed release as the clients');
  }
  githubBase(release.githubRepository, 'windows', 'x64');
  const requiredTargets = releaseTargets.filter(([, arch]) => !arch.endsWith('-tauri'));
  const outcomes = await Promise.allSettled([
    localWindowsRelease(join(dataRoot, 'client-releases'), expected).then(current => {
      if (!current) throw new Error(`The local Windows release needs build ${expected.buildNumber} from the selected commit`);
    }),
    ...requiredTargets.map(([platform, arch]) => githubPackage(release.githubRepository, platform, arch, expected)),
    testFlightBuild(release.githubRepository, expected),
  ]);
  const failures = outcomes.filter(result => result.status === 'rejected');
  if (failures.length) throw Object.assign(new Error(failures.map(result => result.reason.message).join('\n')), { code: 'CLIENT_RELEASES_PENDING' });
}
