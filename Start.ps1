param([string]$DataRoot = '', [string]$ReleaseRoot = '', [switch]$Foreground, [switch]$RespectIntent)
$ErrorActionPreference = 'Stop'
if (!$DataRoot) { $DataRoot = if ($env:SUMMON_DATA_ROOT) { $env:SUMMON_DATA_ROOT } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'Relay-Bot-data' } }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
function Read-SummonInstallation {
    $statePath = Join-Path $DataRoot 'config\installation_state.json'
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($state.schemaVersion -ne 1 -or $state.phase -notin @('runtime_ready', 'done') -or !$state.release_root -or !$state.target_build) {
            return @{ Blocked = $true; Phase = $state.phase }
        }
        return @{ Blocked = $false; Release = [IO.Path]::GetFullPath($state.release_root) }
    }
    return @{ Blocked = $false }
}
function Invoke-SummonStart($installation) {
    $requestedRelease = if ($ReleaseRoot) { $ReleaseRoot } elseif ($env:SUMMON_RELEASE_ROOT) { $env:SUMMON_RELEASE_ROOT }
    $selectedRelease = if ($installation.Release) { $installation.Release } else {
        (Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json).releaseRoot
    }
    if (!$selectedRelease) { throw 'Install a release before starting Summon Bot.' }
    if ($requestedRelease -and [IO.Path]::GetFullPath($requestedRelease) -ne [IO.Path]::GetFullPath($selectedRelease)) {
        throw 'That Summon Bot release is not selected.'
    }
    $summonCli = Join-Path $selectedRelease 'scripts\installation\cli.mjs'
    if (!(Test-Path -LiteralPath $summonCli)) { throw "Service entry missing: $summonCli" }
    $summonNode = Join-Path $selectedRelease 'runtime\node.exe'
    if (!(Test-Path -LiteralPath $summonNode)) { $summonNode = (Get-Command node.exe -ErrorAction Stop).Source }
    $summonArgs = @($summonCli, 'start', '--release-root', $selectedRelease, '--data-root', $DataRoot)
    if ($Foreground) { $summonArgs += '--foreground' }
    if ($RespectIntent) { $summonArgs += '--respect-intent' }
    & $summonNode @summonArgs
}
if ($RespectIntent -and $Foreground) {
    $summonLogRoot = Join-Path $DataRoot 'web\logs'
    New-Item -ItemType Directory -Path $summonLogRoot -Force | Out-Null
    # Keep the task's PowerShell host alive if its Node watchdog is killed.
    # Windows' failure retry did not fire for this on-demand task in production.
    while ($true) {
        $installation = Read-SummonInstallation
        if ($installation.Blocked) { exit 0 }
        $summonIntent = Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json
        if ($summonIntent.runIntent -eq 'stopped') { exit 0 }
        $summonExit = 1
        try {
            Invoke-SummonStart $installation *>> (Join-Path $summonLogRoot 'startup.log')
            $summonExit = $LASTEXITCODE
        } catch {
            Add-Content -LiteralPath (Join-Path $summonLogRoot 'startup.log') -Value ('{0} launcher child failed: {1}' -f [DateTime]::UtcNow.ToString('o'), $_.Exception.Message)
        }
        if ((Read-SummonInstallation).Blocked) { exit 0 }
        $summonIntent = Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json
        if ($summonIntent.runIntent -eq 'stopped') { exit 0 }
        Add-Content -LiteralPath (Join-Path $summonLogRoot 'startup.log') -Value ('{0} launcher watchdog exited ({1}); restarting in 60 seconds' -f [DateTime]::UtcNow.ToString('o'), $summonExit)
        Start-Sleep -Seconds 60
    }
} else {
    $installation = Read-SummonInstallation
    if ($installation.Blocked) { throw "Summon Bot installation is ${installation.Phase}. Continue it before starting the service." }
    Invoke-SummonStart $installation
}
if ($LASTEXITCODE -ne 0) { throw "Summon Bot failed to start ($LASTEXITCODE). Check managed service logs." }
if (!$Foreground) {
    $summonTask = Get-ScheduledTask -TaskName 'Summon Bot' -ErrorAction SilentlyContinue
    if ($summonTask -and $summonTask.State -ne 'Running') { Start-ScheduledTask -InputObject $summonTask }
}
