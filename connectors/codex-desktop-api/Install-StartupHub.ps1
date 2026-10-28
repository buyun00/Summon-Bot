param([string]$HubRoot = 'C:\Users\win11\Documents\Codex\StartupHub')
$ErrorActionPreference = 'Stop'
$itemsPath = Join-Path $HubRoot 'items.json'
$items = @(Get-Content -LiteralPath $itemsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
$matches = @($items | Where-Object { $_.id -eq 'codex-desktop-api' })
if ($matches.Count -ne 1) { throw 'Expected one existing Codex API entry in Startup Hub.' }
$entry = $matches[0]
$task = Get-ScheduledTask -TaskPath $entry.taskPath -TaskName $entry.taskName -ErrorAction Stop
$launcher = Join-Path $PSScriptRoot 'Run-Hidden.vbs'
$knownLaunchers = @($launcher, 'D:\Codex-Desktop-API\Run-Startup.ps1')
if (!@($task.Actions | Where-Object { $action = $_; @($knownLaunchers | Where-Object { $action.Arguments -and $action.Arguments.Contains($_) }).Count }).Count) { throw 'The existing task is not a recognized Codex API launcher.' }
if (@($task.Triggers | Where-Object { $null -ne $_ }).Count) { throw 'Unexpected independent triggers; leave them unchanged and inspect.' }
if ($task.State -eq 'Running') { throw 'Stop the current connector before changing its launcher.' }
$hub = Get-ScheduledTask -TaskName 'Startup Hub' -ErrorAction Stop
if (!@($hub.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains((Join-Path $HubRoot 'Start.ps1')) }).Count) { throw 'Startup Hub points to a different installation.' }
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('//B //NoLogo "{0}"' -f $launcher) -WorkingDirectory $PSScriptRoot
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
Set-ScheduledTask -TaskPath $entry.taskPath -TaskName $entry.taskName -Action $action -Settings $settings | Out-Null
$entry.name = 'Relay Bot · Codex 连接器'
$entry.purpose = 'Relay-Bot 内置 Codex 桌面连接器，无控制台窗口；http://127.0.0.1:47831/'
# Preserve autoStart and every unrelated entry. No backups or hash scans.
[IO.File]::WriteAllText($itemsPath, (ConvertTo-Json -InputObject $items -Depth 20), [Text.UTF8Encoding]::new($false))
& (Join-Path $PSScriptRoot 'Start.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Connector did not start.' }
[pscustomobject]@{ Task = $entry.taskName; AutoStart = $entry.autoStart; Launcher = $launcher; IndependentTriggers = 0 }
