@echo off
setlocal

set PORT=%1
if "%PORT%"=="" set PORT=8080
set "SCRIPT_DIR=%~dp0"
set "TERMUX_PKG=com.termux"

echo ========================================
echo   WLOC Spoofer - ADB Auto Deploy
echo ========================================
echo.

echo [1/7] Checking ADB connection...
where adb.exe >nul 2>&1
if errorlevel 1 (
    echo        ADB not in PATH, searching...
    set "ADB_FOUND="
    powershell -NoProfile -Command "(Get-Command adb.exe -ErrorAction SilentlyContinue).Source" > "%TEMP%\adb-path.txt" 2>nul
    for /f "usebackq delims=" %%a in ("%TEMP%\adb-path.txt") do set "ADB_FOUND=%%~dpa"
    del "%TEMP%\adb-path.txt" >nul 2>&1
    if not defined ADB_FOUND (
        if defined ANDROID_HOME if exist "%ANDROID_HOME%\platform-tools\adb.exe" set "ADB_FOUND=%ANDROID_HOME%\platform-tools\"
    )
    if not defined ADB_FOUND (
        if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platform-tools\adb.exe" set "ADB_FOUND=%ANDROID_SDK_ROOT%\platform-tools\"
    )
    if defined ADB_FOUND (
        set "PATH=%ADB_FOUND%;%PATH%"
        echo        Found: %ADB_FOUND%adb.exe
    ) else (
        echo [FAIL] ADB not found. Please add ADB to system PATH.
        echo        Download: https://developer.android.com/studio/releases/platform-tools
        exit /b 1
    )
)
echo        ADB found OK
adb devices 2>nul | findstr /c:"device" | findstr /v /c:"List" /c:"unauthorized" /c:"recovery" /c:"offline" > "%TEMP%\adb-device.txt"
for /f "usebackq delims=" %%i in ("%TEMP%\adb-device.txt") do (
    echo [PASS] Device connected: %%i
    goto :device_ok
)
echo [FAIL] No Android device connected.
echo        1. Connect phone via USB
echo        2. Enable USB debugging (Settings ^> Developer options)
echo        3. Accept RSA key prompt on phone
echo        4. Verify: adb devices
del "%TEMP%\adb-device.txt" >nul 2>&1
exit /b 1
:device_ok
del "%TEMP%\adb-device.txt" >nul 2>&1
echo.

echo [2/7] Checking Termux installation...
adb shell pm list packages 2>nul | findstr /c:"com.termux" >nul
if errorlevel 1 (
    echo        Termux not installed. Installing...
    if not exist "%SCRIPT_DIR%termux.apk" (
        echo        Downloading Termux APK...
        curl -sL -o "%SCRIPT_DIR%termux.apk" https://github.com/termux/termux-app/releases/latest/download/termux-app_v0.119.0_aarch64.apk
        if errorlevel 1 (
            curl -sL -o "%SCRIPT_DIR%termux.apk" https://github.com/termux/termux-app/releases/latest/download/termux-app_v0.119.0_arm64-v8a.apk
        )
        if errorlevel 1 (
            echo [FAIL] Cannot download Termux APK.
            echo        Download manually: https://github.com/termux/termux-app/releases
            exit /b 1
        )
    )
    adb install -r "%SCRIPT_DIR%termux.apk"
    if errorlevel 1 (
        echo [FAIL] Termux install failed. Try: adb uninstall com.termux then re-run.
        exit /b 1
    )
    echo [PASS] Termux installed
) else (
    echo [PASS] Termux already installed
)
echo.

echo [3/7] Pushing server.js to phone...
if exist "%SCRIPT_DIR%server.js" (
    adb push "%SCRIPT_DIR%server.js" /sdcard/Download/server.js
    if errorlevel 1 (
        echo [FAIL] Cannot push server.js to phone
        exit /b 1
    )
    echo [PASS] server.js pushed to /sdcard/Download/server.js
) else (
    echo [WARN] server.js not found locally, will download on device
)
echo.

echo [4/7] Creating setup script on phone...
set "SETUP_SH=%SCRIPT_DIR%wloc-setup.sh"
if not exist "%SETUP_SH%" (
    echo [FAIL] wloc-setup.sh not found next to this script
    exit /b 1
)
powershell -NoProfile -Command "$c = Get-Content '%SETUP_SH%' -Raw; $c = $c -replace 'PORT_PLACEHOLDER','%PORT%'; [System.IO.File]::WriteAllText('%TEMP%\wloc-setup.sh', $c, [System.Text.UTF8Encoding]::new($false))"
adb push "%TEMP%\wloc-setup.sh" /sdcard/Download/wloc-setup.sh
if errorlevel 1 (
    echo [FAIL] Cannot push setup script
    exit /b 1
)
echo [PASS] Setup script pushed
echo.

echo [5/7] Running setup via Termux...
adb shell pidof com.termux >nul 2>&1
if errorlevel 1 (
    echo        Termux is not running. Starting...
    adb shell am start -n com.termux/.app.TermuxActivity >nul 2>&1
    echo.
    echo        Please wait for Termux to fully load on your phone.
    echo        When you see the "~ $" prompt, come back here and press any key.
    pause >nul
    timeout /t 2 /nobreak >nul
)
adb shell am start -n com.termux/.app.TermuxActivity >nul 2>&1
timeout /t 3 /nobreak >nul
adb shell input text 'sh /sdcard/Download/wloc-setup.sh'
timeout /t 1 /nobreak >nul
adb shell input keyevent 66
echo        Command sent to Termux.
echo.

echo [6/7] Monitoring setup progress...
echo        Waiting for setup to start (20s)...
timeout /t 20 /nobreak >nul
set "LOG_LINES="
adb shell cat /sdcard/Download/wloc-setup.log > "%TEMP%\wloc-phone.log" 2>nul
for /f "tokens=*" %%a in ("%TEMP%\wloc-phone.log") do set "LOG_LINES=FOUND"
if not defined LOG_LINES (
    echo        [WARN] No log yet. First-time install can take 60s+.
    echo        Waiting 45s more...
    timeout /t 45 /nobreak >nul
    adb shell cat /sdcard/Download/wloc-setup.log > "%TEMP%\wloc-phone.log" 2>nul
    for /f "tokens=*" %%a in ("%TEMP%\wloc-phone.log") do set "LOG_LINES=FOUND"
)
if defined LOG_LINES (
    echo        --- Setup Log ---
    type "%TEMP%\wloc-phone.log"
    echo        --- End Log ---
) else (
    echo        [WARN] Still no log. Run manually on phone:
    echo        sh /sdcard/Download/wloc-setup.sh
)
echo.

echo [7/7] Verifying proxy...
echo        Waiting for server output (5s)...
timeout /t 5 /nobreak >nul
adb shell cat /sdcard/Download/wloc-setup.log > "%TEMP%\wloc-phone.log" 2>nul
set "PROXY_IP="
for /f "usebackq tokens=3 delims=: " %%a in ("%TEMP%\wloc-phone.log") do (
    echo %%a | findstr /r "^[0-9]" >nul 2>&1
    if not errorlevel 1 set "PROXY_IP=%%a"
)
if defined PROXY_IP (
    echo [PASS] Proxy started successfully!
    echo        Address: %PROXY_IP%:%PORT%
) else (
    echo [INFO] Proxy may still be starting.
    echo        Monitor: adb shell cat /sdcard/Download/wloc-setup.log
)
echo.

echo ========================================
echo   Deploy complete!
echo ========================================
echo.
echo   Next steps on iPhone:
echo   1. Connect to Android hotspot
echo   2. Safari: http://%PROXY_IP%:%PORT%/ca
echo   3. Settings ^> General ^> About ^> Certificate Trust Settings ^> Enable
echo   4. Wi-Fi ^> Configure Proxy ^> Manual ^> Server: %PROXY_IP%, Port: %PORT%
echo   5. Open Maps app to verify
echo.
echo   Useful commands:
echo     View Termux: adb shell am start -n com.termux/.app.TermuxActivity
echo     Stop proxy:  adb shell am force-stop com.termux
echo     Restart:     adb shell am broadcast --user 0 -n com.termux/.app.RunCommandService -a com.termux.RUN_COMMAND --es com.termux.RUN_COMMAND_PATH '/data/data/com.termux/files/home' --esa com.termux.RUN_COMMAND_ARGUMENTS 'sh,/sdcard/Download/wloc-setup.sh' --ez com.termux.RUN_COMMAND_BACKGROUND true
echo ========================================

endlocal
