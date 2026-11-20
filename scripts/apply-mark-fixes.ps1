$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'bin'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$reference = Join-Path (Split-Path -Parent $compiler) 'System.Web.Extensions.dll'
$runtimeDll = Join-Path $env:SystemRoot 'System32\VCRUNTIME140.dll'

function Install-VcRuntime {
    if (Test-Path -LiteralPath $runtimeDll) {
        Write-Host 'Visual C++ runtime is already installed.'
        return
    }
    $installer = Join-Path ([IO.Path]::GetTempPath()) 'vc_redist.x64.exe'
    Write-Host 'Downloading the Visual C++ 2015-2022 x64 runtime.'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $installer
    $installed = Start-Process -FilePath $installer -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru -Verb RunAs
    if ($installed.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $runtimeDll)) {
        throw "Visual C++ runtime installation failed with exit code $($installed.ExitCode)."
    }
    Write-Host 'Visual C++ runtime installed.'
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'Mark Codex.exe'))) {
    throw 'Run this script from the extracted MARK Codex folder.'
}
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'The .NET Framework C# compiler is missing.'
}

Install-VcRuntime
if (-not (Test-Path -LiteralPath (Join-Path $bin 'codex.exe'))) {
    Write-Host 'Downloading the pinned Codex runtime.'
    & (Join-Path $root 'Setup-Codex.ps1')
}
if (-not (Test-Path -LiteralPath (Join-Path $bin 'codex.exe'))) {
    throw 'Codex was not installed into bin\codex.exe.'
}

New-Item -ItemType Directory -Force -Path $bin | Out-Null
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/reference:$reference" "/out:$(Join-Path $bin 'mark-codex-bridge.exe')" (Join-Path $PSScriptRoot 'Mark-Codex-Bridge.cs')
if ($LASTEXITCODE -ne 0) { throw 'MARK bridge compilation failed.' }

$codex = (Resolve-Path -LiteralPath (Join-Path $bin 'codex.exe')).Path
[IO.File]::WriteAllText((Join-Path $bin 'mark-codex-cli.path'), $codex, (New-Object Text.UTF8Encoding($false)))
$bridge = (Resolve-Path -LiteralPath (Join-Path $bin 'mark-codex-bridge.exe')).Path
[Environment]::SetEnvironmentVariable('JARVIS_CODEX_BIN', $bridge, 'User')
Write-Host 'MARK fixes are installed for this Windows user.'
Write-Host 'Quit any open MARK window, then run 2 - Start MARK Codex.cmd.'
