$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$prefix = $repoRoot.TrimEnd('\') + '\'
$targets = @('bot/test', 'web/test', 'capabilities/test', 'tests', 'bot/third_party/pi/upstream-tests', 'scripts/build/test.mjs', 'bot/vitest.config.mjs')
Write-Host 'Summon Bot - remove development tests'
try {
    foreach ($name in $targets) {
        $path = [IO.Path]::GetFullPath((Join-Path $repoRoot $name))
        if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path is outside the repository' }
        Write-Host ('REMOVE ' + $name)
        if (Test-Path -LiteralPath $path) {
            $resolved = (Resolve-Path -LiteralPath $path).Path
            if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved path is outside the repository' }
            $item = Get-Item -LiteralPath $resolved -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a linked target' }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
    Write-Host 'SUCCESS - development tests removed'
    exit 0
} catch {
    Write-Host ('FAILED - ' + $_.Exception.Message)
    exit 1
}
