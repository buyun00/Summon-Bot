$ErrorActionPreference = 'Stop'
$relayPidPath = Join-Path $PSScriptRoot '.relay\server.pid'
if (!(Test-Path -LiteralPath $relayPidPath)) { Write-Output '没有后台启动记录。'; exit 0 }
$relayProcessId = [int](Get-Content -LiteralPath $relayPidPath -Raw)
$relayProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$relayProcessId" -ErrorAction SilentlyContinue
$relayEntry = Join-Path $PSScriptRoot 'src\server.mjs'
if ($relayProcess -and $relayProcess.CommandLine.Contains($relayEntry)) {
    # Terminate only this service and its executor children, never the desktop Codex server.
    & taskkill.exe /PID $relayProcessId /T /F | Out-Null
    Write-Output 'Relay Bot 已停止；未完成执行将在下次启动显示为已中断。'
} elseif ($relayProcess) { throw 'PID 已属于其他进程，未进行停止操作。' }
Remove-Item -LiteralPath $relayPidPath -Force
