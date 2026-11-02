@echo off
node "%~dp0lhremote\dist\cli.js" %*
exit /b %ERRORLEVEL%
