param([string]$DataRoot = '', [string]$ReleaseRoot = '')
$ErrorActionPreference = 'Stop'
if (!$DataRoot) { $DataRoot = if ($env:SUMMON_DATA_ROOT) { $env:SUMMON_DATA_ROOT } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'Relay-Bot-data' } }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$statePath = Join-Path $DataRoot 'config\installation_state.json'
if (Test-Path -LiteralPath $statePath) {
    $installation = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($installation.schemaVersion -ne 1 -or $installation.phase -notin @('runtime_ready', 'done')) {
        throw 'The installer owns the current shutdown. Continue the installation to stop or start its services.'
    }
}
$selected = (Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json).releaseRoot
if ($ReleaseRoot -and [IO.Path]::GetFullPath($ReleaseRoot) -ne [IO.Path]::GetFullPath($selected)) {
    throw 'That Summon Bot release is not selected.'
}
$ReleaseRoot = $selected
$summonNode = Join-Path $ReleaseRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $summonNode)) { $summonNode = (Get-Command node.exe -ErrorAction Stop).Source }
& $summonNode (Join-Path $ReleaseRoot 'scripts\installation\cli.mjs') stop --release-root $ReleaseRoot --data-root $DataRoot
if ($LASTEXITCODE -ne 0) { throw 'Summon Bot shutdown failed. Inspect service identities and logs.' }
