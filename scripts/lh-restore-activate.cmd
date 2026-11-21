@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
rem minis01: SWITCH OVER - put the staged backup into the live LinkedHelper data. Only when LinkedHelper is completely stopped on lhserver.
echo This replaces the LinkedHelper data on THIS computer with the newest staged backup.
echo Do it only if LinkedHelper is completely stopped on lhserver.
set /p OK=Type YES to continue: 
if /i not "%OK%"=="YES" exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lh-restore.ps1" -Activate -IConfirmLhserverIsStopped -QuitLinkedHelper
pause
