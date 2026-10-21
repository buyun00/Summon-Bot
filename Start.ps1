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
    & $relayNode @relayArgs *>> (Join-Path $relayLogRoot 'startup.log')
} else { & $relayNode @relayArgs }
if ($LASTEXITCODE -ne 0) { throw "Relay failed to start ($LASTEXITCODE). Check managed service logs." }
