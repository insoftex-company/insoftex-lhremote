# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
<#
.SYNOPSIS
  Restores a LinkedHelper backup made by lib_capture_linkedhelper.ps1 (normally on minis01, the standby machine).

.DESCRIPTION
  Two stages so the standby can be kept "ready" without ever running two LinkedHelpers on the same accounts:
    -Stage    (default, safe, touches nothing live): verifies the archive SHA-256, extracts it to a staging folder, opens every
              staged lh.db and runs PRAGMA quick_check, prints what the backup contains.
    -Activate (needs -IConfirmLhserverIsStopped): puts the staged data into %APPDATA%\linked-helper. LinkedHelper must not be
              running. Everything it replaces is MOVED (not deleted) to backups\linkedhelper\pre-restore-<time> first.
              No instance or campaign is started; start LinkedHelper yourself afterwards (launch-linkedhelper.cmd) and start
              instances only when lhserver is completely stopped.

.EXAMPLE
  cmd_restore_linkedhelper.ps1                                   # stage the newest archive in ~\backups\linkedhelper
  cmd_restore_linkedhelper.ps1 -Activate -IConfirmLhserverIsStopped
  cmd_restore_linkedhelper.ps1 -Archive C:\Users\xuser\backups\linkedhelper\lh-backup-desktop-l00df47-20261122-231500.tar -Stage
#>
[CmdletBinding()]
param(
    [string]$Archive = '',
    [string]$HomeDir = 'C:\Users\xuser',
    [switch]$Stage,
    [switch]$Activate,
    [switch]$IConfirmLhserverIsStopped,
    [switch]$QuitLinkedHelper
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$backupRoot = Join-Path $HomeDir 'backups\linkedhelper'
$stageDir = Join-Path $backupRoot 'staged'
$dataDir = Join-Path $HomeDir 'AppData\Roaming\linked-helper'
function Log([string]$m) { Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m) }
function Find-Node {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in 'C:\nvm4w\nodejs\node.exe', 'C:\Program Files\nodejs\node.exe') { if (Test-Path $p) { return $p } }
    return $null
}

if (-not $Archive) {
    $latest = Get-ChildItem $backupRoot -Filter 'lh-backup-*.tar' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) { throw "No lh-backup-*.tar in $backupRoot" }
    $Archive = $latest.FullName
}
if (-not (Test-Path $Archive)) { throw "Archive not found: $Archive" }

if ($Activate -and -not $IConfirmLhserverIsStopped) {
    throw 'Refusing to activate: add -IConfirmLhserverIsStopped to confirm that LinkedHelper is completely stopped on lhserver (two copies on the same accounts must never run).'
}

# ---------- stage ----------
$alreadyStaged = (Test-Path (Join-Path $stageDir 'manifest.json')) -and ((Get-Content (Join-Path $stageDir 'manifest.json') -Raw | ConvertFrom-Json).archive -eq (Split-Path $Archive -Leaf))
if (-not $alreadyStaged -or -not $Activate) {
    Log "Archive: $Archive ($([math]::Round((Get-Item $Archive).Length/1GB,2)) GB)"
    $shaFile = "$Archive.sha256"
    if (Test-Path $shaFile) {
        $expected = ((Get-Content $shaFile -Raw).Trim() -split '\s+')[0].ToLower()
        $actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLower()
        if ($expected -ne $actual) { throw "Checksum mismatch: expected $expected, got $actual" }
        Log 'SHA-256 verified'
    }
    else { Log 'WARNING: no .sha256 file next to the archive; checksum not verified' }

    if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
    New-Item -ItemType Directory -Force $stageDir | Out-Null
    Log 'Extracting to the staging folder'
    & "$env:SystemRoot\System32\tar.exe" -xf $Archive -C $stageDir
    if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }

    $manifest = Get-Content (Join-Path $stageDir 'manifest.json') -Raw | ConvertFrom-Json
    Log ("Backup of {0} taken {1}; LinkedHelper app versions on the source: {2}; running at the time: {3}" -f $manifest.host, $manifest.startedAt, ($manifest.linkedHelperAppVersions -join ', '), $manifest.linkedHelperRunning)
    if ($manifest.campaignExport) { Log "Campaign export: $($manifest.campaignExport)" }

    $node = Find-Node
    if ($node) {
        $dbs = @(Get-ChildItem (Join-Path $stageDir 'data\Partitions') -Recurse -Filter 'lh.db' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
        $js = "const {DatabaseSync}=require('node:sqlite');for(const p of process.argv.slice(2)){try{const d=new DatabaseSync(p,{readOnly:true});const r=d.prepare('PRAGMA quick_check').get();d.close();console.log((Object.values(r)[0]==='ok'?'OK   ':'FAIL ')+p)}catch(e){console.log('FAIL '+p+' '+e.message)}}"
        $jsFile = Join-Path $stageDir 'verify.cjs'; Set-Content $jsFile $js -Encoding ascii
        Log "Checking $($dbs.Count) staged databases"
        & $node $jsFile @dbs | ForEach-Object { Log $_ }
        Remove-Item $jsFile -Force
    }
    $installed = @(Get-ChildItem (Join-Path $HomeDir 'AppData\Local\linked-helper') -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name -replace '^app-', '' })
    Log "LinkedHelper app versions installed here: $($installed -join ', ')"
    $newest = ($manifest.linkedHelperAppVersions | Sort-Object { [version]$_ } -Descending | Select-Object -First 1)
    if ($newest -and ($installed -notcontains $newest)) { Log "WARNING: the backup was written by LinkedHelper $newest, which is not installed here. Install the same version before activating (a database from a newer LinkedHelper may not open in an older one)." }
    Log "Staged OK in $stageDir"
}

# ---------- activate ----------
if ($Activate) {
    $running = @(Get-Process -Name 'linked-helper' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        if (-not $QuitLinkedHelper) { throw "LinkedHelper is running here ($($running.Count) processes). Quit it first or add -QuitLinkedHelper." }
        Log 'Quitting LinkedHelper'
        $running | Stop-Process -Force
        Start-Sleep 5
        if (Get-Process -Name 'linked-helper' -ErrorAction SilentlyContinue) { throw 'LinkedHelper is still running.' }
    }
    $pre = Join-Path $backupRoot ('pre-restore-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force $pre | Out-Null
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    $src = Join-Path $stageDir 'data'
    $items = @(Get-ChildItem $src -Force | Where-Object { $_.Name -ne 'Partitions' })
    foreach ($it in $items) {
        $dst = Join-Path $dataDir $it.Name
        if (Test-Path $dst) { Move-Item $dst (Join-Path $pre $it.Name) -Force }
        Move-Item $it.FullName $dst -Force
    }
    New-Item -ItemType Directory -Force (Join-Path $dataDir 'Partitions') | Out-Null
    foreach ($p in Get-ChildItem (Join-Path $src 'Partitions') -Directory -Force) {
        $dst = Join-Path $dataDir "Partitions\$($p.Name)"
        if (Test-Path $dst) { New-Item -ItemType Directory -Force (Join-Path $pre 'Partitions') | Out-Null; Move-Item $dst (Join-Path $pre "Partitions\$($p.Name)") -Force }
        Move-Item $p.FullName $dst -Force
    }
    Log "Restored into $dataDir. Replaced data was moved to $pre"
    Log 'No instance was started. Next: launch-linkedhelper.cmd, then check with: lhremote check-status / list-accounts'
}
else { Log 'Staged only; nothing in the live LinkedHelper data was changed. To switch this machine over: cmd_restore_linkedhelper.ps1 -Activate -IConfirmLhserverIsStopped' }
