@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

set PORT=%1
if "%PORT%"=="" set PORT=8080
set "SCRIPT_DIR=%~dp0"

echo ========================================
echo   WLOC Spoofer - PC Proxy Server
echo ========================================
echo.

echo [1/4] Detecting runtime engine...
set "ENGINE="
where node.exe >nul 2>&1
if errorlevel 1 (
    echo        [SKIP] node.js not found
) else (
    set "ENGINE=node"
    for /f "tokens=*" %%v in ('node -v 2^>nul') do echo        [OK] Node.js %%v
)
where python >nul 2>&1
if errorlevel 1 (
    echo        [SKIP] python not found
) else (
    if not defined ENGINE (
        set "ENGINE=python"
        for /f "tokens=*" %%v in ('python --version 2^>nul') do echo        [OK] %%v
    ) else (
        for /f "tokens=*" %%v in ('python --version 2^>nul') do echo        [OK] %%v (secondary)
    )
)
if not defined ENGINE (
    echo [FAIL] Neither Node.js nor Python found.
    echo        Install one of:
    echo        - Node.js 18+: https://nodejs.org/
    echo        - Python 3.8+: https://www.python.org/downloads/
    goto :done
)
echo.

echo [2/4] Checking OpenSSL...
set "OPENSSL_OK=0"
where openssl >nul 2>&1
if errorlevel 1 (
    if exist "%ProgramFiles%\Git\usr\bin\openssl.exe" (
        set "PATH=%ProgramFiles%\Git\usr\bin;%PATH%"
        set "OPENSSL_OK=1"
    ) else if exist "%ProgramFiles%\OpenSSL\bin\openssl.exe" (
        set "PATH=%ProgramFiles%\OpenSSL\bin;%PATH%"
        set "OPENSSL_OK=1"
    ) else if exist "%LOCALAPPDATA%\Programs\Git\usr\bin\openssl.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Git\usr\bin;%PATH%"
        set "OPENSSL_OK=1"
    )
) else (
    set "OPENSSL_OK=1"
)
if "!OPENSSL_OK!"=="0" (
    echo [WARN] OpenSSL not found. CA cert generation requires OpenSSL.
    echo        Install: https://slproweb.com/products/Win32OpenSSL.html
    if "!ENGINE!"=="python" (
        echo        Python+mitmproxy has its own CA, this is OK.
    ) else (
        echo        Node.js mode needs OpenSSL. Install it or switch to Python.
        goto :done
    )
) else (
    echo        [OK] OpenSSL found
)
if "!ENGINE!"=="python" (
    echo        Installing mitmproxy...
    pip install mitmproxy --quiet >nul 2>&1
    if errorlevel 1 (
        echo [FAIL] Failed to install mitmproxy.
        goto :done
    )
    echo        [OK] mitmproxy ready
)
echo.

echo [3/4] Getting local IP...
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|Hyper-V|Bluetooth|Virtual' } | Sort-Object InterfaceAlias | Select-Object -First 1 -ExpandProperty IPAddress" > "%TEMP%\wloc-ip.txt" 2>nul
for /f "usebackq delims=" %%i in ("%TEMP%\wloc-ip.txt") do set "LOCAL_IP=%%i"
if not defined LOCAL_IP set "LOCAL_IP=127.0.0.1"
echo        [OK] IP: %LOCAL_IP%
echo.

echo [4/4] Checking port %PORT%...
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo        [OK] Port %PORT% is available
) else (
    echo [FAIL] Port %PORT% is already in use.
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
        echo        Process: PID %%p
        tasklist /FI "PID eq %%p" /FO TABLE 2>nul | findstr /v "INFO:"
    )
    echo.
    echo        Kill it: taskkill /PID <PID> /F
    echo        Or use another port: start.bat 9090
    goto :done
 )
echo.
echo ========================================
echo   Proxy: %LOCAL_IP%:%PORT%
echo   Engine: %ENGINE%
echo ========================================
echo.
echo   iPhone Setup:
echo   1. Safari: http://%LOCAL_IP%:%PORT%/ca
echo   2. Settings ^> General ^> About ^> Certificate Trust Settings ^> Enable
echo   3. Wi-Fi ^> Configure Proxy ^> Manual ^> Server: %LOCAL_IP%, Port: %PORT%
echo   4. Open Maps app to verify
echo.
echo ========================================
echo.

if "%ENGINE%"=="python" (
    echo [RUN] mitmdump -s wloc_spoofer.py -p %PORT%
    echo.
    mitmdump -s "%SCRIPT_DIR%wloc_spoofer.py" -p %PORT%
    if errorlevel 1 (
        echo.
        echo [FAIL] mitmdump exited with error.
    )
) else (
    echo [RUN] node server.js %PORT%
    echo.
    node "%SCRIPT_DIR%server.js" %PORT%
    if errorlevel 1 (
        echo.
        echo [FAIL] server.js exited with error.
    )
)

:done
echo.
pause
endlocal
