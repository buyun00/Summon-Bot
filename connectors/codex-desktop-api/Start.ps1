$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskPath '\' -TaskName 'Codex Desktop API' -ErrorAction Stop
$launcher = Join-Path $PSScriptRoot 'Run-Hidden.vbs'
if (!@($task.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains($launcher) }).Count) { throw 'Register this project connector with Install-StartupHub.ps1 first.' }
if ($task.State -eq 'Disabled') { throw 'The connector is disabled in Task Scheduler.' }
if ($task.State -ne 'Running') { Start-ScheduledTask -TaskPath '\' -TaskName $task.TaskName }
$deadline = (Get-Date).AddSeconds(45)
do {
    $pidPath = 'D:\Relay-Bot-data\connectors\codex-desktop-api\server.pid'
    if (Test-Path -LiteralPath $pidPath) {
        $bridgePid = [int](Get-Content -LiteralPath $pidPath -Raw)
        $listener = Get-NetTCPConnection -LocalPort 47831 -State Listen -ErrorAction SilentlyContinue
        if ($listener | Where-Object OwningProcess -eq $bridgePid) { Write-Output 'Summon Bot Codex connector ready at http://127.0.0.1:47831'; exit 0 }
    }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
throw 'Connector startup timed out. Inspect D:\Relay-Bot-data\connectors\codex-desktop-api\startup.log and server-error.log.'
