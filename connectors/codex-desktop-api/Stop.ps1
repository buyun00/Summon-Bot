$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskPath '\' -TaskName 'Codex Desktop API' -ErrorAction Stop
$launcher = Join-Path $PSScriptRoot 'Run-Hidden.vbs'
if (!@($task.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains($launcher) }).Count) { throw 'Scheduled task belongs to another connector installation.' }
Stop-ScheduledTask -TaskPath '\' -TaskName $task.TaskName
Start-Sleep -Milliseconds 800
$pidPath = 'D:\Relay-Bot-data\connectors\codex-desktop-api\server.pid'
if (Test-Path -LiteralPath $pidPath) {
    $bridgePid = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid"
    if ($process) {
        if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'D:\\Relay-Bot-app\\releases\\[^\\]+\\connectors\\codex-desktop-api\\src\\main\.js') { throw 'Recorded PID belongs to another process.' }
        $bridgeManagedProcess = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
        if ($bridgeManagedProcess) {
            try {
                Stop-Process -Id $bridgePid
                if (!$bridgeManagedProcess.WaitForExit(10000)) { throw 'Connector process has not exited; leave its release directory in place.' }
            } finally { $bridgeManagedProcess.Dispose() }
        }
    }
    # The exiting process or another stop may already have removed its PID file.
    try { Remove-Item -LiteralPath $pidPath -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { }
}
Write-Output 'Relay Codex connector stopped. Codex desktop was not stopped.'
