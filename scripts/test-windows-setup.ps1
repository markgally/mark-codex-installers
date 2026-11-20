$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $PSScriptRoot 'install-windows-runtime.ps1'
$manifest = Join-Path $root 'runtime-downloads.json'
$runtime = @(Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json | Where-Object { $_.name -eq 'codex' })[0]
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('mark-setup-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null

function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    throw 'MARK_TEST_DOWNLOAD_NEEDED'
}
function Assert-DownloadNeeded {
    $expected = $false
    try { & $installer -Destination $fixture -Manifest $manifest -Names @('codex') }
    catch {
        if ($_.Exception.Message -like '*MARK_TEST_DOWNLOAD_NEEDED*') { $expected = $true }
        else { throw }
    }
    if (-not $expected) { throw 'An incomplete or wrong-version runtime was incorrectly reused.' }
}

try {
    $required = @('codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe',
        'codex-windows-sandbox-setup.exe', 'bin\codex-exec-server.exe',
        'codex-resources\voice\windows-crt.json')
    foreach ($relative in $required) {
        $path = Join-Path $fixture $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
        [IO.File]::WriteAllText($path, '')
    }
    New-Item -ItemType Directory -Path (Join-Path $fixture 'codex-path') | Out-Null
    $packagePath = Join-Path $fixture 'codex-package.json'
    $package = @{ version = $runtime.version.Replace('rust-v', '').TrimStart('v'); entrypoint = 'codex.exe' }
    [IO.File]::WriteAllText($packagePath, ($package | ConvertTo-Json))
    & $installer -Destination $fixture -Manifest $manifest -Names @('codex')
    Write-Host 'PASS: complete cached runtime is reused without downloading.'
    Remove-Item -LiteralPath (Join-Path $fixture 'codex-code-mode-host.exe') -Force
    Assert-DownloadNeeded
    Write-Host 'PASS: missing support files trigger runtime setup.'
    [IO.File]::WriteAllText((Join-Path $fixture 'codex-code-mode-host.exe'), '')
    $package.version = '0.0.0'
    [IO.File]::WriteAllText($packagePath, ($package | ConvertTo-Json))
    Assert-DownloadNeeded
    Write-Host 'PASS: a wrong runtime version triggers runtime setup.'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
