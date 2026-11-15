param([string]$DataRoot = '', [string]$ReleaseRoot = '', [switch]$Foreground, [switch]$RespectIntent)
$ErrorActionPreference = 'Stop'
if (!$DataRoot) { $DataRoot = if ($env:SUMMON_DATA_ROOT) { $env:SUMMON_DATA_ROOT } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'Relay-Bot-data' } }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$deploymentPath = Join-Path $DataRoot 'config\deployment.json'
function Read-SummonJson([string]$Path) {
    try { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "Could not read UTF-8 JSON from $Path." }
}
function Read-SummonInstallation {
    $statePath = Join-Path $DataRoot 'config\installation_state.json'
    if (Test-Path -LiteralPath $statePath) {
        $state = Read-SummonJson $statePath
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
        (Read-SummonJson $deploymentPath).releaseRoot
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
$installation = Read-SummonInstallation
if ($installation.Blocked) {
    if ($RespectIntent -and $Foreground) { exit 0 }
    throw "Summon Bot installation is $($installation.Phase). Continue it before starting the service."
}
Invoke-SummonStart $installation
if ($LASTEXITCODE -ne 0) { throw "Summon Bot failed to start ($LASTEXITCODE). Check managed service logs." }
if (!$Foreground) {
    try {
        if ($RespectIntent -and (Read-SummonJson $deploymentPath).runIntent -eq 'stopped') { return }
        $summonTask = Get-ScheduledTask -TaskName 'Summon Bot' -TaskPath '\' -ErrorAction SilentlyContinue
        if ($summonTask -and $summonTask.State -ne 'Running') { Start-ScheduledTask -InputObject $summonTask }
    } catch {
        Write-Warning ('Summon Bot started, but the scheduled watchdog could not start: ' + $_.Exception.Message)
    }
}
