param([string]$DataRoot = '', [string]$ReleaseRoot = '', [switch]$Foreground, [switch]$RespectIntent)
$ErrorActionPreference = 'Stop'
if (!$DataRoot) { $DataRoot = if ($env:SUMMON_DATA_ROOT) { $env:SUMMON_DATA_ROOT } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'Relay-Bot-data' } }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if (!$ReleaseRoot) {
    if ($env:SUMMON_RELEASE_ROOT) { $ReleaseRoot = $env:SUMMON_RELEASE_ROOT }
    elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release-manifest.json')) { $ReleaseRoot = $PSScriptRoot }
    elseif (Test-Path -LiteralPath (Join-Path $DataRoot 'config\deployment.json')) { $ReleaseRoot = (Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json).releaseRoot }
    else { throw 'Build and install a release before starting Summon Bot.' }
}
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$summonCli = Join-Path $ReleaseRoot 'scripts\installation\cli.mjs'
if (!(Test-Path -LiteralPath $summonCli)) { throw "Service entry missing: $summonCli" }
$summonNode = Join-Path $ReleaseRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $summonNode)) { $summonNode = (Get-Command node.exe -ErrorAction Stop).Source }
$summonArgs = @($summonCli, 'start', '--release-root', $ReleaseRoot, '--data-root', $DataRoot)
if ($Foreground) { $summonArgs += '--foreground' }
if ($RespectIntent) { $summonArgs += '--respect-intent' }
if ($RespectIntent -and $Foreground) {
    $summonLogRoot = Join-Path $DataRoot 'web\logs'
    New-Item -ItemType Directory -Path $summonLogRoot -Force | Out-Null
    # Keep the task's PowerShell host alive if its Node watchdog is killed.
    # Windows' failure retry did not fire for this on-demand task in production.
    while ($true) {
        $summonIntent = Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json
        if ($summonIntent.runIntent -eq 'stopped') { exit 0 }
        $summonExit = 1
        try {
            & $summonNode @summonArgs *>> (Join-Path $summonLogRoot 'startup.log')
            $summonExit = $LASTEXITCODE
        } catch {
            Add-Content -LiteralPath (Join-Path $summonLogRoot 'startup.log') -Value ('{0} launcher child failed: {1}' -f [DateTime]::UtcNow.ToString('o'), $_.Exception.Message)
        }
        $summonIntent = Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json
        if ($summonIntent.runIntent -eq 'stopped') { exit 0 }
        Add-Content -LiteralPath (Join-Path $summonLogRoot 'startup.log') -Value ('{0} launcher watchdog exited ({1}); restarting in 60 seconds' -f [DateTime]::UtcNow.ToString('o'), $summonExit)
        Start-Sleep -Seconds 60
    }
} else { & $summonNode @summonArgs }
if ($LASTEXITCODE -ne 0) { throw "Summon Bot failed to start ($LASTEXITCODE). Check managed service logs." }
if (!$Foreground) {
    $summonTask = Get-ScheduledTask -TaskName 'Summon Bot' -ErrorAction SilentlyContinue
    if ($summonTask -and $summonTask.State -ne 'Running') { Start-ScheduledTask -InputObject $summonTask }
}
