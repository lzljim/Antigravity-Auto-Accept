# Auto Accept — VS Code 插件使用说明

自动确认 Antigravity Agent 面板中的操作按钮（代码编辑、终端命令等），解放双手，让 Agent 无打断地持续工作。

> **原理**：插件通过 Chrome DevTools Protocol (CDP) 连接 Antigravity IDE 内置 Chromium 的调试端口，注入 MutationObserver 实时监听所有渲染进程的 DOM 变化；同时借助 `antigravity-sdk` 的 Monitor 事件作为加速信号。按钮出现时即刻 `click()`，不移动鼠标、不抢焦点、后台会话同样有效。

---

## 📦 安装

### 方式一：从 .vsix 文件安装（推荐）

1. 在 VS Code / Antigravity IDE 中打开命令面板（`Ctrl+Shift+P`）
2. 执行 **Extensions: Install from VSIX...**
3. 选择项目目录下的 `antigravity-auto-accept-x.x.x.vsix` 文件
4. 安装完成后重启 IDE

### 方式二：从源码打包安装

```bash
cd extension
npm install
npm run package        # 生成 .vsix 文件，然后按方式一安装
```

---

## 🔧 前置配置：为 IDE 开启 CDP 调试端口

这是插件正常工作的**必要条件**。

### Windows 快捷方式修改方法

1. 找到 Antigravity 的桌面快捷方式（或开始菜单）
2. 右键 → **属性**
3. 在 **"目标"** 栏末尾追加（引号**外面**，空格隔开）：
   ```
   --remote-debugging-port=9222
   ```
   完整示例：
   ```
   "C:\Users\你的用户名\AppData\Local\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=9222
   ```
4. 点击 **确定** → 完全退出并重启 Antigravity

### 验证调试端口是否开启

启动 Antigravity 后，浏览器访问：
```
http://127.0.0.1:9222/json
```
看到 JSON target 列表即说明成功。

> [!IMPORTANT]
> 端口号 `9222` 可自定义，但必须与插件设置中的 `autoAccept.cdpPort` 一致。

---

## 🚀 快速开始

插件安装并配置好调试端口后，**开启 Antigravity IDE 即自动启动**，无需手动操作。

你可以在 Antigravity 活动栏看到 **Auto Accept** 图标（🤖），点击打开 Dashboard 面板查看运行状态。

---

## 🖥️ Dashboard 面板

点击活动栏的 **Auto Accept**（机器人图标）即可打开，包含四个区域：

| 区域 | 说明 |
|------|------|
| **📊 Statistics** | 已自动点击次数（Accepted）和自动重试次数（Retried） |
| **🔗 Connection** | CDP 连接状态（绿点 = Connected）及当前 target 数量 |
| **⚙️ Controls** | 快捷操作按钮（见下） |
| **📜 Recent Events** | 实时事件流，记录每次自动点击/重试的时间和按钮名称 |

### Controls 按钮说明

| 按钮 | 等效命令 | 说明 |
|------|---------|------|
| ⏯️ Toggle On/Off | `Auto Accept: Toggle On/Off` | 暂停/恢复自动接受 |
| 📋 Show Log | `Auto Accept: Show Log` | 打开 Output 面板 → Auto Accept 频道 |
| 🔁 Reset Count | `Auto Accept: Reset Count` | 重置 Accepted/Retried 计数器 |

---

## ⌨️ 命令与快捷键

通过命令面板（`Ctrl+Shift+P`）可执行所有命令：

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| `Auto Accept: Toggle On/Off` | `Ctrl+Shift+A` | 开/关自动接受（Mac: `Cmd+Shift+A`） |
| `Auto Accept: Show Log` | — | 打开日志输出面板 |
| `Auto Accept: Reset Count` | — | 重置计数器 |
| `Auto Accept: Explore Antigravity API (Debug)` | — | 运行诊断，输出 CDP/SDK 状态报告 |

---

## ⚙️ 配置说明

在 VS Code 设置（`Ctrl+,`）中搜索 `Auto Accept` 即可看到所有配置项：

### 基础配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `autoAccept.enabled` | boolean | `true` | 启动时是否自动开启 |
| `autoAccept.cdpPort` | number | `9222` | CDP 调试端口，须与 IDE 启动参数一致 |
| `autoAccept.logLevel` | string | `"info"` | 日志级别：`debug` / `info` / `silent` |
| `autoAccept.monitorPollInterval` | number | `3000` | SDK 事件监听间隔（毫秒） |

### 按钮白名单

```jsonc
// settings.json
"autoAccept.buttonTexts": [
  "Run",
  "Allow This Conversation",
  "Always Allow",
  "Allow Once",
  "Accept all",
  "Accept"
]
```

- 列表顺序即**优先级**，靠前的按钮优先点击
- 精确匹配（忽略大小写）
- 删除某项可阻止自动点击该类按钮（例如删除 `"Run"` 可避免自动执行终端命令）

### 分类开关

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `autoAccept.acceptCodeEdits` | `true` | 自动接受代码编辑 |
| `autoAccept.acceptTerminalCommands` | `true` | 自动接受终端命令 |
| `autoAccept.acceptOtherActions` | `true` | 自动接受其他操作 |

### Smart Retry（自动重试）

当 Agent 遇到错误时，可自动切换模型重试：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `autoAccept.autoRetry.enabled` | `false` | 是否启用自动重试 |
| `autoAccept.autoRetry.modelFallback` | 见下 | 模型回退列表（按顺序尝试） |
| `autoAccept.autoRetry.maxRetries` | `3` | 单次会话最大重试次数（1~10） |
| `autoAccept.autoRetry.retryButtonTexts` | `["Retry"]` | 识别 Retry 按钮的文本 |

默认模型回退列表：
```json
["Claude Opus 4.6 (Thinking)", "Claude Sonnet 4.6 (Thinking)", "Gemini 3.1 Pro (High)"]
```

---

## ❓ 常见问题

### Q: Dashboard 显示 Disconnected，按钮没有被自动点击

1. 确认 Antigravity 启动参数中有 `--remote-debugging-port=9222`
2. 确认完全重启了 IDE（任务管理器中彻底关闭再启动）
3. 检查 `autoAccept.cdpPort` 与启动参数端口一致
4. 在浏览器访问 `http://127.0.0.1:9222/json` 验证端口是否开放

排查命令：
```powershell
netstat -ano | findstr :9222
```

### Q: 不想自动执行终端命令，只想自动接受代码编辑

方案一：关闭 `autoAccept.acceptTerminalCommands`（需要插件实现对应过滤逻辑）  
方案二：从 `autoAccept.buttonTexts` 中移除 `"Run"` 和 `"Run command"`

### Q: 端口 9222 已被其他程序占用

同步修改两处：
1. IDE 快捷方式参数：`--remote-debugging-port=9223`
2. 设置中：`autoAccept.cdpPort: 9223`

### Q: 后台会话的按钮没有被点击

插件默认使用持久连接 + MutationObserver 模式，支持所有后台会话。如果发现有遗漏，请执行诊断命令查看 target 数量：

命令面板 → `Auto Accept: Explore Antigravity API (Debug)`

### Q: 如何查看插件的详细运行日志？

- 命令面板 → `Auto Accept: Show Log`  
- 或将 `autoAccept.logLevel` 改为 `"debug"` 获取更多信息

### Q: 这样做安全吗？

> [!WARNING]
> - CDP 调试端口仅绑定 `127.0.0.1`（本机），外部无法访问
> - 但本机其他进程理论上可以连接此端口，请注意本地安全环境
> - 不建议在公共网络或不受信任的环境中使用

---

## 📁 项目结构（扩展目录）

```
extension/
├── src/
│   ├── extension.ts          # 入口：注册命令、初始化各模块
│   ├── auto-acceptor.ts      # 核心逻辑：SDK信号 + CDP执行
│   ├── cdp-target-manager.ts # CDP连接管理 & DOM扫描
│   ├── cdp-smart-retry.ts    # Smart Retry 逻辑
│   ├── cdp-renamer.ts        # 会话重命名功能
│   ├── webview-provider.ts   # Dashboard WebView 面板
│   ├── mcp-manager.ts        # MCP Server 管理
│   ├── config.ts             # 配置读取与变更监听
│   ├── statusbar.ts          # 状态栏管理
│   ├── logger.ts             # 日志输出
│   └── event-bus.ts          # 内部事件总线
├── package.json              # 插件清单（命令、配置、视图声明）
└── esbuild.js                # 构建脚本
```
