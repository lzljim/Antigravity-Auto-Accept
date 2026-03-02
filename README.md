# Antigravity Auto-Accept

通过 Chrome DevTools Protocol (CDP) 自动确认 Antigravity IDE 中 Agent 面板的操作按钮。**支持多会话并行**，后台会话中的按钮也能被自动点击。

> **原理**：连接 IDE 内置 Chromium 的调试端口，对所有渲染进程（包括 OOPIF 隔离沙盒）建立持久连接，注入 MutationObserver 实时监听 DOM 变化，按钮出现时即刻 `click()`。不移动鼠标、不抢焦点、最小化窗口也能正常工作。

---

## 📋 使用步骤

### 第 1 步：为 Antigravity IDE 开启调试端口

你需要在 Antigravity 的启动命令中添加 `--remote-debugging-port=9222` 参数。

#### Windows 快捷方式修改方法

1. **找到 Antigravity 的桌面快捷方式**（或开始菜单快捷方式）
2. **右键 → 属性**
3. 在 **"目标"** 栏的末尾追加参数：

   ```
   --remote-debugging-port=9222
   ```

   修改后的完整路径示例：
   ```
   "C:\Users\你的用户名\AppData\Local\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=9222
   ```

4. 点击 **确定** 保存

> [!IMPORTANT]
> - 参数要加在引号**外面**，引号和 `--` 之间用空格隔开
> - 端口号 `9222` 可以自定义，但必须与 `config.json` 中的 `port` 一致
> - 修改后需要**完全关闭并重启** Antigravity 才能生效

#### 验证调试端口是否开启

启动 Antigravity 后，在浏览器中访问：

```
http://127.0.0.1:9222/json
```

如果看到 JSON 格式的 target 列表，说明调试端口已成功开启。

---

### 第 2 步：安装依赖

在本项目目录下运行：

```bash
npm install
```

---

### 第 3 步：启动脚本

```bash
npm start
```

或直接：

```bash
node auto-accept.js
```

你将看到类似输出：

```
[10:30:00] ==========================================
[10:30:00]   Antigravity Auto-Accept 已启动
[10:30:00] ==========================================
[10:30:00]   调试端口 : 9222
[10:30:00]   轮询间隔 : 500ms
[10:30:00]   按钮白名单: Accept, Run, Always allow, Yes, Confirm, Allow, ...
[10:30:00]   自动重连 : 是
[10:30:00]   日志级别 : info
[10:30:00] ==========================================
[10:30:00]
[10:30:00] ⏳ 等待连接 Antigravity IDE...
```

当 Agent 产生需要确认的操作时，脚本会自动点击并输出：

```
[10:31:05] ✅ 自动点击了: [Accept]  (target: Antigravity Agent Panel)
```

### 第 4 步：停止脚本

在终端按 `Ctrl + C` 即可优雅退出。

---

## ⚙️ 配置说明

编辑 `config.json` 来自定义行为：

```jsonc
{
  "port": 9222,             // CDP 调试端口，与启动参数一致
  "pollIntervalMs": 500,    // 轮询间隔（毫秒），越小响应越快但 CPU 占用越高
  "buttonTexts": [           // 要自动点击的按钮文本白名单（不区分大小写）
    "Accept",
    "Run",
    "Always allow",
    "Yes",
    "Confirm",
    "Allow",
    "Accept All",
    "Run command",
    "Approve"
  ],
  "usePersistentMode": true, // 持久连接 + MutationObserver 模式（推荐，支持多会话）
  "autoReconnect": true,     // IDE 关闭/重启后是否自动重连
  "reconnectIntervalMs": 3000, // 重连检测间隔（毫秒）
  "logLevel": "info"         // 日志级别：debug（详细）/ info（正常）/ silent（静默）
}
```

> [!TIP]
> 如果你想看到更多调试信息（例如 target 扫描详情），将 `logLevel` 设为 `"debug"`。

---

## ❓ 常见问题

### Q: 脚本一直显示 "未检测到 IDE 调试端口"

**可能原因：**
1. Antigravity 没有添加 `--remote-debugging-port=9222` 启动参数
2. 修改快捷方式后没有完全退出并重启 IDE
3. 端口号不一致 —— 检查 `config.json` 中的 `port` 与启动参数是否相同

**排查方法：**
```bash
# 检查端口是否有进程在监听
netstat -ano | findstr :9222
```

### Q: 端口 9222 已被其他程序占用

修改为其他端口即可，两处同步修改：
1. 快捷方式中的 `--remote-debugging-port=9223`（改为 9223 或其他可用端口）
2. `config.json` 中的 `"port": 9223`

### Q: 脚本会不会误点击不该点的按钮？

脚本**只会**点击 `config.json` → `buttonTexts` 白名单中列出的按钮文本。你可以：
- 移除不想自动确认的文本（例如删掉 `"Run"` 以避免自动执行命令）
- 按钮匹配是**精确匹配**（非模糊搜索），且忽略大小写

### Q: 这样做安全吗？

> [!WARNING]
> - 调试端口仅绑定在 `127.0.0.1`（本机），外部无法访问
> - 但本机的其他程序理论上可以连接此端口，请注意本地安全环境
> - 不建议在公共网络或不受信任的环境中使用

### Q: 多会话场景下后台会话的按钮不会被点击？

确保 `config.json` 中 `usePersistentMode` 设置为 `true`（默认开启）。该模式会：

1. 对每个渲染进程保持持久 CDP 连接
2. 注入 MutationObserver 实时监听 DOM 变化
3. 后台 webview 中的按钮也能被即时检测并点击

如遇到兼容问题，设为 `false` 可退回传统轮询模式。

### Q: 我想让脚本开机自启动

可以创建一个 `.bat` 文件放到 Windows 启动文件夹中：

```bat
@echo off
cd /d "C:\Users\你的用户名\.gemini\antigravity\playground\nebular-trifid"
node auto-accept.js
```

启动文件夹路径：按 `Win + R` 输入 `shell:startup` 回车。

---

## 📁 项目结构

```
├── auto-accept.js    # 核心脚本
├── config.json       # 配置文件
├── package.json      # 项目配置
└── README.md         # 使用说明（本文件）
```
