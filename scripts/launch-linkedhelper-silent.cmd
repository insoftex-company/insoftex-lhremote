@echo off
setlocal EnableExtensions
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0launch-linkedhelper.ps1" -Silent
exit /b %ERRORLEVEL%
