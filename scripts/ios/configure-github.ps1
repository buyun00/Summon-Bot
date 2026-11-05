param(
    [string]$SharedDirectory = "$env:USERPROFILE/.codex/private/opengym-ios-signing",
    [string]$AppDirectory = "$env:USERPROFILE/.codex/private/summon-ios-signing",
    [string]$Group = 'Personal'
)
$ErrorActionPreference = 'Stop'
# Private input is sent over stdin, never through arguments or console output.
$required = @("$SharedDirectory/Lin-Gym-Distribution.p12", "$SharedDirectory/p12-password.dpapi",
    "$AppDirectory/app.mobileprovision", "$AppDirectory/asc-issuer-id.txt")
foreach ($file in $required) { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing private material: $file" } }
$keys = @(Get-ChildItem -LiteralPath $SharedDirectory -Filter 'AuthKey_*.p8')
if ($keys.Count -ne 1) { throw 'Expected exactly one existing App Store Connect API key in the shared directory' }
$secure = Get-Content -LiteralPath "$SharedDirectory/p12-password.dpapi" -Raw | ConvertTo-SecureString
$password = [System.Net.NetworkCredential]::new('', $secure).Password
$payload = @{
    shared = (Resolve-Path -LiteralPath $SharedDirectory).Path
    app = (Resolve-Path -LiteralPath $AppDirectory).Path
    keyPath = $keys[0].FullName
    password = $password
    group = $Group
} | ConvertTo-Json -Compress
$start = [System.Diagnostics.ProcessStartInfo]::new('py')
$start.ArgumentList.Add('-X'); $start.ArgumentList.Add('utf8')
$start.ArgumentList.Add((Join-Path $PSScriptRoot 'configure-github.py'))
$githubToken = (& gh auth token 2>$null)
if ($LASTEXITCODE -ne 0 -or !$githubToken) { throw 'GitHub CLI login is required' }
$start.Environment['GH_TOKEN'] = $githubToken.Trim()
$githubToken = $null
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::Start($start)
$process.StandardInput.Write($payload)
$process.StandardInput.Close()
$process.WaitForExit()
$password = $null; $payload = $null
if ($process.ExitCode -ne 0) { throw 'iOS GitHub configuration failed; private values were not printed' }
