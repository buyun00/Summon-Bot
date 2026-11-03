param(
    [Parameter(Mandatory=$true)][string]$AppRoot,
    [Parameter(Mandatory=$true)][string]$DataRoot,
    [string]$HubRoot = 'C:\Users\win11\Documents\Codex\StartupHub'
)
$ErrorActionPreference = 'Stop'
$AppRoot = [IO.Path]::GetFullPath($AppRoot)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$summonLauncher = Join-Path $AppRoot 'Start-Hidden.vbs'
$summonItemsPath = Join-Path $HubRoot 'items.json'
if (!(Test-Path -LiteralPath $summonLauncher) -or !(Test-Path -LiteralPath (Join-Path $AppRoot 'Start.ps1')) -or !(Test-Path -LiteralPath (Join-Path $AppRoot 'current.json'))) { throw 'Install a release first.' }
$summonItems = @(Get-Content -LiteralPath $summonItemsPath -Raw -Encoding utf8 | ConvertFrom-Json)
$summonEntry = @($summonItems | Where-Object { $_.id -eq 'summon-bot' })
if ($summonEntry.Count -ne 1) { throw 'Expected exactly one existing Summon Bot item in StartupHub.' }
$summonOtherBefore = @($summonItems | Where-Object { $_.id -ne 'summon-bot' }) | ConvertTo-Json -Depth 20 -Compress
$summonEntry = $summonEntry[0]
if ($summonEntry.taskName -ne 'Summon Bot') { throw 'Update the existing StartupHub task to Summon Bot before registration.' }
$summonEntry.name = 'Summon Bot 工作台'
$summonTask = Get-ScheduledTask -TaskName $summonEntry.taskName -TaskPath $summonEntry.taskPath -ErrorAction Stop
if (@($summonTask.Triggers | Where-Object { $null -ne $_ }).Count) { throw 'Review existing independent triggers before changing this task.' }
$summonShell = Join-Path $env:SystemRoot 'System32\wscript.exe'
$summonArguments = '//B //NoLogo "{0}" -Foreground -RespectIntent -DataRoot "{1}"' -f $summonLauncher,$DataRoot
$summonAction = New-ScheduledTaskAction -Execute $summonShell -Argument $summonArguments -WorkingDirectory $AppRoot
$summonSettings = $summonTask.Settings
$summonSettings.ExecutionTimeLimit = 'PT0S'
$summonSettings.MultipleInstances = 2 # IgnoreNew
$summonSettings.RestartCount = 999
$summonSettings.RestartInterval = 'PT1M'
Set-ScheduledTask -TaskName $summonEntry.taskName -TaskPath $summonEntry.taskPath -Action $summonAction -Settings $summonSettings | Out-Null
$summonEntry.purpose = 'Summon Bot Web and gateway background watchdog; automatic recovery; http://127.0.0.1:8787'
# The user explicitly requested no backup copies; preserve all unrelated items in place.
$summonSerialized = $summonItems | ConvertTo-Json -Depth 20
$summonRoundTrip = @($summonSerialized | ConvertFrom-Json)
$summonOtherAfter = @($summonRoundTrip | Where-Object { $_.id -ne 'summon-bot' }) | ConvertTo-Json -Depth 20 -Compress
if ($summonOtherBefore -cne $summonOtherAfter) { throw 'Unrelated StartupHub entries changed during serialization.' }
[IO.File]::WriteAllText($summonItemsPath, $summonSerialized, [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ Task=$summonEntry.taskName; AutoStart=$summonEntry.autoStart; Launcher=$summonLauncher; OtherItemsPreserved=($summonOtherBefore -ceq $summonOtherAfter); IndependentTriggers=0 }
