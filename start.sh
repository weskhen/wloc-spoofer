#!/usr/bin/env bash
set -e

PORT=${1:-8080}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================"
echo "  WLOC Spoofer - PC Proxy Server"
echo "========================================"
echo ""

echo "[1/4] Detecting runtime engine..."
ENGINE=""
if command -v node &>/dev/null; then
    ENGINE="node"
    echo "       [OK] Node.js $(node -v)"
else
    echo "       [SKIP] node not found"
fi
if command -v python3 &>/dev/null; then
    if [ -z "$ENGINE" ]; then
        ENGINE="python"
        echo "       [OK] $(python3 --version)"
    else
        echo "       [OK] $(python3 --version) (secondary)"
    fi
elif command -v python &>/dev/null; then
    if [ -z "$ENGINE" ]; then
        ENGINE="python"
        echo "       [OK] $(python --version)"
    else
        echo "       [OK] $(python --version) (secondary)"
    fi
else
    echo "       [SKIP] python not found"
fi
if [ -z "$ENGINE" ]; then
    echo "[FAIL] Neither Node.js nor Python found."
    echo "       Install one of:"
    echo "       - Node.js 18+: https://nodejs.org/"
    echo "       - Python 3.8+:  brew install python"
    exit 1
fi
echo ""

echo "[2/4] Checking OpenSSL..."
OPENSSL_OK=0
if command -v openssl &>/dev/null; then
    OPENSSL_OK=1
    echo "       [OK] OpenSSL found"
else
    echo "[WARN] OpenSSL not found."
    if [ "$ENGINE" = "python" ]; then
        echo "       Python+mitmproxy has its own CA, this is OK."
    else
        echo "       Install: brew install openssl"
        exit 1
    fi
fi
if [ "$ENGINE" = "python" ]; then
    echo "       Installing mitmproxy..."
    pip3 install mitmproxy --quiet 2>/dev/null || pip install mitmproxy --quiet 2>/dev/null
    echo "       [OK] mitmproxy ready"
fi
echo ""

echo "[3/4] Getting local IP..."
LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(ip addr show 2>/dev/null | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | cut -d/ -f1 | head -1)
fi
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP="127.0.0.1"
fi
echo "       [OK] IP: $LOCAL_IP"
echo ""

echo "[4/4] Checking port $PORT..."
if lsof -i :$PORT &>/dev/null; then
    PID=$(lsof -ti :$PORT)
    echo "[FAIL] Port $PORT is already in use."
    echo "       Process: PID $PID $(ps -p $PID -o comm= 2>/dev/null)"
    echo "       Kill it: kill $PID"
    echo "       Or use another port: ./start.sh 9090"
    exit 1
else
    echo "       [OK] Port $PORT is available"
fi
echo ""

echo "========================================"
echo "  Proxy: $LOCAL_IP:$PORT"
echo "  Engine: $ENGINE"
echo "========================================"
echo ""
echo "  iPhone Setup:"
echo "  1. Safari: http://$LOCAL_IP:$PORT/ca"
echo "  2. Settings > General > About > Certificate Trust Settings > Enable"
echo "  3. Wi-Fi > Configure Proxy > Manual > Server: $LOCAL_IP, Port: $PORT"
echo "  4. Open Maps app to verify"
echo ""
echo "========================================"
echo ""

if [ "$ENGINE" = "python" ]; then
    echo "[RUN] mitmdump -s wloc_spoofer.py -p $PORT"
    echo ""
    mitmdump -s "$SCRIPT_DIR/wloc_spoofer.py" -p $PORT
else
    echo "[RUN] node server.js $PORT"
    echo ""
    node "$SCRIPT_DIR/server.js" $PORT
fi
