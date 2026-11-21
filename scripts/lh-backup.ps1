# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Consistent backup of the LinkedHelper data on this Windows machine (normally lhserver).

.DESCRIPTION
  Creates ONE archive  <Dest>\lh-backup-<host>-<yyyyMMdd-HHmmss>.tar  plus .sha256 and .manifest.json.
  Why not just zip the folder: LinkedHelper keeps running (17+ processes) and holds its SQLite databases (lh.db, rollback-journal
  mode, up to ~1 GB per account) and the Chromium cookie/session files open. This script
    1. takes a Volume Shadow Copy (VSS) snapshot of C:, so every file is read at the same instant without locking anything
       and without touching the running application,
    2. copies only what is needed to rebuild a working environment (all accounts' lh.db, config, browser sessions/cookies,
       Local Storage, IndexedDB) and skips caches, logs, installers and LinkedHelper's own old lh.db.backup.* files,
    3. opens every copied lh.db (in the copy, never in the original) and runs PRAGMA quick_check,
    4. exports campaign configurations with the lhremote CLI when it is usable (best effort; lhremote has no backup command),
    5. writes manifest.json (versions, accounts, DB checks, sizes) and the archive + SHA-256.
  Read-only with respect to LinkedHelper: nothing is stopped, started or written in the live data folder.

.PARAMETER Dest
  Output folder (default C:\Users\xuser\backups\linkedhelper\local). Keeps the newest 2 archives there.
#>
[CmdletBinding()]
param(
    [string]$HomeDir = 'C:\Users\xuser',
    [string]$Dest = '',
    [int]$KeepLocal = 2,
    [switch]$NoCampaignExport,
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $Dest) { $Dest = Join-Path $HomeDir 'backups\linkedhelper\local' }
$DataDir = Join-Path $HomeDir 'AppData\Roaming\linked-helper'
$AppDir = Join-Path $HomeDir 'AppData\Local\linked-helper'
$ScriptsDir = Join-Path $HomeDir 'scripts'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = 'lh-backup-{0}-{1}' -f $env:COMPUTERNAME.ToLower(), $ts
$work = Join-Path $Dest "$name.work"
$tar = Join-Path $Dest "$name.tar"
$manifestFile = Join-Path $Dest "$name.manifest.json"

function Log([string]$m) { Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m) }

function Find-Node {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in 'C:\nvm4w\nodejs\node.exe', 'C:\Program Files\nodejs\node.exe') { if (Test-Path $p) { return $p } }
    return $null
}
function Find-LhremoteCli {
    foreach ($p in (Join-Path $ScriptsDir 'lhremote\dist\cli.js')) { if (Test-Path $p) { return $p } }
    $dirs = Get-ChildItem $ScriptsDir -Directory -Filter 'lhremote-*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^lhremote-\d+\.\d+\.\d+$' -and (Test-Path (Join-Path $_.FullName 'dist\cli.js')) } |
        Sort-Object { [version]($_.Name -replace '^lhremote-', '') } -Descending
    if ($dirs) { return (Join-Path $dirs[0].FullName 'dist\cli.js') }
    return $null
}

# robocopy exclusions: caches/logs/installers that are not needed to rebuild the environment
$excludeDirs = 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'sentry',
    'blob_storage', 'Shared Dictionary', 'errors', 'Instances'
$excludeFiles = 'log.*', '*.lhd2', '*.bak', 'lockfile', 'DevToolsActivePort', '*.tmp', '*~RF*.TMP'

New-Item -ItemType Directory -Force $Dest | Out-Null
New-Item -ItemType Directory -Force $work | Out-Null
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'   # be gentle with the production machine
$shadow = $null
$link = $null
$manifest = [ordered]@{
    host = $env:COMPUTERNAME; startedAt = (Get-Date).ToString('s'); archive = "$name.tar"
    linkedHelperAppVersions = @(Get-ChildItem $AppDir -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name -replace '^app-', '' })
    linkedHelperRunning = @(Get-Process -Name 'linked-helper' -ErrorAction SilentlyContinue).Count
    lhremote = $null; accounts = $null; campaignExport = $null; databases = @(); bytes = 0; errors = @()
}
$exit = 0

try {
    Log 'Creating VSS snapshot of C:'
    $res = (Get-WmiObject -List Win32_ShadowCopy).Create('C:\', 'ClientAccessible')
    if ($res.ReturnValue -ne 0) { throw "VSS snapshot failed (code $($res.ReturnValue))" }
    $shadow = Get-WmiObject Win32_ShadowCopy | Where-Object { $_.ID -eq $res.ShadowID }
    $link = Join-Path $env:TEMP "lh-shadow-$ts"
    cmd /c mklink /d "`"$link`"" "`"$($shadow.DeviceObject)\`"" | Out-Null
    $srcData = Join-Path $link $DataDir.Substring(3)
    if (-not (Test-Path $srcData)) { throw "Snapshot path not readable: $srcData" }

    Log "Copying LinkedHelper data from the snapshot ($srcData)"
    & robocopy "$srcData" "$work\data" /E /XD $excludeDirs /XF $excludeFiles /R:1 /W:1 /NFL /NDL /NJH /NP | Select-String 'Dirs :|Files :|Bytes :' | ForEach-Object { Log $_.Line.Trim() }
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }

    # LinkedHelper's own version stamp of the app files that wrote this data (for the restore compatibility check)
    $lhExe = Join-Path $AppDir 'linked-helper.exe'
    if (Test-Path $lhExe) { $manifest.linkedHelperLauncherVersion = (Get-Item $lhExe).VersionInfo.ProductVersion }
}
finally {
    if ($link -and (Test-Path $link)) { cmd /c rmdir "`"$link`"" | Out-Null }
    if ($shadow) { try { $shadow.Delete() | Out-Null; Log 'VSS snapshot removed' } catch { Log "WARNING: could not delete snapshot: $($_.Exception.Message)" } }
}

try {
    $node = Find-Node
    # 3. verify every copied lh.db (rolls back a hot journal in the COPY, which is the consistent state)
    if (-not $NoVerify -and $node) {
        $dbs = @(Get-ChildItem "$work\data\Partitions" -Recurse -Filter 'lh.db' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
        Log "Verifying $($dbs.Count) lh.db copies (PRAGMA quick_check)"
        $js = @'
const { DatabaseSync } = require('node:sqlite');
const out = [];
for (const p of process.argv.slice(2)) {
  try {
    const d = new DatabaseSync(p);
    const r = d.prepare('PRAGMA quick_check').all();
    const v = d.prepare('PRAGMA user_version').get();
    d.close();
    const first = Object.values(r[0])[0];
    out.push({ path: p, ok: r.length === 1 && first === 'ok', result: first, userVersion: Object.values(v)[0] });
  } catch (e) { out.push({ path: p, ok: false, result: String(e.message) }); }
}
console.log(JSON.stringify(out));
'@
        $jsFile = Join-Path $work 'verify-db.cjs'
        Set-Content $jsFile $js -Encoding ascii
        $json = & $node $jsFile @dbs 2>&1 | Select-Object -Last 1
        $checks = $json | ConvertFrom-Json
        foreach ($c in $checks) {
            $acct = if ($c.path -match 'account-(\d+)-main') { $Matches[1] } else { '?' }
            $manifest.databases += [ordered]@{ account = $acct; sizeMB = [math]::Round((Get-Item $c.path).Length / 1MB, 1); ok = $c.ok; result = $c.result; userVersion = $c.userVersion }
            if (-not $c.ok) { $manifest.errors += "lh.db of account $acct failed quick_check: $($c.result)"; $exit = 2 }
        }
        Remove-Item $jsFile -Force
        Get-ChildItem "$work\data\Partitions" -Recurse -Filter 'lh.db-journal' -ErrorAction SilentlyContinue | Remove-Item -Force
    }
    elseif (-not $node) { $manifest.errors += 'node.exe not found: lh.db copies were not verified' }

    # 4. campaign configurations via lhremote (best effort)
    $cli = Find-LhremoteCli
    if ($node -and $cli) {
        try { $manifest.lhremote = (& $node $cli --version 2>&1 | Select-Object -Last 1).ToString() } catch { }
        if (-not $NoCampaignExport) {
            Log 'Exporting campaign configurations with lhremote (best effort)'
            $cdir = Join-Path $work 'campaigns'; New-Item -ItemType Directory -Force $cdir | Out-Null
            try {
                $raw = & $node $cli list-accounts --json --include-archived 2>&1 | Out-String
                if ($LASTEXITCODE -ne 0) { throw ($raw.Trim().Split("`n")[0]) }
                Set-Content (Join-Path $cdir 'accounts.json') $raw -Encoding utf8
                $parsed = $raw | ConvertFrom-Json
                $accts = if ($parsed -is [array]) { $parsed } elseif ($parsed.accounts) { $parsed.accounts } else { @($parsed) }
                $manifest.accounts = @($accts | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name } })
                $n = 0
                foreach ($a in $accts) {
                    $list = & $node $cli campaign-list --json --include-archived --account-id $a.id 2>&1 | Out-String
                    if ($LASTEXITCODE -ne 0) { continue }
                    Set-Content (Join-Path $cdir "campaigns-$($a.id).json") $list -Encoding utf8
                    $lp = $list | ConvertFrom-Json
                    $camps = if ($lp -is [array]) { $lp } elseif ($lp.campaigns) { $lp.campaigns } else { @() }
                    foreach ($c in $camps) {
                        & $node $cli campaign-export $c.id --account-id $a.id --format yaml --output (Join-Path $cdir "campaign-$($a.id)-$($c.id).yaml") 2>&1 | Out-Null
                        if ($LASTEXITCODE -eq 0) { $n++ }
                    }
                }
                $manifest.campaignExport = "exported $n campaign configuration(s)"
            }
            catch { $manifest.campaignExport = "skipped: $($_.Exception.Message)" }
        }
    }
    else { $manifest.campaignExport = 'skipped: lhremote CLI not usable in this session' }

    # 5. archive + checksum + manifest
    $manifest.finishedAt = (Get-Date).ToString('s')
    $manifest.bytes = (Get-ChildItem $work -Recurse -File | Measure-Object Length -Sum).Sum
    $manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $work 'manifest.json') -Encoding utf8
    Log 'Creating archive'
    & "$env:SystemRoot\System32\tar.exe" -cf $tar -C $work .
    if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
    $hash = (Get-FileHash $tar -Algorithm SHA256).Hash.ToLower()
    Set-Content "$tar.sha256" ("{0} *{1}" -f $hash, (Split-Path $tar -Leaf)) -Encoding ascii
    Copy-Item (Join-Path $work 'manifest.json') $manifestFile -Force
    Log ('Archive: {0}  ({1:N2} GB)  sha256={2}' -f $tar, ((Get-Item $tar).Length / 1GB), $hash)
}
finally {
    if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}

# retention on this machine
$sets = @(Get-ChildItem $Dest -Filter 'lh-backup-*.tar' | Sort-Object Name -Descending)
if ($sets.Count -gt $KeepLocal) {
    foreach ($old in $sets | Select-Object -Skip $KeepLocal) {
        Remove-Item $old.FullName, "$($old.FullName).sha256", ($old.FullName -replace '\.tar$', '.manifest.json') -Force -ErrorAction SilentlyContinue
        Log "Removed old backup $($old.Name)"
    }
}
foreach ($e in $manifest.errors) { Log "PROBLEM: $e" }
Write-Output "BACKUP_FILE=$tar"
exit $exit
