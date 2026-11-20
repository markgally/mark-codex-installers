$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& (Join-Path $PSScriptRoot 'scripts\get-windows-runtimes.ps1')
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Frontend checks failed' }
cargo test --lib --manifest-path src-tauri\Cargo.toml --locked
if ($LASTEXITCODE -ne 0) { throw 'Native checks failed' }
npm run build -- --target x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
Write-Host 'Windows NSIS installer: src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis'
