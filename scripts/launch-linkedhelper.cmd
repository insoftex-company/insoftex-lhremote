@echo off
setlocal EnableExtensions

set "LH_PATH=C:\Users\xuser\AppData\Local\linked-helper\linked-helper.exe"
set "CDP_PORT=9222"

echo ==================================================
echo Starting LinkedHelper with CDP enabled
echo Executable: %LH_PATH%
echo CDP port:   %CDP_PORT%
echo ==================================================

if not exist "%LH_PATH%" (
    echo ERROR: LinkedHelper executable not found:
    echo %LH_PATH%
    pause
    exit /b 1
)

curl.exe --silent --fail ^
  http://127.0.0.1:%CDP_PORT%/json/version ^
  >nul 2>&1

if not errorlevel 1 (
    echo LinkedHelper CDP is already available.
    goto :test_lhremote
)

echo Launching LinkedHelper...

start "" "%LH_PATH%" --remote-debugging-port=%CDP_PORT%

echo Waiting for CDP endpoint...

set "CDP_READY=0"

for /L %%I in (1,1,30) do (
    curl.exe --silent --fail ^
      http://127.0.0.1:%CDP_PORT%/json/version ^
      >"%TEMP%\lh-cdp.json" 2>nul

    if not errorlevel 1 (
        set "CDP_READY=1"
        goto :cdp_ready
    )

    echo Waiting for CDP... %%I/30
    timeout /t 2 /nobreak >nul
)

:cdp_ready

if "%CDP_READY%"=="0" (
    echo.
    echo ERROR: LinkedHelper started, but CDP did not become available.
    pause
    exit /b 2
)

echo.
echo CDP endpoint is available.

:test_lhremote

echo.
echo Testing lhremote connection...

lhremote.cmd list-accounts --cdp-port %CDP_PORT% --json

if errorlevel 1 (
    echo.
    echo ERROR: lhremote could not connect to LinkedHelper.
    pause
    exit /b 3
)

echo.
echo LinkedHelper is running and accessible through lhremote.
echo.

pause
endlocal
