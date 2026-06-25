#!/usr/bin/env bash
set -e

PORT=${1:-8080}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TERMUX_APK="$SCRIPT_DIR/termux.apk"

echo "========================================"
echo "  WLOC Spoofer - ADB Auto Deploy"
echo "========================================"
echo ""

echo "[1/7] Checking ADB connection..."
DEVICE_LINE=$(adb devices 2>/dev/null | grep "device" | grep -v -e "unauthorized" -e "recovery" -e "offline" | head -1)
if [ -z "$DEVICE_LINE" ]; then
    echo "[FAIL] No Android device connected."
    echo "       1. Connect phone via USB"
    echo "       2. Enable USB debugging (Settings > Developer options)"
    echo "       3. Accept RSA key prompt on phone"
    echo "       4. Verify: adb devices"
    exit 1
fi
echo "[PASS] Device connected: $DEVICE_LINE"
echo ""

echo "[2/7] Checking Termux installation..."
if adb shell pm list packages 2>/dev/null | grep -q "com.termux"; then
    echo "[PASS] Termux already installed"
else
    echo "       Termux not installed. Installing..."
    if [ ! -f "$TERMUX_APK" ]; then
        echo "       Downloading Termux APK..."
        curl -sL -o "$TERMUX_APK" \
            "https://github.com/termux/termux-app/releases/latest/download/termux-app_v0.119.0_aarch64.apk" || \
        curl -sL -o "$TERMUX_APK" \
            "https://github.com/termux/termux-app/releases/latest/download/termux-app_v0.119.0_arm64-v8a.apk" || {
            echo "[FAIL] Cannot download Termux APK."
            echo "       Download manually: https://github.com/termux/termux-app/releases"
            exit 1
        }
    fi
    adb install -r "$TERMUX_APK"
    if [ $? -ne 0 ]; then
        echo "[FAIL] Termux install failed. Try: adb uninstall com.termux then re-run."
        exit 1
    fi
    echo "[PASS] Termux installed"
fi
echo ""

echo "[3/7] Pushing server.js to phone..."
if [ -f "$SCRIPT_DIR/server.js" ]; then
    adb push "$SCRIPT_DIR/server.js" /sdcard/Download/server.js
    if [ $? -ne 0 ]; then
        echo "[FAIL] Cannot push server.js to phone"
        exit 1
    fi
    echo "[PASS] server.js pushed to /sdcard/Download/server.js"
else
    echo "[WARN] server.js not found locally, will download on device"
fi
echo ""

echo "[4/7] Creating setup script on phone..."
SETUP_SH="$SCRIPT_DIR/wloc-setup.sh"
if [ ! -f "$SETUP_SH" ]; then
    echo "[FAIL] wloc-setup.sh not found next to this script"
    exit 1
fi
sed "s/PORT_PLACEHOLDER/${PORT}/g" "$SETUP_SH" > /tmp/wloc-setup.sh
adb push /tmp/wloc-setup.sh /sdcard/Download/wloc-setup.sh
if [ $? -ne 0 ]; then
    echo "[FAIL] Cannot push setup script"
    exit 1
fi
echo "[PASS] Setup script pushed"
echo ""

echo "[5/7] Running setup via Termux..."
if ! adb shell pidof com.termux >/dev/null 2>&1; then
    echo "       Termux is not running. Starting..."
    adb shell am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1
    echo ""
    echo "       Please wait for Termux to fully load on your phone."
    echo "       When you see the \"~ \$\" prompt, come back here and press Enter."
    read -r
    sleep 2
fi
adb shell am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1
sleep 3
adb shell input text 'sh /sdcard/Download/wloc-setup.sh'
sleep 1
adb shell input keyevent 66
echo "       Command sent to Termux."
echo ""

echo "[6/7] Monitoring setup progress..."
echo "       Waiting for setup to start (20s)..."
sleep 20
LOG_FILE="/sdcard/Download/wloc-setup.log"
LOG_LINES=$(adb shell cat $LOG_FILE 2>/dev/null | wc -l)
if [ -z "$LOG_LINES" ] || [ "$LOG_LINES" -eq 0 ]; then
    echo "       [WARN] No log yet. First-time install can take 60s+."
    echo "       Waiting 45s more..."
    sleep 45
    LOG_LINES=$(adb shell cat $LOG_FILE 2>/dev/null | wc -l)
fi
if [ -n "$LOG_LINES" ] && [ "$LOG_LINES" -gt 0 ]; then
    echo "       --- Setup Log ---"
    adb shell cat $LOG_FILE 2>/dev/null
    echo "       --- End Log ---"
else
    echo "       [WARN] Still no log. Run manually on phone:"
    echo "       sh /sdcard/Download/wloc-setup.sh"
fi
echo ""

echo "[7/7] Verifying proxy..."
echo "       Waiting for server output (5s)..."
sleep 5
adb shell cat $LOG_FILE > /tmp/wloc-phone.log 2>/dev/null
PROXY_IP=$(grep "Proxy address:" /tmp/wloc-phone.log 2>/dev/null | head -1 | sed 's/.*Proxy address: //' | cut -d: -f1)
if [ -n "$PROXY_IP" ]; then
    echo "[PASS] Proxy started successfully!"
    echo "       Address: ${PROXY_IP}:${PORT}"
else
    echo "[INFO] Proxy may still be starting."
    echo "       Monitor: adb shell cat $LOG_FILE"
fi
echo ""

echo "========================================"
echo "  Deploy complete!"
echo "========================================"
echo ""
echo "  Next steps on iPhone:"
echo "  1. Connect to Android hotspot"
echo "  2. Safari: http://${PROXY_IP:-<PHONE_IP>}:${PORT}/ca"
echo "  3. Settings > General > About > Certificate Trust Settings > Enable"
echo "  4. Wi-Fi > Configure Proxy > Manual > Server: ${PROXY_IP:-<PHONE_IP>}, Port: ${PORT}"
echo "  5. Open Maps app to verify"
echo ""
echo "  Useful commands:"
echo "    View Termux: adb shell am start -n com.termux/.app.TermuxActivity"
echo "    Stop proxy:  adb shell am force-stop com.termux"
echo "========================================"
