$ErrorActionPreference = 'Stop'
$relayRoot = $PSScriptRoot
$relayData = Join-Path $relayRoot '.relay'
New-Item -ItemType Directory -Path $relayData -Force | Out-Null
$relayPidPath = Join-Path $relayData 'server.pid'
if (Test-Path -LiteralPath $relayPidPath) {
    $relayExistingId = [int](Get-Content -LiteralPath $relayPidPath -Raw)
    $relayExisting = Get-CimInstance Win32_Process -Filter "ProcessId=$relayExistingId" -ErrorAction SilentlyContinue
    if ($relayExisting -and $relayExisting.CommandLine.Contains((Join-Path $relayRoot 'src\server.mjs'))) {
        Write-Output "Relay Bot 已在运行 (PID $relayExistingId)。"
        exit 0
    }
}
$relayNode = (Get-Command node.exe).Source
$relayEntry = Join-Path $relayRoot 'src\server.mjs'
$relayProcess = Start-Process -FilePath $relayNode -ArgumentList @('"' + $relayEntry + '"') -WorkingDirectory $relayRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $relayData 'server.log') -RedirectStandardError (Join-Path $relayData 'server-error.log')
Set-Content -LiteralPath $relayPidPath -Value $relayProcess.Id
Start-Sleep -Milliseconds 800
if ($relayProcess.HasExited) {
    Get-Content -LiteralPath (Join-Path $relayData 'server-error.log')
    throw 'Relay Bot 启动失败。'
}
Write-Output "Relay Bot 已启动 (PID $($relayProcess.Id))。默认地址 http://127.0.0.1:8787；实际地址见 .relay/server.log。"
