param(
    [Parameter(Mandatory=$true)][string]$AppRoot,
    [Parameter(Mandatory=$true)][string]$DataRoot,
    [string]$HubRoot = 'C:\Users\win11\Documents\Codex\StartupHub'
)
$ErrorActionPreference = 'Stop'
$AppRoot = [IO.Path]::GetFullPath($AppRoot)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$relayLauncher = Join-Path $AppRoot 'Start.ps1'
$relayItemsPath = Join-Path $HubRoot 'items.json'
if (!(Test-Path -LiteralPath $relayLauncher) -or !(Test-Path -LiteralPath (Join-Path $AppRoot 'current.json'))) { throw 'Install a verified release first.' }
$relayItems = @(Get-Content -LiteralPath $relayItemsPath -Raw -Encoding utf8 | ConvertFrom-Json)
$relayEntry = @($relayItems | Where-Object { $_.id -eq 'relay-bot' })
if ($relayEntry.Count -ne 1) { throw 'Expected exactly one existing Relay item in StartupHub.' }
$relayOtherBefore = @($relayItems | Where-Object { $_.id -ne 'relay-bot' }) | ConvertTo-Json -Depth 20 -Compress
$relayEntry = $relayEntry[0]
$relayTask = Get-ScheduledTask -TaskName $relayEntry.taskName -TaskPath $relayEntry.taskPath -ErrorAction Stop
if (@($relayTask.Triggers | Where-Object { $null -ne $_ }).Count) { throw 'Review existing independent triggers before changing this task.' }
$relayShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$relayArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Foreground -RespectIntent -DataRoot "{1}"' -f $relayLauncher,$DataRoot
$relayAction = New-ScheduledTaskAction -Execute $relayShell -Argument $relayArguments -WorkingDirectory $AppRoot
$relaySettings = $relayTask.Settings
$relaySettings.ExecutionTimeLimit = 'PT0S'
$relaySettings.MultipleInstances = 2 # IgnoreNew
$relaySettings.RestartCount = 999
$relaySettings.RestartInterval = 'PT1M'
Set-ScheduledTask -TaskName $relayEntry.taskName -TaskPath $relayEntry.taskPath -Action $relayAction -Settings $relaySettings | Out-Null
$relayEntry.purpose = 'Relay Bot Web and gateway watchdog; automatic recovery; http://127.0.0.1:8787'
# The user explicitly requested no backup copies; preserve all unrelated items in place.
$relaySerialized = $relayItems | ConvertTo-Json -Depth 20
$relayRoundTrip = @($relaySerialized | ConvertFrom-Json)
$relayOtherAfter = @($relayRoundTrip | Where-Object { $_.id -ne 'relay-bot' }) | ConvertTo-Json -Depth 20 -Compress
if ($relayOtherBefore -cne $relayOtherAfter) { throw 'Unrelated StartupHub entries changed during serialization.' }
[IO.File]::WriteAllText($relayItemsPath, $relaySerialized, [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ Task=$relayEntry.taskName; AutoStart=$relayEntry.autoStart; Launcher=$relayLauncher; OtherItemsPreserved=($relayOtherBefore -ceq $relayOtherAfter); IndependentTriggers=0 }
