$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'install-windows-runtime.ps1') -Destination (Join-Path $root 'src-tauri\bin') -Manifest (Join-Path $root 'runtime-downloads.json')
