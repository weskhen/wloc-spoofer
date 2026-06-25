/**
 * WLOC Spoofer - Standalone HTTPS Proxy Server (Node.js, zero dependencies)
 *
 * Usage:
 *   node server.js [port]
 *
 * Default port: 8080
 * iPhone setup:
 *   1. Run this server
 *   2. iPhone Wi-Fi > Configure Proxy > Manual > Server: <your-pc-ip>, Port: 8080
 *   3. iPhone Safari visit http://<your-pc-ip>:8080/ca  -> install CA cert
 *   4. Settings > General > About > Certificate Trust Settings > Enable WLOC Spoofer CA
 *   5. Trigger location on iPhone
 */

const http = require("http");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");

process.on("uncaughtException", function(err) {
  console.error("[FATAL] " + (err && err.message || err));
  console.error(err && err.stack);
});
const path = require("path");
const { URL } = require("url");
const { execSync } = require("child_process");

function findOpenSSL() {
  const candidates = [
    process.env.OPENSSL_BIN,
    "openssl",
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "openssl.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSL", "bin", "openssl.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "usr", "bin", "openssl.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { execSync(`"${c}" version`, { stdio: "pipe" }); return c; } catch (_) {}
  }
  return null;
}

const OPENSSL = findOpenSSL();

const PORT = parseInt(process.argv[2] || "8080", 10);

const config = {
  longitude: 120.73,
  latitude: 28.85,
  accuracy: 30,
};

const WLOC_HOSTS = new Set(["gs-loc-cn.apple.com", "gs-loc.apple.com"]);
const WLOC_PATH = "/clls/wloc";

// ---- CA Certificate Management ----

const BASE_DIR = (__dirname === "/" || !__dirname)
  ? path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), ".wloc-spoofer")
  : __dirname;
const CA_DIR = path.join(BASE_DIR, "ca");
const CA_KEY_PATH = path.join(CA_DIR, "ca-key.pem");
const CA_CERT_PATH = path.join(CA_DIR, "ca-cert.pem");

function ensureCA() {
  if (!fs.existsSync(CA_DIR)) fs.mkdirSync(CA_DIR, { recursive: true });

  if (!fs.existsSync(CA_KEY_PATH) || !fs.existsSync(CA_CERT_PATH)) {
    if (!OPENSSL) {
      console.error("[ERROR] OpenSSL not found. Please install OpenSSL or Git for Windows.");
      console.error("        Download: https://slproweb.com/products/Win32OpenSSL.html");
      console.error("        Or install Git: https://git-scm.com/download/win");
      console.error("        Alternatively, use the Python mitmproxy method: pip install mitmproxy");
      process.exit(1);
    }
    console.log("[CA] Generating self-signed CA certificate...");
    const key = CA_KEY_PATH.replace(/\\/g, "/");
    const cert = CA_CERT_PATH.replace(/\\/g, "/");
    const caExt = path.join(CA_DIR, "ca-ext.cnf");
    fs.writeFileSync(caExt, [
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier=hash",
    ].join("\n") + "\n");
    const caExtPath = caExt.replace(/\\/g, "/");
    const csrPath = path.join(CA_DIR, "ca.csr");
    const csrFile = csrPath.replace(/\\/g, "/");
    const subj = "/CN=WLOC Spoofer CA/O=WLOC Spoofer";
    execSync(
      `"${OPENSSL}" req -new -newkey rsa:2048 -nodes -keyout "${key}" -out "${csrFile}" -subj "${subj}"`,
      { stdio: "pipe" }
    );
    execSync(
      `"${OPENSSL}" x509 -req -in "${csrFile}" -signkey "${key}" -out "${cert}" -days 3650 -extfile "${caExtPath}"`,
      { stdio: "pipe" }
    );
    try { fs.unlinkSync(csrPath); } catch (_) {}
    console.log("[CA] CA certificate generated at:", CA_CERT_PATH);
  }

  return {
    key: fs.readFileSync(CA_KEY_PATH),
    cert: fs.readFileSync(CA_CERT_PATH),
  };
}

function getCertForHost(ca, hostname) {
  const certPath = path.join(CA_DIR, `${hostname}.pem`);
  const keyPath = path.join(CA_DIR, `${hostname}-key.pem`);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  const { execSync } = require("child_process");
  const csrPath = path.join(CA_DIR, `${hostname}.csr`);
  const keyFile = keyPath.replace(/\\/g, "/");
  const certFile = certPath.replace(/\\/g, "/");
  const csrFile = csrPath.replace(/\\/g, "/");
  const caKey = CA_KEY_PATH.replace(/\\/g, "/");
  const caCert = CA_CERT_PATH.replace(/\\/g, "/");

  const extFile = path.join(CA_DIR, `${hostname}.ext`);
  fs.writeFileSync(extFile, `subjectAltName=DNS:${hostname}\n`);
  const extPath = extFile.replace(/\\/g, "/");

  execSync(
    `"${OPENSSL}" req -new -newkey rsa:2048 -nodes -keyout "${keyFile}" -out "${csrFile}" -subj "/CN=${hostname}"`,
    { stdio: "pipe" }
  );
  execSync(
    `"${OPENSSL}" x509 -req -in "${csrFile}" -CA "${caCert}" -CAkey "${caKey}" -CAcreateserial -out "${certFile}" -days 825 -sha256 -extfile "${extPath}"`,
    { stdio: "pipe" }
  );

  try { fs.unlinkSync(csrPath); } catch (_) {}

  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

// ---- Protobuf helpers ----

function readVarint(buf, offset) {
  let value = 0, mul = 1;
  while (offset < buf.length) {
    const b = buf[offset++];
    value += (b & 0x7F) * mul;
    if ((b & 0x80) === 0) return [value, offset];
    mul *= 128;
  }
  throw new Error("truncated varint");
}

function writeVarint(value) {
  const out = [];
  let v = Math.floor(value);
  while (v >= 128) { out.push((v & 0x7F) | 0x80); v = Math.floor(v / 128); }
  out.push(v & 0x7F);
  return Buffer.from(out);
}

function parseFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    const [tag, newOff] = readVarint(buf, offset);
    offset = newOff;
    const fieldNo = tag >> 3;
    const wireType = tag & 7;
    const valueStart = offset;
    let value;
    if (wireType === 0) {
      [value, offset] = readVarint(buf, offset);
    } else if (wireType === 1) {
      offset += 8;
      value = buf.slice(valueStart, offset);
    } else if (wireType === 2) {
      const [len, lenOff] = readVarint(buf, offset);
      offset = lenOff + len;
      value = buf.slice(lenOff, offset);
    } else if (wireType === 5) {
      offset += 4;
      value = buf.slice(valueStart, offset);
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
    fields.push({ fieldNo, wireType, value, raw: buf.slice(start, offset) });
  }
  return fields;
}

function encodeField(fieldNo, wireType, value) {
  const tag = writeVarint(fieldNo * 8 + wireType);
  if (wireType === 0) return Buffer.concat([tag, writeVarint(value)]);
  if (wireType === 1 || wireType === 5) return Buffer.concat([tag, Buffer.from(value)]);
  if (wireType === 2) return Buffer.concat([tag, writeVarint(value.length), Buffer.from(value)]);
  throw new Error(`cannot encode wire type ${wireType}`);
}

function patchLocation(buf) {
  const fields = parseFields(buf);
  const hasLat = fields.some(f => f.fieldNo === 1 && f.wireType === 0);
  const hasLon = fields.some(f => f.fieldNo === 2 && f.wireType === 0);
  if (!hasLat || !hasLon) return buf;
  const parts = [];
  for (const f of fields) {
    if (f.fieldNo === 1 && f.wireType === 0) {
      parts.push(encodeField(1, 0, Math.round(config.latitude * 1e8)));
    } else if (f.fieldNo === 2 && f.wireType === 0) {
      parts.push(encodeField(2, 0, Math.round(config.longitude * 1e8)));
    } else if (f.fieldNo === 3 && f.wireType === 0) {
      parts.push(encodeField(3, 0, config.accuracy));
    } else {
      parts.push(f.raw);
    }
  }
  return Buffer.concat(parts);
}

function patchWifiDevice(buf) {
  const fields = parseFields(buf);
  let isWifi = false;
  for (const f of fields) {
    if (f.fieldNo === 1 && f.wireType === 2) {
      try {
        const s = f.value.toString("ascii");
        isWifi = /^([0-9a-fA-F]{1,2}:){5}[0-9a-fA-F]{1,2}$/.test(s);
      } catch (_) {}
    }
  }
  if (!isWifi) return buf;
  const parts = [];
  for (const f of fields) {
    if (f.fieldNo === 2 && f.wireType === 2) {
      try { parts.push(encodeField(f.fieldNo, f.wireType, patchLocation(f.value))); }
      catch (_) { parts.push(f.raw); }
    } else {
      parts.push(f.raw);
    }
  }
  return Buffer.concat(parts);
}

function patchCellTower(buf) {
  const fields = parseFields(buf);
  const parts = [];
  for (const f of fields) {
    if (f.fieldNo === 5 && f.wireType === 2) {
      try { parts.push(encodeField(f.fieldNo, f.wireType, patchLocation(f.value))); }
      catch (_) { parts.push(f.raw); }
    } else {
      parts.push(f.raw);
    }
  }
  return Buffer.concat(parts);
}

function patchPayload(buf) {
  const fields = parseFields(buf);
  const parts = [];
  for (const f of fields) {
    if (f.wireType === 2 && f.fieldNo === 2) {
      parts.push(encodeField(f.fieldNo, f.wireType, patchWifiDevice(f.value)));
    } else if (f.wireType === 2 && (f.fieldNo === 22 || f.fieldNo === 24)) {
      parts.push(encodeField(f.fieldNo, f.wireType, patchCellTower(f.value)));
    } else {
      parts.push(f.raw);
    }
  }
  return Buffer.concat(parts);
}

function patchFrame(body) {
  if (body.length < 10) throw new Error(`body too short: ${body.length}`);
  const payloadLen = (body[8] << 8) | body[9];
  if (payloadLen + 10 > body.length) throw new Error("invalid frame length");
  const patched = patchPayload(body.slice(10, 10 + payloadLen));
  if (patched.length > 65535) throw new Error("payload too large");
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(patched.length);
  return Buffer.concat([body.slice(0, 8), lenBuf, patched, body.slice(10 + payloadLen)]);
}

function maybeGunzip(buf) {
  if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) {
    return require("zlib").gunzipSync(buf);
  }
  return buf;
}

function isWlocRequest(host, reqPath) {
  return WLOC_HOSTS.has(host.toLowerCase()) && reqPath.split("?")[0] === WLOC_PATH;
}

// ---- Proxy Server ----

const ca = ensureCA();

// ---- Runtime state tracking ----
const localIPs = Object.values(require("os").networkInterfaces()).flatMap(addrs =>
  addrs.filter(a => a.family === "IPv4" && !a.internal).map(a => a.address)
);

const runtime = {
  startTime: Date.now(),
  connectCount: 0,
  wlocInterceptCount: 0,
  wlocPatchCount: 0,
  wlocErrorCount: 0,
  lastWlocTime: null,
  lastWlocStatus: null,
  lastWlocTarget: null,
  logs: [],
};
function addLog(msg) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  runtime.logs.push({ time: t, msg });
  if (runtime.logs.length > 50) runtime.logs.shift();
  console.log(`[${t}] ${msg}`);
}

const server = http.createServer((req, res) => {
  // When iPhone uses HTTP proxy, req.url contains full URL like "http://172.27.78.54:8080/"
  // Parse it to extract path
  var reqPath = req.url;
  var reqHost = (req.headers.host || "").split(":")[0].toLowerCase();
  if (reqPath.startsWith("http://") || reqPath.startsWith("https://")) {
    try {
      var parsed = new URL(reqPath);
      reqPath = parsed.pathname;
      reqHost = parsed.hostname.toLowerCase();
    } catch (_) {}
  }

  // Landing page with CA download + setup guide + status detection
  if (reqPath === "/ca" || reqPath === "/" || reqPath === "/index.html") {
    const host = req.headers.host || `172.27.78.54:${PORT}`;
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>WLOC Spoofer - CA 证书安装</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;background:#f2f2f7;color:#1c1c1e;line-height:1.6;-webkit-font-smoothing:antialiased}
.container{max-width:480px;margin:0 auto;padding:20px 16px 40px}
.card{background:#fff;border-radius:16px;padding:24px 20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:22px;font-weight:700;text-align:center;margin-bottom:4px}
.sub{text-align:center;color:#8e8e93;font-size:14px;margin-bottom:20px}
.step{display:flex;gap:14px;margin-bottom:20px;align-items:flex-start}
.num{flex-shrink:0;width:28px;height:28px;border-radius:50%;background:#007aff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600}
.num.done{background:#34c759}
.num.pending{background:#8e8e93}
.step-content{flex:1}
.step-title{font-size:16px;font-weight:600;margin-bottom:4px}
.step-desc{font-size:14px;color:#636366}
.code{background:#f2f2f7;border-radius:8px;padding:10px 14px;font-family:"SF Mono",Menlo,monospace;font-size:13px;margin:6px 0;word-break:break-all;color:#1c1c1e}
.btn{display:block;width:100%;padding:14px;border-radius:12px;text-align:center;font-size:16px;font-weight:600;text-decoration:none;cursor:pointer;border:none;margin:8px 0}
.btn-primary{background:#007aff;color:#fff}
.btn-primary:active{background:#0056b3}
.btn-secondary{background:#e5e5ea;color:#1c1c1e}
.warn{background:#fff3cd;border-left:4px solid #ffc107;border-radius:8px;padding:12px 16px;font-size:13px;color:#856404;margin:12px 0}
.tip{background:#e8f5e9;border-left:4px solid #4caf50;border-radius:8px;padding:12px 16px;font-size:13px;color:#2e7d32;margin:12px 0}
.info{background:#e3f2fd;border-left:4px solid #2196f3;border-radius:8px;padding:12px 16px;font-size:13px;color:#1565c0;margin:12px 0}
.footer{text-align:center;color:#8e8e93;font-size:12px;margin-top:24px}
.divider{height:1px;background:#e5e5ea;margin:16px 0}
.log-box{background:#1c1c1e;border-radius:10px;padding:12px 14px;max-height:200px;overflow-y:auto;font-family:"SF Mono",Menlo,monospace;font-size:12px;color:#34c759;margin:8px 0;line-height:1.8}
.log-box .error{color:#ff453a}
.log-box .warn{color:#ffd60a}
.log-box .info{color:#0a84ff}
.log-box .time{color:#8e8e93}
.log-line{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600}
.badge-ok{background:#e8f5e9;color:#2e7d32}
.badge-no{background:#ffebee;color:#c62828}
.badge-wait{background:#fff3cd;color:#856404}
.status-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f2f2f7}
.status-row:last-child{border-bottom:none}
.status-label{font-size:14px;color:#636366}
.status-val{font-size:14px;font-weight:600}
.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;animation:pulse 2s infinite}
.pulse-green{background:#34c759}
.pulse-gray{background:#8e8e93}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
small{font-size:12px;color:#8e8e93}
</style>
</head>
<body>
<div class="container">

<div class="card">
<h1>WLOC Spoofer</h1>
<p class="sub">iOS 免越狱定位修改 - 自建代理服务器</p>
</div>

<div class="card">
<div class="step-title" style="margin-bottom:12px">连接状态检测</div>
<div id="status-area">
<div class="status-row"><span class="status-label">服务器</span><span class="status-val"><span class="pulse pulse-green"></span>在线</span></div>
<div class="status-row"><span class="status-label">CA 证书</span><span class="status-val" id="s-ca"><span class="badge badge-wait">检测中...</span></span></div>
<div class="status-row"><span class="status-label">Wi-Fi 代理</span><span class="status-val" id="s-proxy"><span class="badge badge-wait">检测中...</span></span></div>
<div class="status-row"><span class="status-label">WLOC 拦截</span><span class="status-val" id="s-wloc"><span class="badge badge-wait">等待中</span></span></div>
</div>
<div class="info" id="detect-hint">正在检测你的 iPhone 连接状态，请稍候...</div>
</div>

<div class="card">
<div class="step">
<div class="num pending" id="n1">1</div>
<div class="step-content">
<div class="step-title">下载 CA 证书</div>
<div class="step-desc">点击下方按钮下载证书描述文件，iOS 会提示已下载。</div>
<a class="btn btn-primary" href="/download-ca">下载 CA 证书</a>
</div>
</div>

<div class="step">
<div class="num pending" id="n2">2</div>
<div class="step-content">
<div class="step-title">安装描述文件</div>
<div class="step-desc">打开 iPhone <b>设置</b>，顶部会出现"已下载描述文件"，点击进入安装。</div>
</div>
</div>

<div class="step">
<div class="num pending" id="n3">3</div>
<div class="step-content">
<div class="step-title">信任 CA 证书</div>
<div class="step-desc">这一步非常重要，不信任则无法生效。</div>
<div class="code">设置 > 通用 > 关于本机 > 证书信任设置<br>开启 "WLOC Spoofer CA" 的完全信任</div>
</div>
</div>

<div class="step">
<div class="num pending" id="n4">4</div>
<div class="step-content">
<div class="step-title">配置 Wi-Fi 代理</div>
<div class="step-desc">将 HTTP 代理指向本服务器。</div>
<div class="code">设置 > Wi-Fi > 点击已连接 Wi-Fi 的 (i)<br>滚动到底部 > 配置代理 > 手动<br>服务器: ${host}<br>端口: ${PORT}</div>
</div>
</div>

<div class="step">
<div class="num pending" id="n5">5</div>
<div class="step-content">
<div class="step-title">触发定位</div>
<div class="step-desc">打开地图 App 或关闭再开启定位权限，等待系统获取新位置。</div>
<div class="tip">室内测试效果最佳。GPS 信号强时 iOS 优先使用真实 GPS，WLOC 篡改可能无效。</div>
</div>
</div>
</div>

<div class="card">
<div class="step-title" style="margin-bottom:8px">修改目标坐标</div>
<div id="coord-form" style="display:flex;flex-direction:column;gap:8px">
<div style="display:flex;gap:8px;align-items:center">
<label style="flex:0 0 50px;font-size:14px;color:#636366">经度</label>
<input id="inp-lng" type="number" step="any" value="${config.longitude}" style="flex:1;padding:10px 12px;border:1px solid #e5e5ea;border-radius:10px;font-size:15px;background:#f2f2f7;outline:none">
</div>
<div style="display:flex;gap:8px;align-items:center">
<label style="flex:0 0 50px;font-size:14px;color:#636366">纬度</label>
<input id="inp-lat" type="number" step="any" value="${config.latitude}" style="flex:1;padding:10px 12px;border:1px solid #e5e5ea;border-radius:10px;font-size:15px;background:#f2f2f7;outline:none">
</div>
<div style="display:flex;gap:8px;align-items:center">
<label style="flex:0 0 50px;font-size:14px;color:#636366">精度</label>
<input id="inp-acc" type="number" min="1" value="${config.accuracy}" style="flex:1;padding:10px 12px;border:1px solid #e5e5ea;border-radius:10px;font-size:15px;background:#f2f2f7;outline:none">
<span style="font-size:13px;color:#8e8e93">米</span>
</div>
<button id="btn-save" class="btn btn-primary" onclick="saveCoord()" style="margin-top:4px">保存并生效</button>
<div id="coord-status" style="text-align:center;font-size:13px;color:#34c759;min-height:20px"></div>
</div>
</div>

<div class="card">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
<div class="step-title">运行日志</div>
<div style="display:flex;gap:6px">
<button id="btn-copy-log" onclick="copyLogs()" style="font-size:12px;padding:4px 12px;border:1px solid #e5e5ea;border-radius:8px;background:#fff;color:#636366;cursor:pointer">复制</button>
<button id="btn-clear-log" onclick="clearLogs()" style="font-size:12px;padding:4px 12px;border:1px solid #e5e5ea;border-radius:8px;background:#fff;color:#636366;cursor:pointer">清除</button>
</div>
</div>
<div class="log-box" id="logbox"><div class="log-line"><span class="time">[--:--:--]</span> 等待代理连接...</div></div>
</div>

<div class="card">
<div class="warn">测试完成后请清理：<br>1. 关闭 Wi-Fi 代理<br>2. 删除 CA 描述文件（设置 > 通用 > VPN与设备管理）</div>
<div class="tip">本工具仅用于授权测试。请遵守当地法律法规。</div>
</div>

<div class="footer">WLOC Spoofer v1.0 | MITM Response Rewriter</div>

</div>
<script>
(function(){
  var logEl = document.getElementById("logbox");
  var sCa = document.getElementById("s-ca");
  var sProxy = document.getElementById("s-proxy");
  var sWloc = document.getElementById("s-wloc");
  var hint = document.getElementById("detect-hint");
  var knownLogs = "";

  function badge(cls, text) {
    return '<span class="badge ' + cls + '">' + text + '</span>';
  }

  function clearLogs() {
    fetch("/api/clear", { method: "POST" }).catch(function(){});
    knownLogs = "";
    logEl.innerHTML = '<div class="log-line"><span class="time">[' + new Date().toLocaleTimeString("zh-CN",{hour12:false}) + ']</span> <span class="info">日志已清除</span></div>';
  }

  function copyLogs() {
    var text = logEl.innerText || logEl.textContent || "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){
        var btn = document.getElementById("btn-copy-log");
        btn.textContent = "已复制";
        setTimeout(function(){ btn.textContent = "复制"; }, 1500);
      });
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      var btn = document.getElementById("btn-copy-log");
      btn.textContent = "已复制";
      setTimeout(function(){ btn.textContent = "复制"; }, 1500);
    }
  }

  // Save coordinates
  function saveCoord() {
    var lng = parseFloat(document.getElementById("inp-lng").value);
    var lat = parseFloat(document.getElementById("inp-lat").value);
    var acc = parseInt(document.getElementById("inp-acc").value) || 25;
    var statusEl = document.getElementById("coord-status");
    if (isNaN(lng) || isNaN(lat)) { statusEl.style.color = "#ff453a"; statusEl.textContent = "经纬度格式错误"; return; }
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) { statusEl.style.color = "#ff453a"; statusEl.textContent = "经纬度超出范围"; return; }
    statusEl.style.color = "#8e8e93";
    statusEl.textContent = "保存中...";
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ longitude: lng, latitude: lat, accuracy: acc })
    })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.ok) {
        statusEl.style.color = "#34c759";
        statusEl.textContent = "已保存，立即生效！下次定位将使用新坐标。";
        poll();
      } else {
        statusEl.style.color = "#ff453a";
        statusEl.textContent = "保存失败";
      }
    })
    .catch(function() {
      statusEl.style.color = "#ff453a";
      statusEl.textContent = "网络错误";
    });
  }
  window.saveCoord = saveCoord;

  // Detect proxy: fetch apple.com - if it goes through our proxy, we detect it
  function checkProxy() {
    fetch("https://gs-loc-cn.apple.com/clls/wloc", { method: "HEAD", mode: "no-cors", cache: "no-store" })
      .catch(function(){});
  }

  // Poll server status
  function poll() {
    fetch("/api/status")
      .then(function(r){ return r.json(); })
      .then(function(d) {
        // CA: detected if any HTTPS connect came in
        if (d.connects > 0) {
          sCa.innerHTML = badge("badge-ok", "已安装");
          document.getElementById("n1").className = "num done";
          document.getElementById("n2").className = "num done";
        }

        // Proxy: detected if any WLOC request came in
        if (d.wlocIntercepts > 0) {
          sProxy.innerHTML = badge("badge-ok", "已配置");
          document.getElementById("n3").className = "num done";
          document.getElementById("n4").className = "num done";
        } else if (d.connects > 0) {
          sProxy.innerHTML = badge("badge-wait", "已安装CA，等待代理配置");
        }

        // WLOC patch status
        if (d.wlocPatches > 0) {
          sWloc.innerHTML = badge("badge-ok", "已拦截 " + d.wlocPatches + " 次");
          document.getElementById("n5").className = "num done";
        } else if (d.wlocIntercepts > 0) {
          sWloc.innerHTML = badge("badge-wait", "代理已通，等待定位触发");
        }

        // Logs — only append new entries to avoid visual overlap
        if (d.logs && d.logs.length > 0) {
          var json = JSON.stringify(d.logs);
          if (json !== knownLogs) {
            knownLogs = json;
            var html = "";
            d.logs.forEach(function(l) {
              var cls = "";
              if (l.msg.indexOf("Error") >= 0) cls = " error";
              else if (l.msg.indexOf("Warn") >= 0 || l.msg.indexOf("跳过") >= 0) cls = " warn";
              else if (l.msg.indexOf("Patched") >= 0 || l.msg.indexOf("成功") >= 0) cls = "";
              else cls = " info";
              html += '<div class="log-line"><span class="time">[' + l.time + ']</span> <span class="' + cls + '">' + l.msg + '</span></div>';
            });
            logEl.innerHTML = html;
            logEl.scrollTop = logEl.scrollHeight;
          }
        }

        // Hint
        if (d.connects > 0 && d.wlocPatches > 0) {
          hint.innerHTML = "<b>一切正常！</b> WLOC 响应已被成功篡改。打开地图 App 查看定位是否变化。";
          hint.className = "tip";
        } else if (d.connects > 0) {
          hint.innerHTML = "代理已连通。请打开地图 App 或触发定位，等待 WLOC 请求...";
          hint.className = "info";
        } else {
          hint.innerHTML = "尚未检测到代理连接。请确认：<br>1. CA 证书已安装<b>且已信任</b><br>2. Wi-Fi 代理已配置<br>3. iPhone 与电脑在同一 Wi-Fi 下";
          hint.className = "warn";
        }
      })
      .catch(function() {
        hint.innerHTML = "无法连接服务器，请确认代理服务器正在运行。";
        hint.className = "warn";
      });
  }

  checkProxy();
  poll();
  setInterval(function(){ poll(); checkProxy(); }, 3000);
  window.clearLogs = clearLogs;
  window.copyLogs = copyLogs;
  window.saveCoord = saveCoord;
})();
</script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  // CA binary download
  if (reqPath === "/download-ca") {
    res.setHeader("Content-Type", "application/x-x509-ca-cert");
    res.setHeader("Content-Disposition", 'attachment; filename="wloc-spoofer-ca.pem"');
    res.end(ca.cert);
    return;
  }

  // API status endpoint (for polling)
  if (reqPath === "/api/status") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({
      status: "running",
      uptime: Math.floor((Date.now() - runtime.startTime) / 1000),
      connects: runtime.connectCount,
      wlocIntercepts: runtime.wlocInterceptCount,
      wlocPatches: runtime.wlocPatchCount,
      wlocErrors: runtime.wlocErrorCount,
      lastWlocTime: runtime.lastWlocTime,
      lastWlocStatus: runtime.lastWlocStatus,
      lastWlocTarget: runtime.lastWlocTarget,
      target: { longitude: config.longitude, latitude: config.latitude, accuracy: config.accuracy },
      logs: runtime.logs,
    }));
    return;
  }

  // Config update API (POST)
  if (reqPath === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (typeof data.longitude === "number") config.longitude = data.longitude;
        if (typeof data.latitude === "number") config.latitude = data.latitude;
        if (typeof data.accuracy === "number") config.accuracy = Math.max(1, data.accuracy);
        addLog("Config updated: " + config.longitude + ", " + config.latitude + " (accuracy: " + config.accuracy + "m)");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, target: { longitude: config.longitude, latitude: config.latitude, accuracy: config.accuracy } }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
    });
    return;
  }

  // Clear logs API (POST)
  if (reqPath === "/api/clear" && req.method === "POST") {
    runtime.logs = [];
    runtime.connectCount = 0;
    runtime.wlocInterceptCount = 0;
    runtime.wlocPatchCount = 0;
    runtime.wlocErrorCount = 0;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Config GET
  if (reqPath === "/api/config") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ longitude: config.longitude, latitude: config.latitude, accuracy: config.accuracy }));
    return;
  }

  // Status endpoint (legacy)
  if (reqPath === "/status") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      status: "running",
      target: { longitude: config.longitude, latitude: config.latitude, accuracy: config.accuracy },
      wloc_hosts: [...WLOC_HOSTS],
    }));
    return;
  }

  // HTTP proxy (non-HTTPS) - skip requests targeting this server itself
  if (req.method === "CONNECT") return;

  const hostHeader = req.headers.host || "";
  // Prevent proxy loop: don't forward requests back to ourselves
  const selfHosts = ["127.0.0.1", "localhost"];
  const fwdHost = hostHeader.split(":")[0].toLowerCase();
  if (selfHosts.includes(fwdHost) || localIPs.includes(fwdHost)) {
    if (parseInt(hostHeader.split(":")[1] || "80", 10) === PORT) {
      res.writeHead(403);
      res.end("Proxy loop detected");
      return;
    }
  }

  const destOpts = {
    hostname: hostHeader.split(":")[0] || "localhost",
    port: parseInt(hostHeader.split(":")[1] || "80", 10),
    path: reqPath,
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== "host")),
  };

  const proxyReq = http.request(destOpts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    res.writeHead(502);
    res.end(`Proxy error: ${e.message}`);
  });
  req.pipe(proxyReq);
});

// HTTPS CONNECT tunnel with MITM for WLOC hosts
server.on("connect", (req, clientSocket, head) => {
  const hostname = req.url.split(":")[0];
  const port = parseInt(req.url.split(":")[1] || "443", 10);

  // Prevent proxy loop: if target is this server itself, reject
  if (port === PORT && (hostname === "127.0.0.1" || hostname === "localhost" ||
      localIPs.includes(hostname))) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\nProxy loop detected");
    clientSocket.destroy();
    return;
  }

  runtime.connectCount++;
  addLog("HTTPS CONNECT: " + hostname);

  if (!WLOC_HOSTS.has(hostname.toLowerCase())) {
    // Non-WLOC: plain TCP tunnel (no MITM)
    const targetPort = parseInt(req.url.split(":")[1] || "443", 10);
    const serverSocket = net.connect(targetPort, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => serverSocket.destroy());
    return;
  }

  // WLOC host: MITM with HTTP/2 support
  const cert = getCertForHost(ca, hostname);
  const tlsModule = require("tls");
  const http2Module = require("http2");

  addLog("WLOC MITM start (" + hostname + ")");

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
    h2ToH1Proxy(clientSocket, cert, hostname);
  });

  clientSocket.on("error", () => {});
});

function h2ToH1Proxy(clientSocket, cert, hostname) {
  const http2Module = require("http2");
  const tlsModule = require("tls");
  const netModule = require("net");

  const clientSession = http2Module.createSecureServer({
    key: cert.key,
    cert: cert.cert,
    allowHTTP1: false,
  });

  clientSession.on("error", (e) => {
    addLog("H2 client session error (" + hostname + "): " + (e.message || "unknown"));
  });

  clientSession.on("stream", (clientStream, headers) => {
    const method = headers[http2Module.constants.HTTP2_HEADER_METHOD] || "GET";
    const path = headers[http2Module.constants.HTTP2_HEADER_PATH] || "/";
    const isWloc = WLOC_HOSTS.has(hostname.toLowerCase()) &&
      path.split("?")[0] === WLOC_PATH;

    addLog("WLOC h2 stream: " + method + " " + path + (isWloc ? " [MATCH]" : ""));

    var fwdHeaders = {};
    for (var k in headers) {
      var lk = k.toLowerCase();
      if (lk.charAt(0) === ":" || lk === "connection" || lk === "transfer-encoding" ||
          lk === "keep-alive" || lk === "upgrade" || lk === "content-length") continue;
      if (lk === "accept-encoding") {
        fwdHeaders["accept-encoding"] = "gzip, deflate";
        continue;
      }
      fwdHeaders[k] = headers[k];
    }

    var bodyChunks = [];
    var bodyLen = 0;
    clientStream.on("data", (chunk) => {
      bodyChunks.push(chunk);
      bodyLen += chunk.length;
    });

    clientStream.on("end", () => {
      var reqOptions = {
        hostname: hostname,
        port: 443,
        path: path,
        method: method,
        headers: fwdHeaders,
        servername: hostname,
        rejectUnauthorized: false,
      };

      if (isWloc) {
        addLog("WLOC send → " + method + " " + path + " bodyLen=" + bodyLen);
      }

      var upstreamReq = https.request(reqOptions, function(upstreamRes) {
        var respBuf = Buffer.alloc(0);
        upstreamRes.on("data", function(chunk) {
          respBuf = Buffer.concat([respBuf, chunk]);
        });
        upstreamRes.on("end", function() {
          if (!clientStream.destroyed) {
            processH1Response(upstreamRes, respBuf);
          }
        });
      });

      upstreamReq.on("error", function(e) {
        addLog("WLOC upstream error: " + (e.message || "unknown"));
        if (!clientStream.destroyed) {
          try {
            clientStream.respond({ ":status": "502" });
            clientStream.end("Bad Gateway");
          } catch (ex) {}
        }
      });

      if (bodyChunks.length > 0) {
        upstreamReq.write(Buffer.concat(bodyChunks));
      }
      upstreamReq.end();
    });

    function processH1Response(upstreamRes, respBuf) {
      var status = String(upstreamRes.statusCode || "200");
      var h2Headers = {};
      var resHeaders = upstreamRes.headers;
      for (var k in resHeaders) {
        var lk = k.toLowerCase();
        if (lk === "connection" || lk === "transfer-encoding" ||
            lk === "keep-alive" || lk === "upgrade" || lk === "content-length") continue;
        h2Headers[k] = resHeaders[k];
      }
      h2Headers["content-length"] = String(respBuf.length);

      if (isWloc && status === "200") {
        try {
          var decoded = maybeGunzip(respBuf);
          var patched = patchFrame(decoded);
          respBuf = patched;
          delete h2Headers["content-encoding"];
          h2Headers["content-length"] = String(patched.length);
          h2Headers["x-wloc-spoofer"] = "nodejs-h2";
          h2Headers["x-wloc-target"] = config.longitude + "," + config.latitude;
          h2Headers["x-wloc-patched"] = "1";
          runtime.wlocPatchCount++;
          runtime.lastWlocTime = new Date().toLocaleTimeString("zh-CN", { hour12: false });
          runtime.lastWlocStatus = "h2 patched";
          runtime.lastWlocTarget = config.longitude + "," + config.latitude;
          addLog("WLOC Patched: " + respBuf.length + " bytes");
        } catch (e) {
          h2Headers["x-wloc-error"] = e.message || "unknown";
          runtime.wlocErrorCount++;
          addLog("WLOC Error: " + (e.message || "unknown"));
        }
      }

      if (isWloc && status !== "200") {
        runtime.wlocInterceptCount++;
        runtime.lastWlocTime = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        runtime.lastWlocStatus = status;
        addLog("WLOC Intercepted: status=" + status);
      }

      delete h2Headers["connection"];
      delete h2Headers["transfer-encoding"];
      delete h2Headers["keep-alive"];
      delete h2Headers["upgrade"];
      delete h2Headers["proxy-connection"];
      delete h2Headers["http2-settings"];

      h2Headers[":status"] = status;
      try {
        clientStream.respond(h2Headers);
        clientStream.end(respBuf);
      } catch (respondErr) {
        addLog("h2 respond error: " + (respondErr.message || "unknown"));
      }
    }

    clientStream.on("error", () => {});
  });

  clientSession.emit("connection", clientSocket);

  clientSocket.on("error", () => {});
  clientSocket.on("close", () => {
    clientSession.close();
  });
}

function patchH2Frames(chunk, hostname) {
  const frames = [];
  let offset = 0;
  while (offset + 9 <= chunk.length) {
    const length = (chunk[offset] << 16) | (chunk[offset + 1] << 8) | chunk[offset + 2];
    const type = chunk[offset + 3];
    const flags = chunk[offset + 4];
    const streamId = (chunk[offset + 5] << 24) | (chunk[offset + 6] << 16) | (chunk[offset + 7] << 8) | chunk[offset + 8];
    const headerLen = 9;
    const totalLen = headerLen + length;
    if (totalLen > chunk.length - offset) break;

    if (type === 0x00 && length >= 10) {
      const payload = chunk.slice(offset + headerLen, offset + totalLen);
      try {
        const decoded = maybeGunzip(payload);
        const patched = patchFrame(decoded);
        if (!patched.equals(decoded)) {
          const newLen = patched.length;
          const newHeader = Buffer.alloc(9);
          newHeader[0] = (newLen >> 16) & 0xff;
          newHeader[1] = (newLen >> 8) & 0xff;
          newHeader[2] = newLen & 0xff;
          newHeader[3] = type;
          newHeader[4] = flags;
          newHeader[5] = (streamId >> 24) & 0xff;
          newHeader[6] = (streamId >> 16) & 0xff;
          newHeader[7] = (streamId >> 8) & 0xff;
          newHeader[8] = streamId & 0xff;
          frames.push(newHeader, patched);
          console.log("[WLOC] h2 DATA frame patched (" + payload.length + " -> " + newLen + " bytes, stream " + streamId + ")");
          runtime.wlocPatchCount++;
          runtime.lastWlocTime = new Date().toLocaleTimeString("zh-CN", { hour12: false });
          runtime.lastWlocStatus = "h2 patched";
          runtime.lastWlocTarget = config.longitude + "," + config.latitude;
          addLog("WLOC h2 Patched: stream " + streamId + " (" + payload.length + " -> " + newLen + ")");
          offset += totalLen;
          continue;
        }
      } catch (e) {
      }
    }
    frames.push(chunk.slice(offset, offset + totalLen));
    offset += totalLen;
  }
  if (offset < chunk.length) {
    frames.push(chunk.slice(offset));
  }
  if (frames.length === 0) return chunk;
  if (frames.length === 1 && frames[0] === chunk) return chunk;
  return Buffer.concat(frames);
}

function processClientData(clientTls, serverSocket, buf, hostname, onRemaining) {
  const str = buf.toString("utf-8");
  const headerEnd = str.indexOf("\r\n\r\n");
  if (headerEnd === -1) return;

  const headerStr = str.substring(0, headerEnd);
  const bodyStart = headerEnd + 4;
  const lines = headerStr.split("\r\n");
  const [method, urlPath, version] = lines[0].split(" ");

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx > 0) {
      headers[lines[i].substring(0, colonIdx).trim().toLowerCase()] = lines[i].substring(colonIdx + 1).trim();
    }
  }

  let contentLength = parseInt(headers["content-length"] || "0", 10);
  const bodyData = buf.slice(bodyStart);

  if (bodyData.length < contentLength) return;

  // Forward request to Apple
  let forwardHeaders = "";
  for (const line of lines.slice(1)) {
    const lower = line.toLowerCase();
    if (!lower.startsWith("proxy-") && lower !== "connection") {
      forwardHeaders += line + "\r\n";
    }
  }
  const reqPacket = `${method} ${urlPath} ${version}\r\n${forwardHeaders}\r\n`;
  serverSocket.write(Buffer.concat([Buffer.from(reqPacket), bodyData.slice(0, contentLength)]));

  onRemaining(bodyData.slice(contentLength));
}

function processServerData(clientTls, buf, hostname, onRemaining) {
  const str = buf.toString("utf-8");
  let headerEnd = str.indexOf("\r\n\r\n");
  let sepLen = 4;
  let lineSep = "\r\n";
  if (headerEnd === -1) {
    headerEnd = str.indexOf("\n\n");
    if (headerEnd === -1) return;
    sepLen = 2;
    lineSep = "\n";
  }

  const headerStr = str.substring(0, headerEnd);
  const lines = headerStr.split(lineSep);
  const [version, statusCode, statusText] = lines[0].split(" ", 3);

  const headers = [];
  let contentLength = 0;
  let isChunked = false;
  let isGzip = false;

  for (let i = 1; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lower.startsWith("content-length:")) {
      contentLength = parseInt(lines[i].split(":")[1].trim(), 10);
    }
    if (lower.startsWith("transfer-encoding:") && lines[i].includes("chunked")) {
      isChunked = true;
    }
    if (lower.startsWith("content-encoding:") && lines[i].includes("gzip")) {
      isGzip = true;
    }
    headers.push(lines[i]);
  }

  if (isChunked) {
    // For chunked encoding, just forward as-is (WLOC typically uses Content-Length)
    clientTls.write(buf);
    onRemaining(Buffer.alloc(0));
    return;
  }

  const bodyData = buf.slice(headerEnd + sepLen);
  if (bodyData.length < contentLength) return;

  const responseBody = bodyData.slice(0, contentLength);

  let patchedBody = responseBody;
  let patchedHeaders = [...headers];
  let patchedStatus = statusCode;

  if (isWlocRequest(hostname, lines[0]) && parseInt(statusCode) === 200) {
    try {
      const decoded = maybeGunzip(responseBody);
      patchedBody = patchFrame(decoded);
      patchedHeaders = patchedHeaders.filter(h => {
        const lower = h.toLowerCase();
        return !lower.startsWith("content-length:") && !lower.startsWith("content-encoding:");
      });
      patchedHeaders.push(`Content-Length: ${patchedBody.length}`);
      patchedHeaders.push("X-WLOC-Spoofer: nodejs-standalone");
      patchedHeaders.push(`X-WLOC-Target: ${config.longitude},${config.latitude}`);
      patchedHeaders.push("X-WLOC-Patched: 1");
      console.log(`[WLOC] Patched response for ${hostname}: (${responseBody.length} -> ${patchedBody.length} bytes)`);
      runtime.wlocPatchCount++;
      runtime.lastWlocTime = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      runtime.lastWlocStatus = "200 patched";
      runtime.lastWlocTarget = `${config.longitude},${config.latitude}`;
      addLog("WLOC Patched: ${hostname} (${responseBody.length} -> ${patchedBody.length} bytes)");
    } catch (e) {
      patchedHeaders.push(`X-WLOC-Error: ${e.message}`);
      console.error(`[WLOC] Error patching:`, e.message);
      runtime.wlocErrorCount++;
      runtime.lastWlocTime = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      runtime.lastWlocStatus = "error";
      addLog("WLOC Error: ${e.message}");
    }
  } else if (isWlocRequest(hostname, lines[0])) {
    runtime.wlocInterceptCount++;
    runtime.lastWlocTime = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    runtime.lastWlocStatus = statusCode;
    addLog("WLOC Intercepted: status=" + statusCode + " (non-200, skip patch)");
  }

  const respPacket = `${version} ${patchedStatus} ${statusText}\r\n${patchedHeaders.join("\r\n")}\r\n\r\n`;
  clientTls.write(Buffer.concat([Buffer.from(respPacket), patchedBody]));

  onRemaining(bodyData.slice(contentLength));
}

server.listen(PORT, "0.0.0.0", () => {
  const nets = require("os").networkInterfaces();
  let ip = "127.0.0.1";
  const hotspotPrefixes = ["192.168.43.", "192.168.1.", "192.168.0.", "172.20.", "10.0.0."];
  const skipPrefixes = ["127.", "169.254."];
  const allIps = [];
  let hotspotIp = null;

  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === "IPv4" && !n.internal && !skipPrefixes.some(p => n.address.startsWith(p))) {
        allIps.push({ name, address: n.address });
        if (!hotspotIp && hotspotPrefixes.some(p => n.address.startsWith(p))) {
          hotspotIp = n.address;
        }
      }
    }
  }

  const isMobile = process.platform === "android" || !!process.env.TERMUX_VERSION || !!process.env.PREFIX;
  const displayIp = hotspotIp || ip;

  console.log("=========================================");
  console.log("  WLOC Spoofer - Standalone Proxy Server");
  console.log("  " + (isMobile ? "[Mobile/Hotspot Mode]" : "[Desktop Mode]"));
  console.log("=========================================");
  if (allIps.length > 0) {
    console.log("  Network interfaces:");
    for (const i of allIps) {
      const marker = i.address === displayIp ? " <-- use this" : "";
      console.log(`    ${i.name}: ${i.address}${marker}`);
    }
    console.log("");
  }
  console.log(`  Proxy address: ${displayIp}:${PORT}`);
  console.log(`  Target: ${config.longitude}, ${config.latitude} (accuracy: ${config.accuracy}m)`);
  console.log("");
  console.log("  iPhone Setup:");
  console.log(`  1. Safari: http://${displayIp}:${PORT}/ca  -> install CA certificate`);
  console.log(`  2. Settings > General > About > Certificate Trust Settings > Enable "WLOC Spoofer CA"`);
  console.log(`  3. Wi-Fi > Configure Proxy > Manual > Server: ${displayIp}, Port: ${PORT}`);
  console.log("  4. Trigger location on iPhone");
  console.log("=========================================");
});
