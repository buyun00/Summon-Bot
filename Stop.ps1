param([string]$DataRoot = '', [string]$ReleaseRoot = '')
$ErrorActionPreference = 'Stop'
if (!$DataRoot) { $DataRoot = if ($env:SUMMON_DATA_ROOT) { $env:SUMMON_DATA_ROOT } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'Relay-Bot-data' } }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if (!$ReleaseRoot) { $ReleaseRoot = (Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json).releaseRoot }
$summonNode = Join-Path $ReleaseRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $summonNode)) { $summonNode = (Get-Command node.exe -ErrorAction Stop).Source }
& $summonNode (Join-Path $ReleaseRoot 'scripts\installation\cli.mjs') stop --release-root $ReleaseRoot --data-root $DataRoot
if ($LASTEXITCODE -ne 0) { throw 'Summon Bot shutdown failed. Inspect service identities and logs.' }
