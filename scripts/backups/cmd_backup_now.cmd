@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
rem lhserver: make a LinkedHelper backup right now and copy it to minis01 (same as the nightly job, ignoring the Austin 23:00 gate).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cmd_backup.ps1" -Force
pause
