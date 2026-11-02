# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Insoftex

param(
    [ValidateRange(1, 65535)][int]$Port = $(if ($env:CDP_PORT) { [int]$env:CDP_PORT } else { 9222 }),
    [string]$LinkedHelperPath = $env:LINKEDHELPER_PATH,
    [ValidateRange(1, 600)][int]$WaitSeconds = 60,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$log = Join-Path ([System.IO.Path]::GetTempPath()) 'lh-cdp-startup.log'
function Write-Status([string]$Message) {
    if ($Silent) { Add-Content -LiteralPath $log -Encoding UTF8 -Value "[$(Get-Date -Format o)] $Message" }
    else { Write-Host $Message }
}

function Get-LhProcesses {
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'linked-helper.exe' OR Name = 'LinkedHelper.exe'" |
        Select-Object ProcessId, CommandLine)
}

function Test-Cdp {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3
        $body = $response.Content.Trim()
        if (-not $body.StartsWith('[') -or -not $body.EndsWith(']')) { return $false }
        $targets = @($body | ConvertFrom-Json)
        foreach ($target in $targets) {
            if ($null -eq $target -or $target.id -isnot [string] -or $target.type -isnot [string] -or $target.url -isnot [string]) { return $false }
        }
        return $true
    } catch { return $false }
}

function Resolve-Binary {
    if ($LinkedHelperPath) {
        $candidate = $LinkedHelperPath.Trim('"')
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        throw 'LINKEDHELPER_PATH does not point to an executable file.'
    }
    $localData = $env:LOCALAPPDATA
    if (-not $localData -and $env:USERPROFILE) { $localData = Join-Path $env:USERPROFILE 'AppData\Local' }
    $roots = @($localData, $(if ($localData) { Join-Path $localData 'Programs' }), $env:ProgramFiles, ${env:ProgramFiles(x86)})
    foreach ($root in $roots) {
        if (-not $root) { continue }
        foreach ($directory in @('linked-helper', 'LinkedHelper')) {
            $candidate = Join-Path $root "$directory\linked-helper.exe"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    throw 'LinkedHelper executable not found. Set LINKEDHELPER_PATH.'
}

$mutex = [System.Threading.Mutex]::new($false, "Local\Insoftex.Lhremote.Bootstrap.$Port")
$held = $false
try {
    try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Another bootstrap is already in progress. Retry after it finishes.' }
    Write-Status "Checking LinkedHelper CDP on port $Port"
    $existing = @(Get-LhProcesses)
    if ($existing.Count -eq 0) {
        if (Test-Cdp) { throw "Port $Port already exposes another debugger. Refusing to reuse it." }
        $binary = Resolve-Binary
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        Start-Process -FilePath $binary -ArgumentList "--remote-debugging-port=$Port" | Out-Null
        Write-Status 'Started LinkedHelper; waiting for its real GUI process and CDP endpoint.'
    } else {
        Write-Status 'LinkedHelper processes exist. Waiting through startup/recovery; no processes will be killed.'
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $portPattern = '(?:^|[\s"])--remote-debugging-port="?{0}"?(?:\s|"|$)' -f $Port
    do {
        $launchers = @(Get-LhProcesses | Where-Object {
            $_.CommandLine -match $portPattern -and $_.CommandLine -notmatch '--(?:app-id|type)='
        })
        if ($launchers.Count -gt 0 -and (Test-Cdp)) {
            Write-Status "LinkedHelper launcher CDP is available on port $Port."
            if (-not $Silent) {
                $cli = Get-Command lhremote.cmd -ErrorAction Stop
                & $cli.Source list-accounts --cdp-port $Port --json
                if ($LASTEXITCODE -ne 0) { throw 'lhremote could not read launcher accounts.' }
            }
            exit 0
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Launcher CDP was not verified within $WaitSeconds seconds. Run lhremote find-app / check-status. Use launch-app --force only for a deliberate full restart."
} catch {
    Write-Status "ERROR: $($_.Exception.Message)"
    exit 2
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
