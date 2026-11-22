#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$BaseArchive,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$SourceRef = 'HEAD',
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$BaseArchiveSha256 = 'daeab733267b329f3cda309fa93d5cefc0034c34812e5d6d5913d18e6048a67d'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = Split-Path -Parent $PSScriptRoot
$exe = (Get-Item -LiteralPath $Executable).FullName
$base = (Get-Item -LiteralPath $BaseArchive).FullName
$encoding = New-Object System.Text.UTF8Encoding($false)

function Read-ZipText($Zip, [string]$Name) {
    $entry = $Zip.GetEntry($Name)
    if ($null -eq $entry) { throw "Missing archive entry $Name" }
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Copy-ZipFile($Zip, [string]$EntryName, [string]$Destination) {
    $entry = $Zip.GetEntry($EntryName)
    if ($null -eq $entry) { throw "Missing archive entry $EntryName" }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $Destination)
}

if ((Get-FileHash -LiteralPath $base -Algorithm SHA256).Hash -ne $BaseArchiveSha256) {
    throw 'The base installer ZIP does not match its expected SHA-256.'
}

$reader = New-Object System.IO.BinaryReader([IO.File]::OpenRead($exe))
try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'The input is not a Windows executable.' }
    $reader.BaseStream.Position = 0x3c
    $reader.BaseStream.Position = $reader.ReadUInt32()
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
        throw 'The input is not a Windows x64 executable.'
    }
} finally {
    $reader.Dispose()
}

$commit = & git -C $repo rev-parse --verify --end-of-options "$SourceRef^{commit}"
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40,64}$') { throw 'Could not resolve the source commit.' }
$packageJson = & git -C $repo show "${commit}:package.json"
if ($LASTEXITCODE -ne 0) { throw 'Could not read package.json at the source commit.' }
$version = (($packageJson -join "`n") | ConvertFrom-Json).version
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Expected a numeric release version in package.json.' }
if ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -ne $version) {
    throw "The executable product version must match source version $version."
}

$packageName = "MARK-Codex-Windows-x64-Setup-$version"
$sourceName = "MARK-Codex-Windows-Source-$version"
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$output = [IO.Directory]::CreateDirectory($output).FullName
$publishedStage = Join-Path $output $packageName
$archive = Join-Path $output "$packageName.zip"
if ((Test-Path -LiteralPath $publishedStage) -or (Test-Path -LiteralPath $archive)) {
    throw "Package already exists at $publishedStage or $archive."
}
[string]$scratch = Join-Path $output ('.mark-package-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $scratch $packageName
$temporaryArchive = Join-Path $scratch "$packageName.zip"
[IO.Directory]::CreateDirectory($stage) | Out-Null
try {
    $sourceArchive = Join-Path $stage "$sourceName.zip"
    & git -C $repo archive --format=zip "--prefix=$sourceName/" "--output=$sourceArchive" $commit
    if ($LASTEXITCODE -ne 0) { throw 'Could not archive the release source.' }

    $baseZip = [IO.Compression.ZipFile]::OpenRead($base)
    $sourceZip = [IO.Compression.ZipFile]::OpenRead($sourceArchive)
    try {
        $manifest = Read-ZipText $sourceZip "$sourceName/runtime-downloads.json"
        $baseManifest = Read-ZipText $baseZip 'runtime-downloads.json'
        if (($manifest.Trim() -replace "`r`n", "`n") -cne ($baseManifest.Trim() -replace "`r`n", "`n")) {
            throw 'The pinned runtimes changed. Use a verified base ZIP for the same runtimes.'
        }
        foreach ($name in @(
            '1 - Set up and sign in.cmd', '3 - Google Workspace setup.cmd',
            'Check Windows requirements.cmd', 'Check-Windows.ps1', 'Setup-Codex.ps1',
            'Start with dark background.cmd', 'bin/gws.exe',
            'licenses/codex-LICENSE.txt', 'licenses/gws-LICENSE.txt'
        )) {
            Copy-ZipFile $baseZip $name (Join-Path $stage $name)
        }
        Copy-ZipFile $sourceZip "$sourceName/LICENSE" (Join-Path $stage 'licenses/MARK-LICENSE.txt')
        foreach ($name in @('runtime-downloads.json', 'scripts/install-windows-runtime.ps1')) {
            Copy-ZipFile $sourceZip "$sourceName/$name" (Join-Path $stage $name)
        }
        Copy-ZipFile $sourceZip "$sourceName/src-tauri/wake-helper/windows-wake.ps1" (Join-Path $stage 'wake-helper/windows-wake.ps1')
    } finally {
        $sourceZip.Dispose()
        $baseZip.Dispose()
    }

    $launcher = @'
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Codex.ps1"
if errorlevel 1 goto failed
set "JARVIS_CODEX_BIN=%~dp0bin\codex.exe"
set "MARK_GWS_BIN=%~dp0bin\gws.exe"
set "PATH=%~dp0bin;%~dp0bin\codex-path;%PATH%"
start "" "%~dp0Mark Codex.exe"
exit /b 0
:failed
echo Codex setup failed. Check your internet connection and try step 1 again.
pause
exit /b 1
'@
    [IO.File]::WriteAllText((Join-Path $stage '2 - Start MARK Codex.cmd'), (($launcher -replace '\r?\n', "`r`n") + "`r`n"), $encoding)

    $stageExe = Join-Path $stage 'Mark Codex.exe'
    [IO.File]::Copy($exe, $stageExe)
    $signature = Get-AuthenticodeSignature -LiteralPath $stageExe
    $signatureNote = if ($signature.Status -eq 'NotSigned') {
        'Do not run from inside the ZIP. This is an unsigned Windows x64 release.'
    } elseif ($signature.Status -eq 'Valid' -and $signature.TimeStamperCertificate) {
        'Do not run from inside the ZIP. Mark Codex.exe is Authenticode-signed and timestamped.'
    } else {
        throw "The executable signature could not be verified: $($signature.Status)."
    }
    $start = @"
MARK CODEX FOR WINDOWS $version

1. Quit any older MARK window and extract the whole ZIP into a new folder.
2. Run "Check Windows requirements.cmd". Microsoft Edge WebView2 is required.
3. Run "1 - Set up and sign in.cmd" to download the verified Codex runtime
   and sign in with your own account.
4. Run "2 - Start MARK Codex.cmd". It checks the runtime on each launch and
   reuses a complete installation.

Minimize keeps the running app on the Windows taskbar. Click the taskbar
icon to bring back the same window. The square switches Compact and Restore.

Allow desktop microphone access for voice. The wake phrase also needs an
English Speech language pack. Use "Start with dark background.cmd" if the
transparent window is hard to see. Google Workspace setup is optional.

Keep bin, scripts and wake-helper next to Mark Codex.exe.
$signatureNote

Existing settings and saved conversations stay on your PC. This archive
includes the corresponding source in $sourceName.zip.
See licenses, BUILD-INFO.json and SHA256SUMS.txt for package provenance.
"@
    [IO.File]::WriteAllText((Join-Path $stage 'START HERE.txt'), $start + "`r`n", $encoding)

    $metadata = [ordered]@{
        product = 'MARK Codex'
        version = $version
        architecture = 'Windows x64'
        source_commit = $commit
        mark_executable_sha256 = (Get-FileHash -LiteralPath $stageExe -Algorithm SHA256).Hash.ToLowerInvariant()
        sources = @{ mark = "$sourceName.zip"; repository = 'https://github.com/markgally/mark-codex-installers' }
        runtimes = @($manifest | ConvertFrom-Json)
    }
    [IO.File]::WriteAllText((Join-Path $stage 'BUILD-INFO.json'), ($metadata | ConvertTo-Json -Depth 5) + "`n", $encoding)

    $checksums = Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $relative"
    }
    [IO.File]::WriteAllText((Join-Path $stage 'SHA256SUMS.txt'), ($checksums -join "`n") + "`n", $encoding)
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $temporaryArchive, [IO.Compression.CompressionLevel]::Optimal, $false)
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    if ($resolvedStage -ne $stage -or (Split-Path -Parent $resolvedStage) -ne $scratch -or (Split-Path -Parent $publishedStage) -ne $output) {
        throw 'Unexpected package staging or destination path.'
    }
    [IO.Directory]::Move($resolvedStage, $publishedStage)
    try {
        [IO.File]::Move($temporaryArchive, $archive)
    } catch {
        [IO.Directory]::Move($publishedStage, $resolvedStage)
        throw
    }
    Write-Output $archive
} finally {
    $resolvedScratch = (Resolve-Path -LiteralPath $scratch).Path
    if ($resolvedScratch -ne $scratch -or (Split-Path -Parent $resolvedScratch) -ne $output) {
        throw 'Unexpected package scratch path.'
    }
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
}
