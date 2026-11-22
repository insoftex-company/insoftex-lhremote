# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
<#
.SYNOPSIS
  Nightly LinkedHelper backup on lhserver: runs lh-backup.ps1, then copies the archive to minis01 and applies retention there.
  Runs from a scheduled task every 30 minutes but only does work once per Austin, TX calendar day during the 23:00-23:59
  Austin hour (America/Chicago, DST-safe), so "11 PM Austin time" holds whatever time zone this machine uses.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File lh-backup-nightly.ps1 -Force      # run now, ignoring the Austin time gate
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [string]$HomeDir = 'C:\Users\xuser',
    [string]$RemoteHost = '',        # else $env:LH_BACKUP_REMOTE_HOST, else "remoteHost" in <HomeDir>\scripts\lh-backup.config.json (not in git)
    [string]$RemoteUser = 'xuser',
    [string]$RemoteDir = 'backups/linkedhelper',
    [int]$KeepRemote = 7,
    [int]$KeepLocal = 2
)

$ErrorActionPreference = 'Stop'
if (-not $RemoteHost) { $RemoteHost = $env:LH_BACKUP_REMOTE_HOST }
if (-not $RemoteHost) {
    $cfg = Join-Path $HomeDir 'scripts\lh-backup.config.json'
    if (Test-Path $cfg) { $RemoteHost = (Get-Content $cfg -Raw | ConvertFrom-Json).remoteHost }
}
if (-not $RemoteHost) { throw 'No backup target: pass -RemoteHost, set LH_BACKUP_REMOTE_HOST, or create scripts\lh-backup.config.json with {"remoteHost":"<ip or name>"}' }
$logDir = Join-Path $HomeDir 'scripts\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$marker = Join-Path $logDir 'lh-backup-last-success.txt'
$tz = [TimeZoneInfo]::FindSystemTimeZoneById('Central Standard Time')   # Austin, TX (handles CST/CDT)
$austin = [TimeZoneInfo]::ConvertTime((Get-Date), $tz)
$austinDay = $austin.ToString('yyyy-MM-dd')
if (-not $Force) {
    if ($austin.Hour -ne 23) { exit 0 }
    if ((Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $austinDay)) { exit 0 }
}

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\InsoftexLhBackup', [ref]$created)
if (-not $created) { Write-Host 'Another backup is running; exiting.'; exit 0 }

Start-Transcript -Path (Join-Path $logDir ("lh-backup-nightly-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) | Out-Null
try {
    Write-Host "Austin time now: $($austin.ToString('yyyy-MM-dd HH:mm')) (day $austinDay)"
    $out = & (Join-Path $PSScriptRoot 'lh-backup.ps1') -HomeDir $HomeDir -KeepLocal $KeepLocal 2>&1
    $backupExit = $LASTEXITCODE
    $out | ForEach-Object { Write-Host $_ }
    $line = $out | Where-Object { "$_" -like 'BACKUP_FILE=*' } | Select-Object -Last 1
    if (-not $line) { throw 'lh-backup.ps1 produced no archive' }
    $tar = ("$line" -replace '^BACKUP_FILE=', '').Trim()
    $base = Split-Path $tar -Leaf
    $localHash = ((Get-Content "$tar.sha256" -Raw).Trim() -split '\s+')[0].ToLower()   # written by lh-backup.ps1 (avoids hashing 3 GB twice)
    $key = Join-Path $HomeDir '.ssh\id_dev_insoftex_com'
    $sshOpts = @('-i', $key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR')
    $target = "$RemoteUser@$RemoteHost"

    function Invoke-Remote([string]$Script) {
        $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
        $o = & ssh @sshOpts $target "powershell -NoProfile -NonInteractive -EncodedCommand $enc" 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "remote command failed: $o" }
        return $o.Trim()
    }

    Write-Host "Preparing $target`:$RemoteDir"
    Invoke-Remote "New-Item -ItemType Directory -Force (Join-Path `$HOME '$RemoteDir') | Out-Null; 'ok'" | Out-Null

    Write-Host "Copying $base ($([math]::Round((Get-Item $tar).Length/1GB,2)) GB) to minis01"
    & scp @sshOpts $tar "${target}:$RemoteDir/$base.part"
    if ($LASTEXITCODE -ne 0) { throw 'scp of the archive failed' }
    & scp @sshOpts "$tar.sha256" ($tar -replace '\.tar$', '.manifest.json') "${target}:$RemoteDir/"
    if ($LASTEXITCODE -ne 0) { throw 'scp of checksum/manifest failed' }

    $remoteHash = Invoke-Remote "(Get-FileHash (Join-Path `$HOME '$RemoteDir/$base.part') -Algorithm SHA256).Hash.ToLower()"
    if ($remoteHash -ne $localHash) { throw "checksum mismatch after transfer (local $localHash, remote $remoteHash)" }
    Invoke-Remote "Move-Item -Force (Join-Path `$HOME '$RemoteDir/$base.part') (Join-Path `$HOME '$RemoteDir/$base'); 'ok'" | Out-Null
    Write-Host "Transferred and verified on minis01 (sha256 $remoteHash)"

    $kept = Invoke-Remote @"
`$d = Join-Path `$HOME '$RemoteDir'
`$sets = @(Get-ChildItem `$d -Filter 'lh-backup-*.tar' | Sort-Object Name -Descending)
foreach (`$old in `$sets | Select-Object -Skip $KeepRemote) {
  Remove-Item `$old.FullName, (`$old.FullName + '.sha256'), (`$old.FullName -replace '\.tar$','.manifest.json') -Force -ErrorAction SilentlyContinue
}
"minis01 now keeps " + (@(Get-ChildItem `$d -Filter 'lh-backup-*.tar').Count) + " archive(s)"
"@
    Write-Host $kept
    if (-not $Force) { Set-Content $marker $austinDay -Encoding ascii }   # a manual -Force run must not make the scheduled 23:00 run skip itself
    if ($backupExit -ne 0) { Write-Host "NOTE: the backup finished with warnings (exit $backupExit); see the PROBLEM lines above."; exit $backupExit }
    Write-Host 'Nightly LinkedHelper backup OK.'
}
catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    exit 1
}
finally {
    Stop-Transcript | Out-Null
    $mutex.ReleaseMutex()
    Get-ChildItem $logDir -Filter 'lh-backup-nightly-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 | Remove-Item -Force -ErrorAction SilentlyContinue
}
