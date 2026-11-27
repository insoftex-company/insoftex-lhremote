# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers (or removes) the scheduled task that runs cmd_backup.ps1 every 30 minutes; the script itself only works
  during the 23:00-23:59 Austin, TX hour and at most once per Austin day (DST-safe). Run on lhserver.
  The task runs as xuser in xuser's logged-on session (Interactive, highest privileges): the shadow copy needs
  elevation.
#>
param([switch]$Remove, [string]$HomeDir = 'C:\Users\xuser', [string]$User = 'xuser')
$name = 'LinkedHelper nightly backup - Austin 11PM'   # no ':' allowed in a task name
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; "Removed '$name'."; return }
$script = Join-Path $HomeDir 'backups\cmd_backup.ps1'
if (-not (Test-Path $script)) { throw "Missing $script" }
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
# daily trigger at 00:00 that repeats every 30 minutes for 24 hours (a 3650-day repetition is rejected by Task Scheduler)
$trg = New-ScheduledTaskTrigger -Daily -At '00:00'
$trg.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 23 -Minutes 59)).Repetition
$prin = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$User" -LogonType Interactive -RunLevel Highest
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName $name -Action $act -Trigger $trg -Principal $prin -Settings $set -Force | Out-Null
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-List
"Registered. It checks every 30 min; the backup itself runs once during 23:00-23:59 Austin time. Test now with:"
"  powershell -ExecutionPolicy Bypass -File `"$script`" -Force"
