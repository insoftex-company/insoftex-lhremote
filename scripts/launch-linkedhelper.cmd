@echo off
setlocal EnableExtensions
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0launch-linkedhelper.ps1"
set "BOOTSTRAP_EXIT=%ERRORLEVEL%"
pause
exit /b %BOOTSTRAP_EXIT%
