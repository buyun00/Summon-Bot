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
    !/(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|AUTHORIZATION|PRIVATE[_-]?KEY)/i.test(key) &&
    !/^(?:AWS_|AZURE_|GOOGLE_|GITHUB_|SSH_|GIT_ASKPASS$|BASH_ENV$|ENV$|NODE_OPTIONS$|PYTHONSTARTUP$|NPM_CONFIG_USERCONFIG$)/i.test(key)));
}

export async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolveDone => {
      const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolveDone(); });
      killer.once('close', resolveDone);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
