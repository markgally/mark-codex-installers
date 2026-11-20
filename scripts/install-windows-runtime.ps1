param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Manifest,
    [string[]]$Names = @('codex', 'gws')
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

function Test-RuntimeReady($Runtime, [string]$Folder) {
    if ($Runtime.name -eq 'gws') { return (Test-Path -LiteralPath (Join-Path $Folder 'gws.exe')) }
    $required = @('codex.exe', 'codex-package.json', 'codex-code-mode-host.exe',
        'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe',
        'bin\codex-exec-server.exe', 'codex-resources\voice\windows-crt.json', 'codex-path')
    foreach ($item in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Folder $item))) { return $false }
    }
    try {
        $package = Get-Content -LiteralPath (Join-Path $Folder 'codex-package.json') -Raw | ConvertFrom-Json
        $expected = $Runtime.version.Replace('rust-v', '').TrimStart('v')
        return ($package.version -eq $expected -and $package.entrypoint -eq 'codex.exe')
    } catch { return $false }
}

$runtimes = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
foreach ($runtime in $runtimes) {
    if ($Names -notcontains $runtime.name) { continue }
    if (Test-RuntimeReady $runtime $Destination) {
        Write-Host ($runtime.name + ' is already ready.')
        continue
    }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('mark-runtime-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        $zip = Join-Path $temporary 'runtime.zip'
        $expanded = Join-Path $temporary 'expanded'
        Write-Host ('Downloading official ' + $runtime.name + ' ' + $runtime.version + '. Please keep this window open.')
        Invoke-WebRequest -UseBasicParsing -Uri $runtime.url -OutFile $zip
        $expected = $runtime.sha256.Replace('sha256:', '').ToLowerInvariant()
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
            throw ('Checksum mismatch: ' + $runtime.name)
        }
        Expand-Archive -LiteralPath $zip -DestinationPath $expanded -Force
        if ($runtime.name -eq 'codex') {
            $original = Join-Path $expanded 'codex-x86_64-pc-windows-msvc.exe'
            if (Test-Path -LiteralPath $original) {
                Move-Item -LiteralPath $original -Destination (Join-Path $expanded 'codex.exe') -Force
            }
            $packagePath = Join-Path $expanded 'codex-package.json'
            $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
            $package.entrypoint = 'codex.exe'
            [IO.File]::WriteAllText($packagePath, ($package | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
        }
        if (-not (Test-RuntimeReady $runtime $expanded)) {
            throw ('The downloaded ' + $runtime.name + ' runtime is incomplete.')
        }
        Get-ChildItem -LiteralPath $expanded -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
        }
        if (-not (Test-RuntimeReady $runtime $Destination)) {
            throw ('Could not finish setting up ' + $runtime.name)
        }
        Write-Host ($runtime.name + ' is verified and ready.')
    } finally {
        Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}
