param([string]$DataRoot = '', [string]$ReleaseRoot = '')
$ErrorActionPreference = 'Stop'
if (!$DataRoot) { $DataRoot = if ($env:RELAY_DATA_ROOT) { $env:RELAY_DATA_ROOT } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'Relay-Bot-data' } }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if (!$ReleaseRoot) { $ReleaseRoot = (Get-Content -LiteralPath (Join-Path $DataRoot 'config\deployment.json') -Raw | ConvertFrom-Json).releaseRoot }
$relayNode = Join-Path $ReleaseRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $relayNode)) { $relayNode = (Get-Command node.exe -ErrorAction Stop).Source }
& $relayNode (Join-Path $ReleaseRoot 'scripts\installation\cli.mjs') stop --release-root $ReleaseRoot --data-root $DataRoot
if ($LASTEXITCODE -ne 0) { throw 'Relay shutdown failed. Inspect service identities and logs.' }
