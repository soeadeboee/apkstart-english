#requires -Version 5.1
<#
.SYNOPSIS
    Applies (or restores) the English language patch for ApkStart v0.5.3.

.DESCRIPTION
    ApkStart has no language setting: every label is hard-coded Chinese inside
    <install>\resources\app. This script swaps those files for the translated
    ones from patch\app, after checking that the installed files are the stock
    v0.5.3 sources.

    A backup of every file it touches is written to
    %LOCALAPPDATA%\apkstart-english\backup so -Restore can put the Chinese
    files back at any time.

.PARAMETER AppDir
    Path to "ApkStart\resources\app" (or the install folder). Detected
    automatically when omitted (running process, uninstall registry entry,
    common install locations).

.PARAMETER Restore
    Restore the original Chinese files from the newest backup instead.

.PARAMETER Force
    Patch even when the installed files do not match the expected v0.5.3
    hashes (for example after a manual edit), or when the version differs.
    A backup is still taken first.

.PARAMETER StopApp
    Close a running ApkStart before touching its files.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-en.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-en.ps1 -AppDir "D:\Games\ApkStart\resources\app" -StopApp

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-en.ps1 -Restore
#>
[CmdletBinding()]
param(
    [string]$AppDir,
    [switch]$Restore,
    [switch]$Force,
    [switch]$StopApp
)

$ErrorActionPreference = 'Stop'
$script:Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:PatchRoot = Join-Path $script:Here 'patch'
$script:ManifestFile = Join-Path $script:PatchRoot 'manifest.json'
$script:BackupRoot = Join-Path $env:LOCALAPPDATA 'apkstart-english\backup'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-AppDir([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Path 'src\main.js')) -and
           (Test-Path -LiteralPath (Join-Path $Path 'package.json'))
}

# Accepts an app dir, an install dir or an exe path; returns <...>\resources\app or $null.
function Resolve-AppDir([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $Path = [Environment]::ExpandEnvironmentVariables($Path)
    $Path = $Path.Trim('"').TrimEnd('\', '/')
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        if ($Path -match '\.exe$') { $Path = Split-Path -Parent $Path }
    }
    if (Test-AppDir $Path) { return $Path }
    $nested = Join-Path $Path 'resources\app'
    if (Test-AppDir $nested) { return $nested }
    if ($Path -match '\\resources\\app') { return $null }
    return $null
}

function Find-AppDir {
    $candidates = New-Object System.Collections.Generic.List[string]

    # 1. running instance
    foreach ($p in @(Get-Process -Name 'ApkStart' -ErrorAction SilentlyContinue)) {
        try { if ($p.Path) { $candidates.Add((Split-Path -Parent $p.Path)) } } catch { }
    }

    # 2. uninstall registry entries (user + machine)
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (-not (Test-Path $root)) { continue }
        foreach ($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
            try {
                $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
                if ($item.DisplayName -and $item.DisplayName -like 'ApkStart*' -and $item.InstallLocation) {
                    $candidates.Add($item.InstallLocation)
                }
            } catch { }
        }
    }

    # 3. common locations
    $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\ApkStart'))
    $candidates.Add((Join-Path $env:LOCALAPPDATA 'ApkStart'))
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'ApkStart')) }
    if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'ApkStart')) }
    $candidates.Add((Join-Path $env:USERPROFILE 'Apps\ApkStart'))
    $candidates.Add('C:\ApkStart')

    foreach ($c in $candidates) {
        $resolved = Resolve-AppDir $c
        if ($resolved) { return $resolved }
    }
    return $null
}

function Get-Backups([string]$Version) {
    if (-not (Test-Path -LiteralPath $script:BackupRoot)) { return @() }
    $hash = (Get-Sha256 -Path $script:ManifestFile).Substring(0, 8)
    $dirs = @(Get-ChildItem -LiteralPath $script:BackupRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$Version-$hash-*" } |
        Sort-Object Name -Descending)
    return $dirs
}

if (-not (Test-Path -LiteralPath $script:ManifestFile)) {
    throw "patch\manifest.json not found next to this script. Run it from the unpacked apkstart-english folder."
}
$manifest = Get-Content -LiteralPath $script:ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json

# ---------------------------------------------------------------- locate app
if ($AppDir) {
    $target = Resolve-AppDir $AppDir
    if (-not $target) { throw "Not an ApkStart app folder: $AppDir (expected src\main.js and package.json)." }
} else {
    Write-Step 'Looking for ApkStart'
    $target = Find-AppDir
    if (-not $target) {
        throw "ApkStart was not found. Close it and pass the folder explicitly: -AppDir `"C:\path\to\ApkStart\resources\app`""
    }
}
Write-Ok $target

$pkg = Get-Content -LiteralPath (Join-Path $target 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$appVersion = [string]$pkg.version
$expectedVersion = [string]$manifest.upstream.version

Write-Step "ApkStart v$appVersion (patch is for v$expectedVersion)"
if ($appVersion -ne $expectedVersion -and -not $Force) {
    throw "This patch was built for v$expectedVersion, but v$appVersion is installed. " +
          "Use -Force only if you know the files still match, or rebuild the patch with scripts\build-en.js."
}

# ---------------------------------------------------------------- restore
if ($Restore) {
    Write-Step 'Restoring the original Chinese files'
    $backups = Get-Backups -Version $expectedVersion
    if (-not $backups -or $backups.Count -eq 0) {
        throw "No backup found for $target under $script:BackupRoot. Reinstall ApkStart to get the original files back."
    }
    $backup = $backups[0]
    $metaFile = Join-Path $backup.FullName 'backup.json'
    if (-not (Test-Path -LiteralPath $metaFile)) { throw "Backup is incomplete: $metaFile is missing." }
    $meta = Get-Content -LiteralPath $metaFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($meta.appDir -and $meta.appDir -ne $target) {
        Write-Warn2 "Backup was taken from: $($meta.appDir)"
        Write-Warn2 "Restoring into:        $target"
    }

    $restored = 0
    foreach ($rel in $meta.files.PSObject.Properties.Name) {
        $from = Join-Path $backup.FullName ('app\' + ($rel -replace '/', '\'))
        if (-not (Test-Path -LiteralPath $from)) {
            Write-Warn2 "missing in backup: $rel"
            continue
        }
        $to = Join-Path $target ($rel -replace '/', '\')
        $dir = Split-Path -Parent $to
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Copy-Item -LiteralPath $from -Destination $to -Force
        $restored++
    }
    Write-Ok "restored $restored files from $($backup.Name)"
    Write-Step 'Done. Start ApkStart again; the UI is Chinese.'
    exit 0
}

# ---------------------------------------------------------------- patch
$running = @(Get-Process -Name 'ApkStart' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    if (-not $StopApp) {
        throw "ApkStart is running. Quit it from the tray first, or run this script with -StopApp."
    }
    Write-Step 'Closing ApkStart'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

Write-Step 'Checking installed files'
$needsPatch = @()
$already = @()
$unexpected = @()
foreach ($rel in $manifest.files.PSObject.Properties.Name) {
    $info = $manifest.files.$rel
    $file = Join-Path $target ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $file)) {
        $unexpected += "$rel (missing)"
        continue
    }
    $hash = Get-Sha256 -Path $file
    if ($hash -eq $info.english) { $already += $rel }
    elseif ($hash -eq $info.upstream) { $needsPatch += $rel }
    else { $unexpected += $rel }
}
Write-Ok "stock files: $($needsPatch.Count)   already English: $($already.Count)   unexpected: $($unexpected.Count)"

if ($unexpected.Count -gt 0) {
    Write-Warn2 'These files do not match stock v0.5.3 or the English patch:'
    $unexpected | Select-Object -First 10 | ForEach-Object { Write-Warn2 "  $_" }
    if ($unexpected.Count -gt 10) { Write-Warn2 "  ... and $($unexpected.Count - 10) more" }
    if (-not $Force) {
        throw "Refusing to overwrite modified files. This usually means ApkStart updated itself. " +
              "Rebuild the patch for the new version (see README) or re-run with -Force to overwrite them anyway."
    }
    Write-Warn2 'Continuing because -Force was given.'
}

if ($needsPatch.Count -eq 0 -and $unexpected.Count -eq 0) {
    Write-Step 'Everything is already English, nothing to do.'
    exit 0
}

# ---------------------------------------------------------------- backup
Write-Step 'Backing up current files'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$hash = (Get-Sha256 -Path $script:ManifestFile).Substring(0, 8)
$backupDir = Join-Path $script:BackupRoot "$appVersion-$hash-$stamp"
$backupApp = Join-Path $backupDir 'app'
New-Item -ItemType Directory -Force -Path $backupApp | Out-Null

$hashes = [ordered]@{}
foreach ($rel in $manifest.files.PSObject.Properties.Name) {
    $file = Join-Path $target ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $dest = Join-Path $backupApp ($rel -replace '/', '\')
    $dir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $file -Destination $dest -Force
    $hashes[$rel] = Get-Sha256 -Path $file
}
$meta = [ordered]@{
    appDir = $target
    version = $appVersion
    createdAt = (Get-Date).ToString('o')
    files = $hashes
}
$meta | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupDir 'backup.json') -Encoding UTF8
Write-Ok $backupDir

# ---------------------------------------------------------------- copy
Write-Step 'Applying English files'
$copied = 0
foreach ($rel in $manifest.files.PSObject.Properties.Name) {
    $info = $manifest.files.$rel
    $from = Join-Path $script:PatchRoot ('app\' + ($rel -replace '/', '\'))
    $to = Join-Path $target ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $from)) { throw "Patch file missing: $from" }
    if (Test-Path -LiteralPath $to) {
        if ((Get-Sha256 -Path $to) -eq $info.english) { continue }
    }
    $dir = Split-Path -Parent $to
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $from -Destination $to -Force
    if ((Get-Sha256 -Path $to) -ne $info.english) { throw "Copy verification failed: $rel" }
    $copied++
}
Write-Ok "verified $copied files"

Write-Step 'Done. Start ApkStart again; the UI is English.'
Write-Host '    Note: a software update overwrites these files and brings Chinese back.' -ForegroundColor DarkGray
Write-Host '    Re-run this script after every update, or restore with -Restore.' -ForegroundColor DarkGray
