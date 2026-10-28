$ErrorActionPreference = 'Stop'
$bridgeData = 'D:\Relay-Bot-data\connectors\codex-desktop-api'
$bridgePidFile = Join-Path $bridgeData 'server.pid'
$bridgeLog = Join-Path $bridgeData 'startup.log'
$bridgeChild = $null
$bridgeJob = $null
$bridgeExitCode = 1
New-Item -ItemType Directory -Path $bridgeData -Force | Out-Null
try {
    $selection = Get-Content -LiteralPath 'D:\Relay-Bot-app\current.json' -Raw | ConvertFrom-Json
    $bridgeRoot = Join-Path $selection.releaseRoot 'connectors\codex-desktop-api'
    $bridgeNode = Join-Path $selection.releaseRoot 'runtime\node.exe'
    $bridgeMain = Join-Path $bridgeRoot 'src\main.js'
    $env:CODEX_DESKTOP_API_CONFIG = Join-Path $bridgeData 'config.json'
    foreach ($file in @($bridgeNode, $bridgeMain, $env:CODEX_DESKTOP_API_CONFIG)) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required file not found: $file" }
    }
    if (Get-NetTCPConnection -LocalPort 47831 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 47831 already has a listener; refusing a duplicate API.' }
    Add-Type -Path (Join-Path $bridgeRoot 'scripts\windows-job.cs')
    $bridgeJob = [CodexDesktopApiJob]::new()
    Add-Content -LiteralPath $bridgeLog -Encoding UTF8 -Value "$(Get-Date -Format o) Starting installed connector: $bridgeMain"
    $bridgeChild = Start-Process -FilePath $bridgeNode -ArgumentList @('"' + $bridgeMain + '"') -WorkingDirectory $bridgeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $bridgeData 'server.log') -RedirectStandardError (Join-Path $bridgeData 'server-error.log') -PassThru
    $bridgeJob.Add($bridgeChild)
    Set-Content -LiteralPath $bridgePidFile -Value $bridgeChild.Id
    $bridgeChild.WaitForExit()
    $bridgeExitCode = $bridgeChild.ExitCode
    Add-Content -LiteralPath $bridgeLog -Encoding UTF8 -Value "$(Get-Date -Format o) Connector exited: $bridgeExitCode"
} catch {
    Add-Content -LiteralPath $bridgeLog -Encoding UTF8 -Value "$(Get-Date -Format o) Startup failed: $($_.Exception.Message)"
} finally {
    if ($bridgeChild) {
        if (!$bridgeChild.HasExited) { $bridgeChild.Kill(); $bridgeChild.WaitForExit() }
        if ((Test-Path -LiteralPath $bridgePidFile) -and [int](Get-Content -LiteralPath $bridgePidFile -Raw) -eq $bridgeChild.Id) { Remove-Item -LiteralPath $bridgePidFile }
        $bridgeChild.Dispose()
    }
    if ($bridgeJob) { $bridgeJob.Dispose() }
}
exit $bridgeExitCode
