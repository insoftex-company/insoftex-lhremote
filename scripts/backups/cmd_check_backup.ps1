# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
<#
.SYNOPSIS
  On the standby machine: warns when the newest backup received from the source machine is too old.

.DESCRIPTION
  Looks only at what arrived here, so it catches any cause on the source side (missing settings, a hung run, the machine
  being off). A stale or missing backup is logged, shown as a message in the logged-on session and gives exit code 1.
#>
[CmdletBinding()]
param(
    [string]$HomeDir = 'C:\Users\xuser',
    [int]$MaxAgeHours = 24,
    [switch]$NoMessage
)

$ErrorActionPreference = 'Stop'
$dir = Join-Path $HomeDir 'backups\linkedhelper'
$log = Join-Path $HomeDir 'tmp\logs\linkedhelper-backup-check.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

# an unfinished transfer is named *.tar.part and does not match
$latest = Get-ChildItem $dir -Filter 'lh-backup-*.tar' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*.tar' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$age = if ($latest) { [math]::Round(((Get-Date) - $latest.LastWriteTime).TotalHours, 1) } else { $null }
$stale = -not $latest -or $age -gt $MaxAgeHours

$text = if (-not $latest) { "no LinkedHelper backup in $dir" }
else { "newest LinkedHelper backup is $age h old ($($latest.Name))" }
$status = if ($stale) { 'STALE' } else { 'OK' }
$line = '{0} {1} {2}' -f (Get-Date -Format 's'), $status, $text
$lines = @(if (Test-Path $log) { Get-Content $log }) + $line
Set-Content $log ($lines | Select-Object -Last 200) -Encoding utf8
$line

if (-not $stale) { exit 0 }
if (-not $NoMessage) {
    & "$env:SystemRoot\System32\msg.exe" * /TIME:86400 "LinkedHelper backup problem: $text. Check lhserver: ~\tmp\logs\linkedhelper-backup-*.log"
}
exit 1
