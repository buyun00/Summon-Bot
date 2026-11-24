import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Scoped setup commands own their descendants, including detached Start-Process children.
export const windowsProcessJob = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SummonSetupJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr ownedJob;
  public static void Attach() {
    ownedJob = CreateJobObject(IntPtr.Zero, null);
    if (ownedJob == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(ownedJob, 9, ref limits, (uint)Marshal.SizeOf(limits)) || !AssignProcessToJobObject(ownedJob, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(ownedJob);
      throw new Win32Exception(error);
    }
  }
}
'@
[SummonSetupJob]::Attach()
`;

export function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^SUMMON_/i.test(key) &&
    !/(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|AUTHORIZATION|PRIVATE[_-]?KEY)/i.test(key)));
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

export async function terminatePidTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    return new Promise(resolveDone => {
      const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => {
        try { process.kill(pid, 'SIGKILL'); resolveDone(true); } catch { resolveDone(false); }
      });
      killer.once('close', code => resolveDone(code === 0 || !isProcessAlive(pid)));
    });
  }
  try { process.kill(-pid, 'SIGKILL'); return true; }
  catch {
    try { process.kill(pid, 'SIGKILL'); return true; } catch { return !isProcessAlive(pid); }
  }
}

export async function terminateTree(child) {
  if (!child?.pid) return false;
  return terminatePidTree(child.pid);
}

/**
 * Attaches a spawned Windows process PID to an OS Job Object configured with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so closing the holder atomically
 * terminates the target process and all descendants (including detached shells).
 */
export function attachWindowsJob(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SummonChildJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static IntPtr Attach(int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) { CloseHandle(job); return IntPtr.Zero; }
    IntPtr proc = OpenProcess(0x0101, false, pid);
    if (proc == IntPtr.Zero) { CloseHandle(job); return IntPtr.Zero; }
    bool ok = AssignProcessToJobObject(job, proc);
    CloseHandle(proc);
    if (!ok) { CloseHandle(job); return IntPtr.Zero; }
    return job;
  }
  public static void Kill(IntPtr job) {
    if (job != IntPtr.Zero) { TerminateJobObject(job, 1); CloseHandle(job); }
  }
  public static void Release(IntPtr job) {
    if (job != IntPtr.Zero) CloseHandle(job);
  }
}
'@
$job = [SummonChildJob]::Attach(${pid})
if ($job -eq [IntPtr]::Zero) { exit 0 }
$cmd = [Console]::In.ReadLine()
if ($cmd -eq 'kill') { [SummonChildJob]::Kill($job) } else { [SummonChildJob]::Release($job) }
`;
  try {
    const holder = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    holder.stdin?.on('error', () => {});
    holder.on('error', () => {});
    let closed = false;
    return {
      kill() {
        if (closed) return;
        closed = true;
        try { holder.stdin?.end('kill\n'); } catch {}
        setTimeout(() => { try { holder.kill(); } catch {} }, 2_000).unref?.();
      },
      release() {
        if (closed) return;
        closed = true;
        try { holder.stdin?.end('release\n'); } catch {}
        setTimeout(() => { try { holder.kill(); } catch {} }, 2_000).unref?.();
      },
    };
  } catch { return null; }
}
