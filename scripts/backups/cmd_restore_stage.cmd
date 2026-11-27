@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
rem minis01: verify and stage the newest backup from %USERPROFILE%\backups\linkedhelper (touches nothing live).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cmd_restore_linkedhelper.ps1" -Stage
pause
