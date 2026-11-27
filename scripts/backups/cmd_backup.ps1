# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
<#
.SYNOPSIS
  Nightly LinkedHelper backup on lhserver: runs lib_capture_linkedhelper.ps1, then copies the archive to minis01 and applies retention there.
  Runs from a scheduled task every 30 minutes but only does work once per Austin, TX calendar day during the 23:00-23:59
  Austin hour (America/Chicago, DST-safe), so "11 PM Austin time" holds whatever time zone this machine uses.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File cmd_backup.ps1 -Force      # run now, ignoring the Austin time gate

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File cmd_backup.ps1 -Check      # test settings and the transfer target; no backup
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$Check,
    [string]$HomeDir = 'C:\Users\xuser',
    [string]$RemoteHost = '',        # else $env:LH_BACKUP_REMOTE_HOST, else "remoteHost" in <HomeDir>\.secrets\lhremote\backup.json (not in git)
    [string]$RemoteUser = 'xuser',
    [string]$RemoteDir = 'backups/linkedhelper',
    [int]$KeepRemote = 7,
    [int]$KeepLocal = 2
)

$ErrorActionPreference = 'Stop'
$config = Join-Path $HomeDir '.secrets\lhremote\backup.json'
if (-not $RemoteHost) { $RemoteHost = $env:LH_BACKUP_REMOTE_HOST }
if (-not $RemoteHost -and (Test-Path $config)) { $RemoteHost = (Get-Content $config -Raw | ConvertFrom-Json).remoteHost }
$logDir = Join-Path $HomeDir 'tmp\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$marker = Join-Path $HomeDir 'backups\linkedhelper\last-success.txt'
New-Item -ItemType Directory -Force (Split-Path $marker) | Out-Null
$key = Join-Path $HomeDir '.ssh\id_dev_insoftex_com'
$sshOpts = @('-i', $key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR')
$noTarget = "No backup target: pass -RemoteHost, set LH_BACKUP_REMOTE_HOST, or create $config with {`"remoteHost`":`"<ip or name>`"}"

if ($Check) {
    if (-not $RemoteHost) { throw $noTarget }
    & ssh @sshOpts "$RemoteUser@$RemoteHost" hostname
    if ($LASTEXITCODE -ne 0) { throw "cannot reach $RemoteHost over ssh" }
    "OK: target $RemoteHost reachable"
    exit 0
}

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

Start-Transcript -Path (Join-Path $logDir ("linkedhelper-backup-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) | Out-Null
try {
    # inside the transcript, so a missing setting leaves a log instead of failing silently
    if (-not $RemoteHost) { throw $noTarget }
    Write-Host "Austin time now: $($austin.ToString('yyyy-MM-dd HH:mm')) (day $austinDay)"
    $out = & (Join-Path $PSScriptRoot 'lib_capture_linkedhelper.ps1') -HomeDir $HomeDir -KeepLocal $KeepLocal 2>&1
    $backupExit = $LASTEXITCODE
    $out | ForEach-Object { Write-Host $_ }
    $line = $out | Where-Object { "$_" -like 'BACKUP_FILE=*' } | Select-Object -Last 1
    if (-not $line) { throw 'lib_capture_linkedhelper.ps1 produced no archive' }
    $tar = ("$line" -replace '^BACKUP_FILE=', '').Trim()
    $base = Split-Path $tar -Leaf
    $localHash = ((Get-Content "$tar.sha256" -Raw).Trim() -split '\s+')[0].ToLower()   # written by lib_capture_linkedhelper.ps1 (avoids hashing 3 GB twice)
    $target = "$RemoteUser@$RemoteHost"

    function Invoke-Remote([string]$Script) {
        $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
        # Output goes to files, not a pipe: when this script is itself run over SSH, Windows ssh.exe with a piped
        # stdout never exits, although the remote command has finished.
        $out = Join-Path $logDir "backup-ssh-$PID.out"
        $err = Join-Path $logDir "backup-ssh-$PID.err"
        try {
            $argList = @('-n') + $sshOpts + @($target, "`"powershell -NoProfile -NonInteractive -EncodedCommand $enc`"")
            $p = Start-Process ssh -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
            $o = "$(Get-Content $out -Raw)".Trim()
            if ($p.ExitCode -ne 0) { throw "remote command failed: $o $(Get-Content $err -Raw)" }
            return $o
        }
        finally { Remove-Item $out, $err -Force -ErrorAction SilentlyContinue }
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
    Get-ChildItem $logDir -Filter 'linkedhelper-backup-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 | Remove-Item -Force -ErrorAction SilentlyContinue
}
