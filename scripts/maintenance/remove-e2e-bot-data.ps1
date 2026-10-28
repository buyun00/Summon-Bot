$ErrorActionPreference = 'Stop'
# Explicit IDs only. Never match Bot names or use wildcard deletion.
$dataRoot = 'D:\Relay-Bot-data'
$testBotIds = @(
    'bot-4c2f0783-e1e1-4ec7-a6d5-12cf6a45017e',
    'bot-243ccb5f-f9fd-44ee-b80c-115c30df7d94',
    'bot-232f1a73-7972-45d6-b8d0-cf224d952670',
    'bot-940bfdd8-83fe-4ef9-aee8-4d7cd6dd649c',
    'bot-ea9f7f4b-2faa-4953-83ac-25783e7d1ccb'
)
function Assert-PlainDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Not an ordinary directory: $Path"
    }
    if (-not [string]::Equals((Resolve-Path -LiteralPath $Path).ProviderPath, $Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected resolved path: $Path"
    }
}
try {
    Assert-PlainDirectory $dataRoot
    $targets = @()
    foreach ($folder in @('bots', 'archives')) {
        $parent = [IO.Path]::GetFullPath((Join-Path $dataRoot $folder))
        if (-not (Test-Path -LiteralPath $parent)) { continue }
        Assert-PlainDirectory $parent
        foreach ($id in $testBotIds) {
            $path = [IO.Path]::GetFullPath((Join-Path $parent $id))
            if ([IO.Path]::GetDirectoryName($path) -ne $parent -or [IO.Path]::GetFileName($path) -ne $id) {
                throw "Target is outside the explicit allowlist: $path"
            }
            if (Test-Path -LiteralPath $path) {
                Assert-PlainDirectory $path
                $targets += $path
            }
        }
    }
    # Refuse deletion while one of these specific Bots is running; do not stop other Bots.
    foreach ($process in Get-CimInstance Win32_Process) {
        if ($process.CommandLine -and $process.Name -match '^(node|nodejs)\.exe$') {
            foreach ($id in $testBotIds) {
                $configPath = Join-Path $dataRoot "bots\$id\config.json"
                if ($process.CommandLine.Replace('/', '\').IndexOf($configPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    throw "Test Bot is still running (PID $($process.ProcessId)): $id. Stop it before running this script again."
                }
            }
        }
    }
    foreach ($path in $targets) {
        Assert-PlainDirectory $path
        Write-Host "REMOVE $path"
        Remove-Item -LiteralPath $path -Recurse -Force
    }
    Write-Host "SUCCESS - removed $($targets.Count) E2E data/archive directories. Production Bot data was not targeted."
    exit 0
} catch {
    Write-Host "FAILED - $($_.Exception.Message)"
    Write-Host 'No further directories will be removed. You can rerun after resolving the error.'
    exit 1
}
