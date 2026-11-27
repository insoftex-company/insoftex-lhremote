# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
<#
.SYNOPSIS
  Installs this repository's operator files on a Windows LinkedHelper machine, from the Git checkout.

.DESCRIPTION
  Layout (docs/windows-host-layout.md): operator scripts in ~\scripts, backup and restore commands in ~\backups,
  private settings in ~\.secrets, logs in ~\tmp\logs. Copies the files of the given role and removes the files this
  repository installed earlier under other names or for the other role. Never touches files of other repositories.
  The lhremote application itself is deployed by 'pnpm build' (scripts/deploy-local.mjs).

.PARAMETER Role
  Source  = the machine that runs LinkedHelper and produces backups (lhserver).
  Standby = the machine that receives backups and can take over (minis01).

.PARAMETER Check
  Only report differences from the repository; exit 1 if there are any.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1 -Role Source -Check
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Source', 'Standby')][string]$Role,
    [switch]$Check,
    [string]$HomeDir = $env:USERPROFILE
)

$ErrorActionPreference = 'Stop'

$common = @('lhremote.cmd', 'lhremote.ps1', 'launch-linkedhelper.cmd', 'launch-linkedhelper.ps1',
    'launch-linkedhelper-silent.cmd', 'launch-linkedhelper-silent.vbs')
$roleFiles = @{
    Source  = @('cmd_backup.ps1', 'cmd_backup_now.cmd', 'cmd_install_backup_task.ps1', 'lib_capture_linkedhelper.ps1')
    Standby = @('cmd_restore_linkedhelper.ps1', 'cmd_restore_stage.cmd', 'cmd_restore_activate.cmd')
}
# Names used before the move to ~\backups. Keep until every machine has been installed once.
$formerNames = @('lh-backup.ps1', 'lh-backup-nightly.ps1', 'lh-backup-now.cmd', 'lh-restore.ps1', 'lh-restore-stage.cmd',
    'lh-restore-activate.cmd', 'Install-LhBackupTask.ps1')

$wanted = @()
foreach ($f in $common) { $wanted += , @((Join-Path $PSScriptRoot $f), (Join-Path $HomeDir "scripts\$f")) }
foreach ($f in $roleFiles[$Role]) { $wanted += , @((Join-Path $PSScriptRoot "backups\$f"), (Join-Path $HomeDir "backups\$f")) }

$retired = @($formerNames | ForEach-Object { Join-Path $HomeDir "scripts\$_" })
$other = if ($Role -eq 'Source') { 'Standby' } else { 'Source' }
$retired += @($roleFiles[$other] | ForEach-Object { Join-Path $HomeDir "backups\$_" })

$drift = 0
foreach ($pair in $wanted) {
    $from, $to = $pair
    if ((Test-Path $to) -and (Get-FileHash $from).Hash -eq (Get-FileHash $to).Hash) { continue }
    $drift++
    if ($Check) { "differs or missing: $to"; continue }
    New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    Copy-Item $from $to -Force
    "installed: $to"
}
foreach ($path in $retired | Where-Object { Test-Path $_ }) {
    $drift++
    if ($Check) { "retired file still present: $path"; continue }
    Remove-Item $path -Force
    "removed: $path"
}
if (-not $Check) { New-Item -ItemType Directory -Force (Join-Path $HomeDir 'tmp\logs') | Out-Null }

# lhremote is started by name (launcher, synchronisation scripts), so ~\scripts has to be on PATH.
$scripts = Join-Path $HomeDir 'scripts'
$onPath = @(([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')).Split(';') |
    Where-Object { $_.TrimEnd('\') -ieq $scripts }).Count -gt 0
if (-not $onPath) {
    $drift++
    if ($Check) { "not on PATH: $scripts" }
    else {
        $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        $current = $envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
        $envKey.SetValue('Path', "$scripts;$current", 'ExpandString')
        $envKey.Close()
        "added to the user PATH (effective at the next logon): $scripts"
    }
}

if ($Role -eq 'Source') {
    $script = Join-Path $HomeDir 'backups\cmd_backup.ps1'
    $task = Get-ScheduledTask -TaskName 'LinkedHelper nightly backup - Austin 11PM' -ErrorAction SilentlyContinue
    if (-not $task -or $task.Actions[0].Arguments -notlike "*`"$script`"*") {
        $drift++
        if ($Check) { 'backup task missing or pointing elsewhere' }
        else { & (Join-Path $HomeDir 'backups\cmd_install_backup_task.ps1') -HomeDir $HomeDir }
    }
    if (-not (Test-Path (Join-Path $HomeDir '.secrets\lhremote\backup.json'))) {
        Write-Warning 'No .secrets\lhremote\backup.json: backups have no target. See docs/backup-restore.md.'
        $drift++
    }
}
"role=$Role differences=$drift"
if ($Check -and $drift -gt 0) { exit 1 }
