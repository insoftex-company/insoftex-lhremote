# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Registers (or removes) the daily task that runs cmd_check_backup.ps1 on the standby machine.
  10:00 local time is a few hours after the 23:00 Austin backup normally arrives.
#>
param([switch]$Remove, [string]$HomeDir = 'C:\Users\xuser', [string]$User = 'xuser')
$name = 'LinkedHelper backup freshness check'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; "Removed '$name'."; return }
$script = Join-Path $HomeDir 'backups\cmd_check_backup.ps1'
if (-not (Test-Path $script)) { throw "Missing $script" }
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trg = New-ScheduledTaskTrigger -Daily -At '10:00'
# Interactive, so that the warning appears in the logged-on session
$prin = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$User" -LogonType Interactive -RunLevel Limited
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $name -Action $act -Trigger $trg -Principal $prin -Settings $set -Force | Out-Null
"Registered '$name' (daily 10:00)."
