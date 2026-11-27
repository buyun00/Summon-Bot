import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { githubBase, releaseTag, validateRelease } from '../../web/backend/release-meta.mjs';
import { reject } from '../platform/contract.mjs';

const DEFAULT_GITHUB_REPO = 'buyun00/Summon-Bot';
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const MIN_DRAIN_TIMEOUT_MS = 5_000;
const MAX_DRAIN_TIMEOUT_MS = 120_000;
const MIN_SETTLE_MS = 3_000;

function hostTarget() {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { supported: true, platform: 'windows', arch: 'x64-tauri', ext: '.exe' };
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { supported: true, platform: 'macos', arch: 'arm64-tauri', ext: '.dmg' };
  }
  return {
    supported: false,
    platform: process.platform,
    arch: process.arch,
    ext: '',
    reason: `当前平台（${process.platform}/${process.arch}）暂不支持自动安装包自更新`,
  };
}

function psSingleQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function shSingleQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

function findMacAppBundle(fromPath) {
  let cursor = resolve(fromPath);
  while (cursor && cursor !== dirname(cursor)) {
    if (cursor.toLowerCase().endsWith('.app') && existsSync(cursor)) return cursor;
    cursor = dirname(cursor);
  }
  for (const fallback of ['/Applications/Summon Bot.app', join(process.env.HOME || '', 'Applications', 'Summon Bot.app')]) {
    if (fallback && existsSync(fallback)) return fallback;
  }
  return null;
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, filePath);
}

function normalizeCommitPrefix(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim().toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(value)) {
    reject('invalid_commit', 'expected_commit 必须是 4–40 位十六进制 Git commit 前缀');
  }
  return value;
}

function commitMatches(actual, expected) {
  if (!expected) return true;
  return typeof actual === 'string' && actual.trim().toLowerCase().startsWith(expected);
}

export class SelfUpdateService {
  constructor({ dataRoot, releaseRoot, platform }) {
    this.dataRoot = resolve(dataRoot);
    this.releaseRoot = resolve(releaseRoot);
    this.platform = platform;
    this.statePath = join(this.dataRoot, 'config', 'self-update.json');
    this.logPath = join(this.dataRoot, 'web', 'logs', 'self-update.log');
    this.downloadDir = join(tmpdir(), 'summon-self-update');
    this.activeDownload = null;
    this.downloadProgress = null;
    this.installScheduled = null;
    this.finalized = false;
  }

  hasScheduledInstall() {
    return Boolean(this.installScheduled && !this.installScheduled.signaled);
  }

  async readState() {
    const saved = await readJsonOptional(this.statePath).catch(() => null);
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }

  async saveState(patch) {
    const current = await this.readState();
    const next = { ...current, ...patch };
    await writeJsonAtomic(this.statePath, next);
    return next;
  }

  async currentRelease() {
    const release = await readJsonOptional(join(this.releaseRoot, 'release.json')).catch(() => null);
    const manifest = await readJsonOptional(join(this.releaseRoot, 'release-manifest.json')).catch(() => null);
    const target = hostTarget();
    const installDir = process.platform === 'win32'
      ? dirname(this.releaseRoot)
      : findMacAppBundle(this.releaseRoot);
    return {
      version: manifest?.version || release?.version || null,
      buildNumber: Number(manifest?.buildNumber ?? release?.buildNumber ?? 0) || 0,
      sourceCommit: manifest?.sourceCommit || null,
      buildId: manifest?.buildId || null,
      builtAt: manifest?.builtAt || null,
      githubRepository: release?.githubRepository || DEFAULT_GITHUB_REPO,
      target,
      installDir,
    };
  }

  async readLocalCandidate(target) {
    const root = join(this.dataRoot, 'client-releases');
    const currentFile = join(root, target.platform, target.arch, 'current.json');
    const record = await readJsonOptional(currentFile).catch(() => null);
    if (!record) return null;
    if (record.platform !== target.platform || record.arch !== target.arch
      || typeof record.directory !== 'string'
      || !/^release-[A-Za-z0-9._-]+$/.test(record.directory)
      || record.directory.endsWith('.')) {
      return null;
    }
    const metadata = validateRelease(record);
    const filePath = resolve(root, target.platform, target.arch, record.directory, metadata.mainFile);
    if (!existsSync(filePath)) return null;
    const expectedFile = metadata.files.find(file => file.name === metadata.mainFile);
    return {
      ...metadata,
      source: 'local',
      publishedAt: record.publishedAt || null,
      localFilePath: filePath,
      expectedSize: expectedFile?.size || null,
    };
  }

  async readGithubCandidate(repository, target) {
    const base = githubBase(repository, target.platform, target.arch);
    const tag = releaseTag(target.platform, target.arch);
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Summon-Bot',
      'Cache-Control': 'no-store',
    };
    const releaseRes = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (releaseRes.status === 404) return null;
    if (!releaseRes.ok) {
      throw new Error(`GitHub 版本查询失败（HTTP ${releaseRes.status}）`);
    }
    const release = await releaseRes.json();
    if (release.draft || release.tag_name !== tag) return null;
    const manifestUrl = `${base}latest.json?t=${Date.now()}`;
    const manifestRes = await fetch(manifestUrl, {
      headers: { 'User-Agent': 'Summon-Bot', 'Cache-Control': 'no-store' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!manifestRes.ok) {
      throw new Error(`GitHub 清单读取失败（HTTP ${manifestRes.status}）`);
    }
    const metadata = validateRelease(await manifestRes.json());
    if (metadata.platform !== target.platform || metadata.arch !== target.arch) {
      throw new Error('GitHub 发行包平台不匹配');
    }
    const downloadUrl = `${base}${encodeURIComponent(metadata.mainFile)}`;
    if (!downloadUrl.startsWith(base)) {
      throw new Error('发行包下载地址校验失败');
    }
    const expectedFile = metadata.files.find(file => file.name === metadata.mainFile);
    return {
      ...metadata,
      source: 'github',
      publishedAt: release.published_at || null,
      downloadUrl,
      expectedSize: expectedFile?.size || null,
    };
  }

  async check({ source = 'auto', expected_commit } = {}) {
    const current = await this.currentRelease();
    const expectedCommit = normalizeCommitPrefix(expected_commit);
    if (!current.target.supported) {
      return {
        action: 'check',
        supported: false,
        reason: current.target.reason,
        current: {
          version: current.version,
          buildNumber: current.buildNumber,
          sourceCommit: current.sourceCommit,
        },
      };
    }

    const errors = [];
    let localCandidate = null;
    let githubCandidate = null;

    if (source === 'auto' || source === 'local') {
      try {
        localCandidate = await this.readLocalCandidate(current.target);
      } catch (error) {
        errors.push(`local: ${error.message}`);
      }
    }
    if (source === 'auto' || source === 'github') {
      try {
        githubCandidate = await this.readGithubCandidate(current.githubRepository, current.target);
      } catch (error) {
        errors.push(`github: ${error.message}`);
      }
    }

    let selected = null;
    if (localCandidate && githubCandidate) {
      selected = githubCandidate.buildNumber > localCandidate.buildNumber ? githubCandidate : localCandidate;
    } else {
      selected = localCandidate || githubCandidate;
    }

    if (!selected) {
      const result = {
        action: 'check',
        supported: true,
        status: errors.length ? 'error' : 'no_release',
        checkedAt: new Date().toISOString(),
        current: {
          version: current.version,
          buildNumber: current.buildNumber,
          sourceCommit: current.sourceCommit,
        },
        latest: null,
        updateAvailable: false,
        ...(expectedCommit ? {
          expectedCommit,
          commitMatched: false,
          alreadyRunningCommit: commitMatches(current.sourceCommit, expectedCommit),
        } : {}),
        ...(errors.length ? { error: errors.join('；') } : {}),
      };
      await this.saveState({ lastCheck: result }).catch(() => {});
      return result;
    }

    const updateAvailable = selected.buildNumber > current.buildNumber;
    const matched = commitMatches(selected.sourceCommit, expectedCommit);
    const alreadyRunning = expectedCommit ? commitMatches(current.sourceCommit, expectedCommit) : false;

    const latestPublic = {
      version: selected.version,
      buildNumber: selected.buildNumber,
      sourceCommit: selected.sourceCommit,
      source: selected.source,
      mainFile: selected.mainFile,
      size: selected.expectedSize,
      publishedAt: selected.publishedAt,
    };

    const result = {
      action: 'check',
      supported: true,
      status: expectedCommit && !matched
        ? (alreadyRunning ? 'up_to_date' : 'commit_not_ready')
        : (updateAvailable ? 'update_available' : 'up_to_date'),
      checkedAt: new Date().toISOString(),
      current: {
        version: current.version,
        buildNumber: current.buildNumber,
        sourceCommit: current.sourceCommit,
      },
      latest: latestPublic,
      updateAvailable,
      ...(expectedCommit ? {
        expectedCommit,
        commitMatched: matched,
        alreadyRunningCommit: alreadyRunning,
      } : {}),
      ...(errors.length ? { warnings: errors } : {}),
      _candidate: selected,
    };

    const { _candidate, ...persisted } = result;
    await this.saveState({ lastCheck: persisted }).catch(() => {});
    return result;
  }

  async status() {
    const current = await this.currentRelease();
    const state = await this.readState();
    let downloaded = state.downloaded || null;
    if (downloaded?.filePath && !existsSync(downloaded.filePath)) {
      downloaded = null;
    }
    return {
      action: 'status',
      supported: current.target.supported,
      ...(current.target.supported ? {} : { reason: current.target.reason }),
      platform: current.target.platform,
      arch: current.target.arch,
      current: {
        version: current.version,
        buildNumber: current.buildNumber,
        sourceCommit: current.sourceCommit,
        buildId: current.buildId,
      },
      downloading: this.downloadProgress,
      downloaded: downloaded ? {
        version: downloaded.version,
        buildNumber: downloaded.buildNumber,
        sourceCommit: downloaded.sourceCommit,
        source: downloaded.source,
        size: downloaded.size,
        downloadedAt: downloaded.downloadedAt,
      } : null,
      scheduled: this.installScheduled ? {
        updateId: this.installScheduled.id,
        scheduledAt: new Date(this.installScheduled.scheduledAt).toISOString(),
        drainSignaled: this.installScheduled.signaled,
      } : null,
      lastCheck: state.lastCheck || null,
      lastResult: state.lastResult || null,
    };
  }

  async cleanOldInstallers(keepFileName) {
    if (!existsSync(this.downloadDir)) return;
    const entries = await readdir(this.downloadDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === keepFileName) continue;
      if (/\.(?:exe|dmg|part)$/i.test(entry.name)) {
        await rm(join(this.downloadDir, entry.name), { force: true }).catch(() => {});
      }
    }
  }

  async download({ source = 'auto', expected_commit, force = false } = {}) {
    if (this.activeDownload) {
      return await this.activeDownload;
    }
    const task = (async () => {
      const checked = await this.check({ source, expected_commit });
      if (!checked.supported) return { ...checked, action: 'download', downloaded: false };
      if (!checked._candidate) {
        return { ...checked, action: 'download', downloaded: false };
      }
      if (checked.status === 'commit_not_ready') {
        const { _candidate, ...rest } = checked;
        return {
          ...rest,
          action: 'download',
          downloaded: false,
          message: `最新可用包为 v${rest.latest.version} (${rest.latest.buildNumber}, commit ${String(rest.latest.sourceCommit || '未知').slice(0, 7)})，尚未包含目标提交 ${rest.expectedCommit}，请等待 GitHub Actions 构建完成后重试。`,
        };
      }
      if (!checked.updateAvailable && !force) {
        const { _candidate, ...rest } = checked;
        return {
          ...rest,
          action: 'download',
          downloaded: false,
          message: `当前已是最新版本 v${rest.current.version} (${rest.current.buildNumber})。`,
        };
      }

      const candidate = checked._candidate;
      await mkdir(this.downloadDir, { recursive: true });
      const fileName = `Summon-Bot-${candidate.version}-${candidate.buildNumber}-${candidate.platform}-${candidate.arch}${checked.current ? (candidate.platform === 'macos' ? '.dmg' : '.exe') : ''}`;
      const finalPath = join(this.downloadDir, fileName);

      // Reuse already-downloaded matching file if intact
      if (existsSync(finalPath)) {
        const info = await stat(finalPath).catch(() => null);
        if (info?.isFile() && info.size > 0 && (!candidate.expectedSize || info.size === candidate.expectedSize)) {
          const downloadedMeta = {
            filePath: finalPath,
            fileName,
            version: candidate.version,
            buildNumber: candidate.buildNumber,
            sourceCommit: candidate.sourceCommit,
            source: candidate.source,
            size: info.size,
            downloadedAt: new Date().toISOString(),
          };
          await this.saveState({ downloaded: downloadedMeta });
          await this.cleanOldInstallers(fileName);
          return {
            action: 'download',
            supported: true,
            status: 'downloaded',
            downloaded: true,
            reused: true,
            current: checked.current,
            latest: checked.latest,
            size: info.size,
          };
        }
      }

      const partPath = `${finalPath}.${process.pid}.part`;
      this.downloadProgress = {
        version: candidate.version,
        buildNumber: candidate.buildNumber,
        source: candidate.source,
        percent: 0,
        startedAt: new Date().toISOString(),
      };

      try {
        if (candidate.source === 'local') {
          await copyFile(candidate.localFilePath, partPath);
          this.downloadProgress.percent = 100;
        } else {
          const res = await fetch(candidate.downloadUrl, {
            headers: { 'User-Agent': 'Summon-Bot' },
            signal: AbortSignal.timeout(600_000),
          });
          if (!res.ok || !res.body) {
            throw new Error(`下载安装包失败（HTTP ${res.status}）`);
          }
          const total = Number(res.headers.get('content-length')) || candidate.expectedSize || 0;
          let received = 0;
          const out = createWriteStream(partPath);
          const readable = Readable.fromWeb(res.body);
          readable.on('data', chunk => {
            received += chunk.length;
            if (total > 0 && this.downloadProgress) {
              this.downloadProgress.percent = Math.min(99, Math.floor((received * 100) / total));
            }
          });
          await pipeline(readable, out);
        }

        const info = await stat(partPath);
        if (!info.size || (candidate.expectedSize && info.size !== candidate.expectedSize)) {
          throw new Error(`安装包大小校验失败（实际 ${info.size} 字节，预期 ${candidate.expectedSize} 字节）`);
        }
        await rename(partPath, finalPath);
        await this.cleanOldInstallers(fileName);

        const downloadedMeta = {
          filePath: finalPath,
          fileName,
          version: candidate.version,
          buildNumber: candidate.buildNumber,
          sourceCommit: candidate.sourceCommit,
          source: candidate.source,
          size: info.size,
          downloadedAt: new Date().toISOString(),
        };
        await this.saveState({ downloaded: downloadedMeta });

        return {
          action: 'download',
          supported: true,
          status: 'downloaded',
          downloaded: true,
          reused: false,
          current: checked.current,
          latest: checked.latest,
          size: info.size,
        };
      } catch (error) {
        await rm(partPath, { force: true }).catch(() => {});
        throw error;
      } finally {
        this.downloadProgress = null;
      }
    })();

    this.activeDownload = task;
    try {
      return await task;
    } finally {
      if (this.activeDownload === task) this.activeDownload = null;
    }
  }

  resolveRoomId(args, context) {
    if (args.room) {
      return typeof args.room === 'string' ? args.room : args.room.id || null;
    }
    if (context?.conversation?.space?.kind === 'room') {
      return context.conversation.space.id;
    }
    return null;
  }

  async install(args = {}, context = {}) {
    if (context.session) {
      reject('update_forbidden', '工作引擎子会话不可直接触发宿主自更新，请返回结果交由主对话 Bot 发起', 403);
    }
    if (this.installScheduled) {
      reject('update_already_scheduled', '本机自更新已安排执行，请等待重启完成', 409);
    }

    const current = await this.currentRelease();
    if (!current.target.supported) {
      reject('update_unsupported', current.target.reason, 400);
    }

    const source = args.source || 'auto';
    const expectedCommit = normalizeCommitPrefix(args.expected_commit);
    const force = args.force === true;
    const rawTimeout = Number(args.drain_timeout_ms);
    const drainTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.max(MIN_DRAIN_TIMEOUT_MS, Math.min(MAX_DRAIN_TIMEOUT_MS, Math.round(rawTimeout)))
      : DEFAULT_DRAIN_TIMEOUT_MS;

    const dl = await this.download({ source, expected_commit: expectedCommit, force });
    if (!dl.downloaded) {
      return {
        ...dl,
        action: 'install',
        scheduled: false,
      };
    }

    const state = await this.readState();
    const downloaded = state.downloaded;
    if (!downloaded?.filePath || !existsSync(downloaded.filePath)) {
      reject('installer_missing', '已下载的安装包文件不存在，请重新下载', 500);
    }

    const updateId = randomUUID();
    const roomId = this.resolveRoomId(args, context);
    const drainReadyFile = join(this.downloadDir, `drain-ready-${updateId}`);
    const scheduledAt = Date.now();

    const pending = {
      id: updateId,
      status: 'scheduled',
      fromVersion: current.version,
      fromBuildNumber: current.buildNumber,
      fromCommit: current.sourceCommit,
      toVersion: downloaded.version,
      toBuildNumber: downloaded.buildNumber,
      toCommit: downloaded.sourceCommit,
      source: downloaded.source,
      force,
      installerPath: downloaded.filePath,
      roomId,
      triggeredBy: context.actor || { kind: 'user', id: 'user' },
      scheduledAt: new Date(scheduledAt).toISOString(),
      notified: false,
    };

    await this.saveState({ pending });

    try {
      await this.spawnDetachedUpdater({
        updateId,
        target: current.target,
        installerPath: downloaded.filePath,
        installDir: current.installDir,
        drainReadyFile,
        drainTimeoutMs,
      });
    } catch (error) {
      await this.saveState({ pending: null }).catch(() => {});
      reject('updater_spawn_failed', `无法启动独立更新进程：${error.message}`, 500);
    }

    this.installScheduled = {
      id: updateId,
      drainReadyFile,
      scheduledAt,
      drainTimeoutMs,
      signaled: false,
    };

    return {
      action: 'install',
      scheduled: true,
      updateId,
      fromVersion: current.version,
      fromBuildNumber: current.buildNumber,
      toVersion: downloaded.version,
      toBuildNumber: downloaded.buildNumber,
      toCommit: downloaded.sourceCommit,
      source: downloaded.source,
      roomId,
      drainTimeoutMs,
      guidance: '独立更新进程已启动，将在本回合结束并排空后自动静默安装并重启 Summon Bot（预计 20–30 秒）。请立刻简短回复宿主即将重启更新并结束本回合，重启上线后系统会自动往本房间回传升级结果。',
    };
  }

  async spawnDetachedUpdater({ updateId, target, installerPath, installDir, drainReadyFile, drainTimeoutMs }) {
    await mkdir(this.downloadDir, { recursive: true });
    await mkdir(dirname(this.logPath), { recursive: true });
    const drainTimeoutSec = Math.ceil(drainTimeoutMs / 1000);

    if (target.platform === 'windows') {
      const scriptPath = join(this.downloadDir, `apply-${updateId}.ps1`);
      const script = [
        '$ErrorActionPreference = "Continue"',
        `$updateId = ${psSingleQuote(updateId)}`,
        `$statePath = ${psSingleQuote(this.statePath)}`,
        `$logPath = ${psSingleQuote(this.logPath)}`,
        `$installerPath = ${psSingleQuote(installerPath)}`,
        `$dataRoot = ${psSingleQuote(this.dataRoot)}`,
        `$releaseRoot = ${psSingleQuote(this.releaseRoot)}`,
        `$installDir = ${psSingleQuote(installDir || dirname(this.releaseRoot))}`,
        `$drainReadyFile = ${psSingleQuote(drainReadyFile)}`,
        `$drainTimeoutSec = ${drainTimeoutSec}`,
        'function Write-Log([string]$msg) {',
        '  $line = "[{0}] [{1}] {2}" -f (Get-Date).ToString("o"), $updateId, $msg',
        '  try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch {}',
        '}',
        'Write-Log "Detached self-updater started. Target installer: $installerPath"',
        'Start-Sleep -Seconds 3',
        '$deadline = (Get-Date).AddSeconds($drainTimeoutSec)',
        'while (-not (Test-Path -LiteralPath $drainReadyFile) -and (Get-Date) -lt $deadline) {',
        '  Start-Sleep -Milliseconds 500',
        '}',
        'if (Test-Path -LiteralPath $drainReadyFile) {',
        '  Write-Log "Drain sentinel detected; proceeding with update."',
        '  Remove-Item -LiteralPath $drainReadyFile -Force -ErrorAction SilentlyContinue',
        '} else {',
        '  Write-Log "Drain wait reached timeout ($drainTimeoutSec s); proceeding with update."',
        '}',
        '$stopScript = Join-Path $releaseRoot "Stop.ps1"',
        'if (Test-Path -LiteralPath $stopScript) {',
        '  Write-Log "Stopping local runtime via Stop.ps1"',
        '  try { & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $stopScript -DataRoot $dataRoot | Out-Null } catch { Write-Log "Stop.ps1 warning: $_" }',
        '}',
        'Get-Process -Name "summon-bot-tauri" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
        'Start-Sleep -Milliseconds 1200',
        '$exitCode = -1',
        'try {',
        '  Write-Log "Launching silent NSIS installer: $installerPath /S"',
        '  $proc = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru',
        '  $exitCode = $proc.ExitCode',
        '  Write-Log "NSIS installer exited with code $exitCode"',
        '} catch {',
        '  Write-Log "Installer execution failed: $_"',
        '}',
        'try {',
        '  if (Test-Path -LiteralPath $statePath) {',
        '    $st = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json',
        '    if ($st.pending -and $st.pending.id -eq $updateId) {',
        '      $st.pending | Add-Member -NotePropertyName updaterExitCode -NotePropertyValue $exitCode -Force',
        '      $st.pending | Add-Member -NotePropertyName updaterFinishedAt -NotePropertyValue ((Get-Date).ToString("o")) -Force',
        '      $tmp = "$statePath.upd.tmp"',
        '      ($st | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $tmp -Encoding UTF8',
        '      Move-Item -LiteralPath $tmp -Destination $statePath -Force',
        '    }',
        '  }',
        '} catch { Write-Log "Failed to record exit code: $_" }',
        '# Give NSIS_HOOK_POSTINSTALL a moment to launch the new Tauri app; ensure service comes back up if not.',
        '$restarted = $false',
        'for ($i = 0; $i -lt 12; $i++) {',
        '  Start-Sleep -Seconds 1',
        '  if (Get-Process -Name "summon-bot-tauri" -ErrorAction SilentlyContinue) { $restarted = $true; break }',
        '  try {',
        '    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8787/api/bootstrap" -TimeoutSec 1 -ErrorAction Stop',
        '    if ($r.StatusCode -eq 200) { $restarted = $true; break }',
        '  } catch {}',
        '}',
        'if (-not $restarted) {',
        '  $tauriExe = Join-Path $installDir "summon-bot-tauri.exe"',
        '  $hiddenVbs = Join-Path $releaseRoot "Start-Hidden.vbs"',
        '  if (Test-Path -LiteralPath $tauriExe) {',
        '    Write-Log "Fallback launching $tauriExe"',
        '    Start-Process -FilePath $tauriExe',
        '  } elseif (Test-Path -LiteralPath $hiddenVbs) {',
        '    Write-Log "Fallback launching $hiddenVbs"',
        '    Start-Process -FilePath "wscript.exe" -ArgumentList @($hiddenVbs, $dataRoot)',
        '  }',
        '} else {',
        '  Write-Log "New Summon instance detected online."',
        '}',
        'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
      ].join('\r\n');

      await writeFile(scriptPath, `\uFEFF${script}`, 'utf8');
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return;
    }

    if (target.platform === 'macos') {
      const targetApp = installDir || findMacAppBundle(this.releaseRoot);
      if (!targetApp) {
        throw new Error('未找到本机 Summon Bot.app 安装路径，无法自动替换');
      }
      const scriptPath = join(this.downloadDir, `apply-${updateId}.sh`);
      const script = [
        '#!/bin/sh',
        `UPDATE_ID=${shSingleQuote(updateId)}`,
        `LOG_PATH=${shSingleQuote(this.logPath)}`,
        `DMG_PATH=${shSingleQuote(installerPath)}`,
        `TARGET_APP=${shSingleQuote(targetApp)}`,
        `RELEASE_ROOT=${shSingleQuote(this.releaseRoot)}`,
        `DRAIN_READY=${shSingleQuote(drainReadyFile)}`,
        `DRAIN_TIMEOUT=${drainTimeoutSec}`,
        `SCRIPT_PATH=${shSingleQuote(scriptPath)}`,
        'log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [$UPDATE_ID] $1" >> "$LOG_PATH" 2>/dev/null || true; }',
        'log "Detached macOS self-updater started. DMG=$DMG_PATH TARGET=$TARGET_APP"',
        'sleep 3',
        'WAITED=0',
        'while [ ! -f "$DRAIN_READY" ] && [ "$WAITED" -lt $((DRAIN_TIMEOUT * 2)) ]; do',
        '  sleep 0.5',
        '  WAITED=$((WAITED + 1))',
        'done',
        'rm -f "$DRAIN_READY" 2>/dev/null || true',
        'if [ -x "$RELEASE_ROOT/runtime/node" ] && [ -f "$RELEASE_ROOT/tauri-boot-helper.mjs" ]; then',
        '  "$RELEASE_ROOT/runtime/node" "$RELEASE_ROOT/tauri-boot-helper.mjs" --stop-local --runtime "$RELEASE_ROOT" >/dev/null 2>&1 || true',
        'fi',
        'osascript -e \'tell application "Summon Bot" to quit\' >/dev/null 2>&1 || true',
        'sleep 2',
        'pkill -f "Summon Bot.app/Contents/MacOS/" >/dev/null 2>&1 || true',
        'sleep 1',
        'MNT_DIR=$(mktemp -d /tmp/summon-self-update-mnt.XXXXXX)',
        'cleanup() {',
        '  if [ -n "$MNT_DIR" ] && [ -d "$MNT_DIR" ]; then',
        '    hdiutil detach "$MNT_DIR" -quiet 2>/dev/null || hdiutil detach "$MNT_DIR" -force -quiet 2>/dev/null || true',
        '    rmdir "$MNT_DIR" 2>/dev/null || true',
        '  fi',
        '  rm -f "$SCRIPT_PATH" 2>/dev/null || true',
        '}',
        'trap cleanup EXIT',
        'if ! hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MNT_DIR" -quiet; then',
        '  log "Failed to mount DMG"',
        '  open -a "$TARGET_APP" >/dev/null 2>&1 || true',
        '  exit 1',
        'fi',
        'SRC_APP="$MNT_DIR/Summon Bot.app"',
        'if [ ! -d "$SRC_APP" ]; then SRC_APP=$(find "$MNT_DIR" -maxdepth 1 -name "*.app" | head -n 1); fi',
        'if [ -z "$SRC_APP" ] || [ ! -d "$SRC_APP" ]; then',
        '  log "No .app found inside DMG"',
        '  open -a "$TARGET_APP" >/dev/null 2>&1 || true',
        '  exit 1',
        'fi',
        'STAGING="${TARGET_APP}.updating"',
        'BACKUP="${TARGET_APP}.old"',
        'rm -rf "$STAGING" "$BACKUP" 2>/dev/null || true',
        'if ! ditto "$SRC_APP" "$STAGING"; then',
        '  log "ditto failed"',
        '  rm -rf "$STAGING" 2>/dev/null || true',
        '  open -a "$TARGET_APP" >/dev/null 2>&1 || true',
        '  exit 1',
        'fi',
        'if [ -d "$TARGET_APP" ]; then',
        '  if ! mv "$TARGET_APP" "$BACKUP"; then',
        '    log "mv target to backup failed"',
        '    rm -rf "$STAGING" 2>/dev/null || true',
        '    open -a "$TARGET_APP" >/dev/null 2>&1 || true',
        '    exit 1',
        '  fi',
        'fi',
        'if ! mv "$STAGING" "$TARGET_APP"; then',
        '  log "mv staging to target failed; restoring backup"',
        '  [ -d "$BACKUP" ] && mv "$BACKUP" "$TARGET_APP" 2>/dev/null || true',
        '  open -a "$TARGET_APP" >/dev/null 2>&1 || true',
        '  exit 1',
        'fi',
        'rm -rf "$BACKUP" 2>/dev/null || true',
        'log "macOS bundle replaced successfully; relaunching"',
        'open -a "$TARGET_APP" >/dev/null 2>&1 || true',
      ].join('\n');

      await writeFile(scriptPath, script, 'utf8');
      await chmod(scriptPath, 0o700);
      const child = spawn('/bin/sh', [scriptPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }

    throw new Error(`不支持的平台：${target.platform}`);
  }

  onTick() {
    const scheduled = this.installScheduled;
    if (!scheduled || scheduled.signaled) return;
    if (Date.now() - scheduled.scheduledAt < MIN_SETTLE_MS) return;

    const activeRuns = this.platform?.runtime?.active?.size || 0;
    const flushing = Boolean(this.platform?.deliveries?.flushing);
    const pendingModels = (this.platform?.resources?.recordCurrentUsage?.()?.pending || [])
      .filter(item => item.resource === 'models').length;

    if (activeRuns === 0 && !flushing && pendingModels === 0) {
      scheduled.signaled = true;
      void writeFile(scheduled.drainReadyFile, new Date().toISOString(), 'utf8').catch(() => {});
    }
  }

  async finalizeAfterStartup() {
    if (this.finalized) return;
    this.finalized = true;
    const state = await this.readState();
    const pending = state.pending;
    if (!pending || pending.notified) return;

    // Guard against notifying in the same process before restart actually occurred
    const scheduledAtMs = Date.parse(pending.scheduledAt || '');
    if (Number.isFinite(scheduledAtMs) && Date.now() - scheduledAtMs < 5000) return;

    const current = await this.currentRelease();
    const exitCode = pending.updaterExitCode;
    const exitOk = exitCode === undefined || exitCode === null || exitCode === 0;
    const versionAdvanced = current.buildNumber >= pending.toBuildNumber
      && (current.buildNumber > pending.fromBuildNumber || (pending.force && exitOk));
    const commitOk = !pending.toCommit || !current.sourceCommit
      || current.sourceCommit.toLowerCase().startsWith(String(pending.toCommit).slice(0, 7).toLowerCase());
    const succeeded = Boolean(versionAdvanced && commitOk && exitOk);

    const lastResult = {
      id: pending.id,
      status: succeeded ? 'succeeded' : 'failed',
      fromVersion: pending.fromVersion,
      fromBuildNumber: pending.fromBuildNumber,
      toVersion: pending.toVersion,
      toBuildNumber: pending.toBuildNumber,
      actualVersion: current.version,
      actualBuildNumber: current.buildNumber,
      actualCommit: current.sourceCommit,
      updaterExitCode: exitCode ?? null,
      roomId: pending.roomId || null,
      completedAt: new Date().toISOString(),
    };

    await this.saveState({ pending: null, lastResult }).catch(() => {});

    if (!pending.roomId || !this.platform?.room) return;
    try {
      const roomRecord = this.platform.store.get('rooms', pending.roomId);
      if (!roomRecord || roomRecord.archivedAt) return;
      const members = Array.isArray(roomRecord.members) ? roomRecord.members : [];
      const senderId = (pending.triggeredBy?.kind === 'bot' && members.includes(pending.triggeredBy.id))
        ? pending.triggeredBy.id
        : (roomRecord.lead_bot_id && members.includes(roomRecord.lead_bot_id)
          ? roomRecord.lead_bot_id
          : members.find(id => id !== 'user'));
      if (!senderId) return;

      const text = succeeded
        ? `本机自更新已完成并重启上线：v${pending.fromVersion || '?'} (${pending.fromBuildNumber}) → v${current.version || '?'} (${current.buildNumber})。`
        : `本机自更新未能生效（当前仍为 v${current.version || '?'} (${current.buildNumber})，目标 v${pending.toVersion || '?'} (${pending.toBuildNumber})${exitCode !== undefined && exitCode !== null ? `，安装器退出码 ${exitCode}` : ''}），可查看 web/logs/self-update.log 排查。`;

      this.platform.room.send(pending.roomId, { text }, senderId);
    } catch (error) {
      console.warn(`Failed to post self-update receipt: ${error?.message || error}`);
    }
  }

  async execute(args, context) {
    const action = args.action;
    if (action === 'status') return this.status();
    if (action === 'check') {
      const result = await this.check(args);
      const { _candidate, ...clean } = result;
      return clean;
    }
    if (action === 'download') return this.download(args);
    if (action === 'install') return this.install(args, context);
    reject('invalid_update_action', `不支持的更新操作：${action}`);
  }
}
