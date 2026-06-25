# iOS 免越狱定位修改

## 1. 技术背景与动机

### 为什么需要修改 iOS 定位

iOS 定位修改在多个场景有实际需求：

- **QA/测试**：需要在特定地理位置复现 App 行为（地图、LBS 服务、区域限制功能）
- **安全研究**：评估应用和服务对定位数据的信任程度
- **开发调试**：开发者需要模拟不同地理位置测试功能

### 传统方案的困境

| 方案                | 原理                        | 限制                                    |
| ------------------- | --------------------------- | --------------------------------------- |
| 越狱 + 位置模拟插件 | 直接 hook 定位系统调用      | 需要越狱，安全性低，不适用于生产设备    |
| Xcode 模拟位置      | 通过开发者工具注入虚拟位置  | 需要 Mac + Xcode + 开发者模式，仅限调试 |
| VPN/DNS 层面劫持    | 修改网络层面的 IP 归属地    | 精度差，无法精确到经纬度                |
| **MITM 响应篡改**   | 拦截并修改网络定位 API 响应 | **无需越狱，精度高，可精确到经纬度**    |

本文采用 **MITM 响应篡改** 方案。

---

## 2. 核心原理

### iOS 定位系统工作原理

iOS 设备获取位置信息有多种途径，按优先级排列：

```
iOS 定位请求
    ├── GPS 卫星定位（最高优先级）
    ├── WIFI 定位 - WLOC（室内主要依赖）
    ├── 基站定位
    ├── 蓝牙信标 iBeacon
    └── 位置融合引擎 → 返回最佳位置
```

**关键洞察**：当 GPS 信号较弱（室内、高楼遮挡）时，iOS 会大量依赖 **WIFI 网络定位（WLOC）**。WLOC 的工作方式是：iOS 收集周围 WiFi AP 的 BSSID/MAC 地址，发送给 Apple 服务器，Apple 查询其 WiFi 指纹数据库后返回经纬度。

### MITM 响应篡改原理

```
Apple 服务器 ──HTTPS请求──▶ 自建代理 ──转发请求──▶ Apple WLOC 服务
                              │
                              ◀──原始响应──────────────────┘
                              │
                         脚本拦截 → 解压 gzip → 解析 Protobuf → 替换经纬度 → 重新打包
                              │
iPhone ◀──篡改后响应──────────┘
```

---

## 3. 实现方案

### 参考方案：App 修改定位

以下开源/商业 App 通过 MITM 拦截 WLOC 响应或开发者接口注入虚拟 GPS 来修改 iPhone 定位，均需在 iPhone 上安装 App：

| 应用                                                         | 原理                   | 平台              | 说明                                    |
| ------------------------------------------------------------ | ---------------------- | ----------------- | --------------------------------------- |
| [ProxyPin](https://github.com/FFF686868/proxypin-wloc-spoofer) | MITM 篡改 WLOC 响应    | iOS App           | 导入 JS 脚本修改经纬度，GUI 操作        |
| [ios-location-spoofer](https://github.com/Joy-cwz/ios-location-spoofer) | VPN 隧道 + MITM        | iOS App（需签名） | 设备端独立运行，需 Apple 开发者账号     |
| [iAnyGo](https://www.tenorshare.com/products/ianygo-iphone-location-changer.html) | 开发者接口注入虚拟 GPS | 桌面端 + USB      | 付费，修改 GPS 层（可被检测为模拟定位） |
| [iMyFone AnyTo](https://www.imyfone.com/)                    | 开发者接口注入虚拟 GPS | 桌面端 + USB      | 付费，支持路线模拟和摇杆模式            |
| [LocaChange](https://www.locachange.com/)                    | 开发者接口注入虚拟 GPS | 桌面端 + USB      | 付费，支持 Wi-Fi 连接                   |
| [GeoPort](https://github.com/davesc63/GeoPort)               | 开发者接口注入虚拟 GPS | 桌面端 + USB      | 开源，支持 Windows/Mac                  |
| [iFakeGPS](https://github.com/www10177/iFakeGPS)             | 开发者接口注入虚拟 GPS | Windows 桌面端    | 开源，基于 pymobiledevice3              |
| [爱思助手](https://www.i4.cn/)                               | 开发者接口注入虚拟 GPS | 桌面端 + USB      | 免费，工具箱 > 虚拟定位功能             |

> **本方案 vs 上述方案的区别**：上述方案需要在 iPhone 上安装 App 或通过 USB 连接电脑。本方案仅需 iPhone 配置 Wi-Fi 代理，无需安装任何 App。

### 本方案：自建代理服务器

在 PC 或 Android 手机上运行代理服务器，iPhone 只需配置 Wi-Fi 代理即可。

**优点**：iPhone 无需安装任何 App  
**缺点**：需要一台设备（PC 或 Android 手机）持续运行代理

---

## 4. 自建代理服务器部署指南

### 4.1 快速开始

```bash
git clone https://github.com/weskhen/wloc-spoofer.git
cd wloc-spoofer

# PC 端
Windows: 双击 start.bat
macOS/Linux: chmod +x start.sh && ./start.sh

# Android 手机端（ADB 一键部署）
Windows: adb-deploy-android.bat
macOS/Linux: chmod +x adb-deploy-android.sh && ./adb-deploy-android.sh
```

脚本会自动检测并安装依赖（Node.js / OpenSSL / Termux），无需手动配置。

### 4.2 环境要求

| 方案       | 要求                          |
| ---------- | ----------------------------- |
| PC 端      | Node.js 18+ + OpenSSL         |
| Android 端 | ADB + Android 手机 + USB 连接 |

### 4.3 文件说明

```
wloc-spoofer/
├── server.js                # 独立代理服务器（零依赖）
├── start.bat                # Windows PC 端一键启动
├── start.sh                 # macOS/Linux PC 端一键启动
├── adb-deploy-android.bat   # Windows ADB 一键部署到 Android 手机
├── adb-deploy-android.sh    # macOS/Linux ADB 一键部署到 Android 手机
└── wloc-setup.sh            # Android 手机端执行脚本（ADB 自动推送）
```

### 4.4 修改目标坐标

编辑 `server.js` 顶部的配置：

```javascript
const config = {
  longitude: 120.7267,   // 经度（仙居县）
  latitude:  28.8472,    // 纬度（仙居县）
  accuracy:  25,         // 精度（米）
};
```

如果不知道经纬度，使用高德坐标拾取器：https://lbs.amap.com/tools/picker

**注意顺序：经度在前，纬度在后。**

### 4.5 iPhone 配置步骤

#### Step 1 - 启动代理服务器

**PC 端：**

```
Windows: 双击 start.bat（或 start.bat 9090 指定端口）
macOS/Linux: chmod +x start.sh && ./start.sh（或 ./start.sh 9090）
```

脚本会自动检测 Node.js 环境并启动，终端显示代理 IP 和端口。

**Android 手机端（ADB 一键部署）：**

```
Windows: adb-deploy-android.bat
macOS/Linux: adb-deploy-android.sh
```

脚本自动检测 ADB、安装 Termux、推送 server.js 并启动代理。iPhone 连接 Android 热点即可使用。

#### Step 2 - 安装 CA 证书

1. 确保 iPhone 和代理服务器在**同一网络**下（PC 端：同一 Wi-Fi；Android 端：连接 Android 热点）
2. iPhone Safari 访问：`http://<代理IP>:<端口>/ca` 下载并安装证书
3. **设置 > 通用 > 关于本机 > 证书信任设置 > 开启完全信任**

> 这一步非常重要！没有信任 CA，代理无法解密 HTTPS。

#### Step 3 - 配置 Wi-Fi 代理

1. 设置 > Wi-Fi > 点击已连接的 Wi-Fi 右侧 ⓘ
2. 滚动到底部 > **配置代理 > 手动**
3. 服务器：`<代理IP>`
4. 端口：`<代理端口>`
5. 保存

#### Step 4 - 触发定位验证

1. **关闭定位服务**：设置 > 隐私与安全性 > 定位服务 > **关闭**
2. 等待 5 秒
3. **重新开启定位服务**
4. 打开任意地图 App

> 必须关闭再开启定位服务，否则 iOS 会使用缓存的定位数据，不会重新发起 WLOC 请求。

**室内测试效果最佳**（GPS 信号弱时 iOS 更依赖 WLOC）。

#### Step 5 - 验证是否成功

在代理服务器的终端输出中，应该能看到类似日志：

```
[WLOC] Patched response for gs-loc-cn.apple.com: (1234 -> 1200 bytes)
```

如果看到响应中包含 `X-WLOC-Origin-Status: 400`，说明 Apple 服务端拒绝了原始请求。

### 4.6 测试结束后清理

1. 关闭代理服务器
2. iPhone > 设置 > Wi-Fi > 配置代理 > **关闭**
3. 删除 CA 证书（设置 > 通用 > VPN与设备管理 > 删除描述文件）

---

## 5. 常见问题

### 看不到 WLOC 请求

- 确认代理服务器正在运行
- 确认 iPhone Wi-Fi 代理已配置且指向正确 IP
- 确认 CA 证书已安装且**已信任**
- 室外 GPS 信号强时 iOS 可能不触发 WLOC

### 返回 400

Apple 服务端拒绝了原始请求。检查代理是否正确转发了二进制请求。

### 定位没有变化

- 坐标顺序写反了（经度在前，纬度在后）
- GPS 信号太强，iOS 优先使用真实 GPS → 建议到室内测试
- 代理未开启或脚本未启用

### 端口被占用

- Android 端（wloc-setup.sh）会自动检测端口占用并自增重试（8080 → 8081 → ...）
- PC 端端口被占用时会报错，使用其他端口启动：`start.bat 9090`

---

## 6. 技术细节

### WLOC 二进制帧结构

| 偏移量       | 长度    | 含义                                 |
| ------------ | ------- | ------------------------------------ |
| 0-7          | 8 字节  | 帧头前缀（固定不变，直接保留）       |
| 8-9          | 2 字节  | Payload 长度（大端序，篡改后需更新） |
| 10 ~ 10+PL   | PL 字节 | Protobuf 编码的定位数据              |
| 10+PL ~ 末尾 | 可变    | 尾部数据（直接保留）                 |

### Protobuf 嵌套结构

```
WLOC Frame Payload (Protobuf)
├── field 2 (wire type 2/LEN) → WiFi 设备定位结果
│   ├── field 1 (wire type 2/LEN) → BSSID 字符串 (MAC 格式)
│   └── field 2 (wire type 2/LEN) → 位置信息 (嵌套 Protobuf)
│       ├── field 1 (wire type 0/VARINT) → 纬度 (×100000000)
│       ├── field 2 (wire type 0/VARINT) → 经度 (×100000000)
│       └── field 3 (wire type 0/VARINT) → 精度 (米)
├── field 22 (wire type 2/LEN) → 基站定位结果类型 A
│   └── field 5 (wire type 2/LEN) → 位置信息 (同上结构)
└── field 24 (wire type 2/LEN) → 基站定位结果类型 B
    └── field 5 (wire type 2/LEN) → 位置信息 (同上结构)
```

---

## 7. 方案对比

| 维度            | App 修改定位（参考） | 自建代理 (PC)     | 自建代理 (Android 手机) |
| --------------- | -------------------- | ----------------- | ----------------------- |
| iPhone 需装 App | 是                   | **否**            | **否**                  |
| 需要额外设备    | 否                   | PC                | Android 手机            |
| 额外依赖        | 各 App 自身          | Node.js + OpenSSL | Termux + Node.js        |
| 技术门槛        | 低                   | 中                | 中                      |
| 灵活性          | 中                   | 高                | 高                      |
| 便携性          | 高                   | 低（需 PC）       | **高（仅手机）**        |
| 推荐场景        | 快速测试             | 办公室/固定环境   | 移动/外出场景           |

> 参考方案详见第 3 节「参考方案：App 修改定位」 |

---

## 8. 适用场景与局限性

### 最佳适用场景

| 场景              | 适用性   | 原因                      |
| ----------------- | -------- | ------------------------- |
| 室内 QA 测试      | 非常适合 | GPS 信号弱，iOS 依赖 WLOC |
| LBS App 功能测试  | 适合     | 可精确控制经纬度          |
| 区域限制功能验证  | 适合     | 可模拟任意地理位置        |
| 安全研究/渗透测试 | 适合     | 透明可审计的篡改方式      |

### 关键局限性

- **GPS 优先级问题**：室外 GPS 信号强时，iOS 可能完全不触发 WLOC 请求
- **仅影响 WLOC 通道**：不修改 GPS、蓝牙信标等其他定位通道
- **需要持续代理**：关闭代理即恢复真实定位
- **证书信任可被检测**：部分 App 可检测非 Apple 根证书

---


