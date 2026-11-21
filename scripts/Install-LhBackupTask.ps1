# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers (or removes) the scheduled task that runs lh-backup-nightly.ps1 every 30 minutes; the script itself only works
  during the 23:00-23:59 Austin, TX hour and at most once per Austin day (DST-safe). Run on lhserver.
  The task runs as xuser in xuser's logged-on session (Interactive, highest privileges): the lhremote CLI cannot resolve its
  pnpm junctions from non-interactive (ssh / S4U) logons on this machine, and the shadow copy needs elevation.
#>
param([switch]$Remove, [string]$HomeDir = 'C:\Users\xuser', [string]$User = 'xuser')
$name = 'LinkedHelper nightly backup (Austin 23:00)'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; "Removed '$name'."; return }
$script = Join-Path $HomeDir 'scripts\lh-backup-nightly.ps1'
if (-not (Test-Path $script)) { throw "Missing $script" }
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trg = New-ScheduledTaskTrigger -Once -At (Get-Date '00:00') -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$prin = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$User" -LogonType Interactive -RunLevel Highest
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName $name -Action $act -Trigger $trg -Principal $prin -Settings $set -Force | Out-Null
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-List
"Registered. It checks every 30 min; the backup itself runs once during 23:00-23:59 Austin time. Test now with:"
"  powershell -ExecutionPolicy Bypass -File `"$script`" -Force"
