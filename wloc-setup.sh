#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:$PATH
export LD_LIBRARY_PATH=$PREFIX/lib
LOG=/sdcard/Download/wloc-setup.log
WORKDIR=/sdcard/Download
touch $LOG 2>/dev/null || { LOG=$HOME/wloc-setup.log; WORKDIR=$HOME; touch $LOG 2>/dev/null; }

killall node 2>/dev/null
sleep 1

exec > $LOG 2>&1

echo '[WLOC] === WLOC Spoofer Setup ==='
echo '[WLOC] Checking dependencies...'

NEED_INSTALL=0
if ! command -v node > /dev/null 2>&1; then
    NEED_INSTALL=1
else
    echo '[WLOC] nodejs already installed'
fi

if ! command -v openssl > /dev/null 2>&1; then
    NEED_INSTALL=1
else
    echo '[WLOC] openssl already installed'
fi

if [ $NEED_INSTALL -eq 1 ]; then
    echo '[WLOC] Updating pkg and installing dependencies...'
    pkg update -y
    pkg install -y nodejs openssl-tool
    if ! command -v node > /dev/null 2>&1; then
        echo '[WLOC][FAIL] nodejs install failed'
        exit 1
    fi
    if ! command -v openssl > /dev/null 2>&1; then
        echo '[WLOC][FAIL] openssl-tool install failed'
        exit 1
    fi
    echo '[WLOC] Dependencies installed OK'
fi

NODE_VER=$(node --version 2>/dev/null)
OPENSSL_VER=$(openssl version 2>/dev/null)
echo "[WLOC] Node.js: $NODE_VER"
echo "[WLOC] OpenSSL: $OPENSSL_VER"

if [ ! -f $WORKDIR/server.js ]; then
    if [ -f /data/local/tmp/server.js ]; then
        echo '[WLOC] Copying server.js from /data/local/tmp/...'
        cp /data/local/tmp/server.js $WORKDIR/server.js
    else
        echo '[WLOC] Downloading server.js...'
        curl -sL -o $WORKDIR/server.js https://raw.githubusercontent.com/weskhen/wloc-spoofer/main/server.js
    fi
    if [ ! -f $WORKDIR/server.js ] || [ ! -s $WORKDIR/server.js ]; then
        echo '[WLOC][FAIL] server.js not available'
        exit 1
    fi
    echo '[WLOC] server.js ready'
fi

echo '[WLOC] Starting proxy on port PORT_PLACEHOLDER...'
echo '[WLOC] === Starting server ==='
cd $WORKDIR
OPENSSL_PATH=$PREFIX/bin/openssl
if [ ! -x "$OPENSSL_PATH" ]; then
    OPENSSL_PATH=$(command -v openssl 2>/dev/null)
fi
export OPENSSL_BIN=$OPENSSL_PATH
MY_PORT=PORT_PLACEHOLDER
while :; do
    if ss -tlnp 2>/dev/null | grep ":${MY_PORT}" | grep -q LISTEN; then
        echo "[WLOC] Port ${MY_PORT} in use, trying $((MY_PORT+1))..."
        MY_PORT=$((MY_PORT+1))
        continue
    fi
    node server.js $MY_PORT &
    NODE_PID=$!
    sleep 3
    if kill -0 $NODE_PID 2>/dev/null; then
        echo "[WLOC] Proxy started! PID=$NODE_PID"
        break
    else
        echo "[WLOC][FAIL] server.js crashed on startup"
        exit 1
    fi
done
