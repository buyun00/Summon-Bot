param([string]$DataRoot = '', [string]$ReleaseRoot = '', [switch]$Foreground, [switch]$RespectIntent)
$ErrorActionPreference = 'Stop'
if (!$DataRoot) { $DataRoot = if ($env:RELAY_DATA_ROOT) { $env:RELAY_DATA_ROOT } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'Relay-Bot-data' } }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if (!$ReleaseRoot) {
    if ($env:RELAY_RELEASE_ROOT) { $ReleaseRoot = $env:RELAY_RELEASE_ROOT }
    elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release-manifest.json')) { $ReleaseRoot = $PSScriptRoot }
    elseif (Test-Path -LiteralPath (Join-Path $DataRoot 'config\deployment.json')) { $ReleaseRoot = (Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json).releaseRoot }
    else { throw 'Build and install a release before starting Relay.' }
}
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$relayCli = Join-Path $ReleaseRoot 'scripts\installation\cli.mjs'
if (!(Test-Path -LiteralPath $relayCli)) { throw "Service entry missing: $relayCli" }
$relayNode = Join-Path $ReleaseRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $relayNode)) { $relayNode = (Get-Command node.exe -ErrorAction Stop).Source }
$relayArgs = @($relayCli, 'start', '--release-root', $ReleaseRoot, '--data-root', $DataRoot)
if ($Foreground) { $relayArgs += '--foreground' }
if ($RespectIntent) { $relayArgs += '--respect-intent' }
if ($RespectIntent -and $Foreground) {
    $relayLogRoot = Join-Path $DataRoot 'web\logs'
    New-Item -ItemType Directory -Path $relayLogRoot -Force | Out-Null
    # Keep the task's PowerShell host alive if its Node watchdog is killed.
    # Windows' failure retry did not fire for this on-demand task in production.
    while ($true) {
        $relayIntent = Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json
        if ($relayIntent.runIntent -eq 'stopped') { exit 0 }
        $relayExit = 1
        try {
            & $relayNode @relayArgs *>> (Join-Path $relayLogRoot 'startup.log')
            $relayExit = $LASTEXITCODE
        } catch {
            Add-Content -LiteralPath (Join-Path $relayLogRoot 'startup.log') -Value ('{0} launcher child failed: {1}' -f [DateTime]::UtcNow.ToString('o'), $_.Exception.Message)
        }
        $relayIntent = Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json
        if ($relayIntent.runIntent -eq 'stopped') { exit 0 }
        Add-Content -LiteralPath (Join-Path $relayLogRoot 'startup.log') -Value ('{0} launcher watchdog exited ({1}); restarting in 60 seconds' -f [DateTime]::UtcNow.ToString('o'), $relayExit)
        Start-Sleep -Seconds 60
    }
} else { & $relayNode @relayArgs }
if ($LASTEXITCODE -ne 0) { throw "Relay failed to start ($LASTEXITCODE). Check managed service logs." }
if (!$Foreground) {
    $relayTask = Get-ScheduledTask -TaskName 'Relay Bot Foundation' -ErrorAction SilentlyContinue
    if ($relayTask -and $relayTask.State -ne 'Running') { Start-ScheduledTask -InputObject $relayTask }
}
