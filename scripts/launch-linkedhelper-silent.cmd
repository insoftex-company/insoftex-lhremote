@echo off
setlocal EnableExtensions

set "LH_PATH=C:\Users\xuser\AppData\Local\linked-helper\linked-helper.exe"
set "CDP_PORT=9222"
set "LOG=%TEMP%\lh-cdp-startup.log"

>"%LOG%" echo [%date% %time%] LinkedHelper CDP bootstrap starting

if not exist "%LH_PATH%" (
    >>"%LOG%" echo [%date% %time%] ERROR: executable not found: %LH_PATH%
    exit /b 1
)

rem Already listening on CDP? Nothing to do.
curl.exe --silent --fail http://127.0.0.1:%CDP_PORT%/json/version >nul 2>&1
if not errorlevel 1 (
    >>"%LOG%" echo [%date% %time%] CDP already available on port %CDP_PORT%
    exit /b 0
)

rem CDP down but LH running = stale non-debug instance. Kill it (mirrors launch-app --force).
tasklist /fi "imagename eq linked-helper.exe" 2>nul | find /i "linked-helper.exe" >nul
if not errorlevel 1 (
    >>"%LOG%" echo [%date% %time%] Terminating stale LinkedHelper instance (no CDP)
    taskkill /im linked-helper.exe /f >nul 2>&1
    timeout /t 3 /nobreak >nul
)

>>"%LOG%" echo [%date% %time%] Launching with --remote-debugging-port=%CDP_PORT%
start "" "%LH_PATH%" --remote-debugging-port=%CDP_PORT%

rem Wait up to 60s for the endpoint.
for /L %%I in (1,1,30) do (
    curl.exe --silent --fail http://127.0.0.1:%CDP_PORT%/json/version >nul 2>&1
    if not errorlevel 1 (
        >>"%LOG%" echo [%date% %time%] CDP up after %%I check^(s^)
        exit /b 0
    )
    timeout /t 2 /nobreak >nul
)

>>"%LOG%" echo [%date% %time%] ERROR: CDP not available after 60s
exit /b 2


