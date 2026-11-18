#requires -Version 5.1
<#
.SYNOPSIS
    Restores the original Chinese files of ApkStart v0.5.8.

.DESCRIPTION
    Shortcut for "install-en.ps1 -Restore". Uses the newest backup created by
    install-en.ps1 and verifies the restored files.

.PARAMETER AppDir
    Path to "ApkStart\resources\app" (or the install folder). Detected
    automatically when omitted.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\restore-zh.ps1
#>
[CmdletBinding()]
param(
    [string]$AppDir
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $here 'install-en.ps1'
if (-not (Test-Path -LiteralPath $installer)) {
    throw "install-en.ps1 not found next to this script."
}
& $installer -Restore -AppDir $AppDir
