# 架构设计文档：Auto-Accept + MCP 一体化

> **版本**: v3.0 | **日期**: 2026-03-24 | **基于**: [prd-integration.md](./prd-integration.md) + `auto-accept.js` 全量分析

---

## 1. 设计原则

> **一个 VSIX，零配置，开箱即用。所有 `auto-accept.js` 功能 + MCP Server 全部内置。**

| 原则 | 说明 |
|------|------|
| 功能完整 | `auto-accept.js` 的全部 6 类功能迁移到插件中 |
| 一次安装 | Auto-Accept + MCP Server 全部就绪 |
| 零手动配置 | `mcp_config.json` 自动写入 |
| 优雅降级 | MCP 启动失败不影响核心功能 |

---

## 2. auto-accept.js 完整功能清单

> 以下是 `auto-accept.js`（1553行）的 **全部功能**，标注了当前插件 v2.0.0 的迁移状态。

| # | 功能 | 代码位置 | v2.0.0 状态 | 说明 |
|---|------|----------|-------------|------|
| 1 | **按钮自动点击** | L135-277 | ✅ 已迁移 | MutationObserver + fallback 扫描 |
| 2 | **会话重命名** | L278-440 | ❌ 未迁移 | Manager Target 注入双击编辑 + JSON 持久化 |
| 3 | **Workspace 重命名** | L593-779 | ❌ 未迁移 | 同上，针对 Workspace 区域 |
| 4 | **Smart Retry** | L449-559 | ✅ 已迁移 | debug info + 模型切换 + Retry + 切回 + 发消息 |
| 5 | **CDP 消息发送** | L564-591 | ⚠️ 部分 | `sendMessageViaCDP` 通过 Input API 发聊天消息 |
| 6 | **持久连接管理** | L785-1318 | ⚠️ 不同架构 | v2.0.0 用短连接方案C，原版用持久连接 |

### 2.1 会话重命名（Session Renamer）详细逻辑

```
1. 在 Manager Target 中注入脚本
2. 查找所有 [data-testid^="convo-pill-"] 的 span
3. 根据 session-names.json 映射，替换显示名称（前缀 ✏️）
4. 为每个 span 绑定 dblclick 事件 → 原地变 input 编辑
5. 编辑完成后通过 Runtime.addBinding('__saveSessionName') 回调 Node.js
6. Node.js 持久化到 session-names.json
7. MutationObserver 监听虚拟滚动引起的 DOM 重建，自动重新应用
```

### 2.2 Workspace 重命名（Workspace Renamer）详细逻辑

```
1. 定位 "Workspaces" 文字所在的 section
2. 查找 span.text-sm.font-medium.truncate
3. 为同名 workspace 生成唯一 key（name#index）
4. 其余逻辑与会话重命名相同：显示替换 + 双击编辑 + binding 回调 + JSON 持久化
5. 持久化到 workspace-names.json
```

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│ Antigravity IDE                                                     │
│                                                                     │
│  ┌─ Extension Host ─────────────────────────────────────────────┐   │
│  │ Auto-Accept 插件                                             │   │
│  │                                                              │   │
│  │  ┌─ 核心层 ──────────────────────────────────────────────┐   │   │
│  │  │ AutoAcceptor (生命周期管理)                            │   │   │
│  │  │  ├── CDPTargetManager (短连接 CDP 扫描)               │   │   │
│  │  │  ├── CDPSmartRetry (错误恢复 + 模型切换)              │   │   │
│  │  │  ├── CDPRenamer [NEW] (会话+Workspace 重命名)         │   │   │
│  │  │  └── EventBus [NEW] (事件总线) ─────────────┐        │   │   │
│  │  └─────────────────────────────────────────────│────────┘   │   │
│  │                                                │            │   │
│  │  ┌─ UI 层 ────────────────────────────────────│────────┐   │   │
│  │  │ StatusBarManager (状态栏)                   │        │   │   │
│  │  │ DashboardViewProvider [NEW] (WebView) ◄─────┘        │   │   │
│  │  │    └── postMessage ↔ dashboard.html                  │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  │                                                              │   │
│  │  ┌─ MCP 管理层 [NEW] ────────────────────────────────────┐ │   │
│  │  │ McpManager                                             │ │   │
│  │  │  ├── spawn('node', ['mcp-server.mjs'])                 │ │   │
│  │  │  ├── 自动写入 mcp_config.json                          │ │   │
│  │  │  └── 生命周期管理 (start/stop/restart)                 │ │   │
│  │  └────────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│    ↕ CDP (WebSocket)      ↕ postMessage          ↕ stdio            │
│  ┌──────────────┐  ┌──────────────────────┐  ┌─────────────────┐   │
│  │Agent Panel   │  │WebView Dashboard     │  │MCP Server       │   │
│  │Run / Accept  │  │状态+统计+控制+重命名  │  │(内置子进程)      │   │
│  │              │  │                      │  │                 │   │
│  │Manager Panel │  └──────────────────────┘  └─────────────────┘   │
│  │会话 / WS列表 │                                    │             │
│  └──────────────┘                               stdio│             │
│                                                      ▼             │
│                                         Antigravity MCP Client     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. 模块设计

### 4.1 CDPRenamer — 重命名管理器（新增）

从 `auto-accept.js` L278-779 提取，负责会话和 Workspace 的重命名功能。

```typescript
// src/cdp-renamer.ts

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';

interface NameEntry {
  name: string;
  original: string;
}

export class CDPRenamer {
  private sessionNames: Record<string, NameEntry> = {};
  private workspaceNames: Record<string, NameEntry> = {};
  private storagePath: string;
  private logger: Logger;

  constructor(storagePath: string, logger: Logger) {
    this.storagePath = storagePath;
    this.logger = logger;
    this.loadAll();
  }

  // ── 持久化 ──

  private get sessionNamesPath() { return join(this.storagePath, 'session-names.json'); }
  private get workspaceNamesPath() { return join(this.storagePath, 'workspace-names.json'); }

  private loadAll(): void {
    this.sessionNames = this.loadJson(this.sessionNamesPath);
    this.workspaceNames = this.loadJson(this.workspaceNamesPath);
  }

  private loadJson(path: string): Record<string, NameEntry> {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}; }
    catch { return {}; }
  }

  saveSessionName(uuid: string, name: string, original?: string): void {
    if (name?.trim()) {
      this.sessionNames[uuid] = { name: name.trim(), original: original || '' };
    } else {
      delete this.sessionNames[uuid];
    }
    writeFileSync(this.sessionNamesPath, JSON.stringify(this.sessionNames, null, 2));
    this.logger.info(`📝 会话名称已保存: ${uuid.substring(0, 8)}... → "${name}"`);
  }

  saveWorkspaceName(key: string, name: string, original?: string): void {
    if (name?.trim()) {
      this.workspaceNames[key] = { name: name.trim(), original: original || '' };
    } else {
      delete this.workspaceNames[key];
    }
    writeFileSync(this.workspaceNamesPath, JSON.stringify(this.workspaceNames, null, 2));
    this.logger.info(`📝 Workspace 名称已保存: "${key}" → "${name}"`);
  }

  // ── 注入到 Manager Target ──

  /**
   * 在 CDPTargetManager.scanTarget() 中，当 target.title === 'Manager' 时调用
   * 注入会话重命名 + Workspace 重命名脚本
   */
  async injectToManager(client: any): Promise<boolean> {
    const { Runtime } = client;

    // 1. 注册 binding 回调
    try { await Runtime.addBinding({ name: '__saveSessionName' }); } catch { }
    try { await Runtime.addBinding({ name: '__saveWorkspaceName' }); } catch { }

    Runtime.bindingCalled(({ name, payload }: { name: string, payload: string }) => {
      try {
        const data = JSON.parse(payload);
        if (name === '__saveSessionName') {
          this.saveSessionName(data.uuid, data.name, data.original);
        } else if (name === '__saveWorkspaceName') {
          this.saveWorkspaceName(data.key, data.name, data.original);
        }
      } catch (e) {
        this.logger.error(`保存名称失败: ${e}`);
      }
    });

    // 2. 注入会话重命名脚本
    await Runtime.evaluate({
      expression: this.buildSessionRenamerScript(),
      returnByValue: true, awaitPromise: false,
    });

    // 3. 注入 Workspace 重命名脚本
    await Runtime.evaluate({
      expression: this.buildWorkspaceRenamerScript(),
      returnByValue: true, awaitPromise: false,
    });

    this.logger.info('🏷️  重命名脚本已注入 Manager');
    return true;
  }

  /** 生成会话重命名注入脚本（直接复用 auto-accept.js L282-439 逻辑） */
  private buildSessionRenamerScript(): string {
    return `(() => { /* ... 从 auto-accept.js 移植 ... */ })()`;
  }

  /** 生成 Workspace 重命名注入脚本（复用 auto-accept.js L597-778） */
  private buildWorkspaceRenamerScript(): string {
    return `(() => { /* ... 从 auto-accept.js 移植 ... */ })()`;
  }
}
```

**关键设计**：
- `session-names.json` / `workspace-names.json` 存放在 `globalStorageUri`（VS Code 全局存储目录），插件卸载后数据不丢失
- CDP binding 回调直接在 Extension Host 进程中执行 JSON 读写，与原版逻辑一致
- 注入脚本保持与 `auto-accept.js` 完全相同的 DOM 查询逻辑（`data-testid`、`span.text-sm` 等）

### 4.2 CDPTargetManager — 改造：Manager Target 识别

```diff
// src/cdp-target-manager.ts

+ import { CDPRenamer } from './cdp-renamer';

  constructor(config, logger, statusBar, eventBus, renamer: CDPRenamer) {
+   this.renamer = renamer;
  }

  private async scanTarget(targetInfo): Promise<number> {
    const client = await CDP({ target: targetInfo, port });
    const { Runtime } = client;
    await Runtime.enable();

+   // Manager Target: 注入重命名脚本
+   if (targetInfo.title === 'Manager') {
+     try {
+       await this.renamer.injectToManager(client);
+     } catch (e) {
+       this.logger.debug(`重命名注入失败: ${e}`);
+     }
+   }

    // 执行按钮检测脚本
    const result = await Runtime.evaluate(...);
    ...
  }
```

### 4.3 EventBus — 事件总线（新增）

```typescript
// src/event-bus.ts

import { EventEmitter } from 'events';

export interface ClickEvent {
  button: string;
  target: string;
  timestamp: number;
}

export interface RetryEvent {
  errorCode: number | null;
  model: string;
  success: boolean;
  timestamp: number;
}

export interface StatusEvent {
  connected: boolean;
  targetCount: number;
}

export class EventBus extends EventEmitter {
  emitClick(e: ClickEvent)   { this.emit('click', e); }
  emitRetry(e: RetryEvent)   { this.emit('retry', e); }
  emitStatus(e: StatusEvent) { this.emit('status', e); }

  onClick(fn: (e: ClickEvent) => void)   { this.on('click', fn); }
  onRetry(fn: (e: RetryEvent) => void)   { this.on('retry', fn); }
  onStatus(fn: (e: StatusEvent) => void) { this.on('status', fn); }
}
```

### 4.4 McpManager — MCP 进程管理（新增）

```typescript
// src/mcp-manager.ts

export class McpManager {
  private process: ChildProcess | null = null;

  constructor(private extensionPath: string, private logger: Logger) {}

  async start(): Promise<boolean> {
    this.ensureMcpConfig();
    const serverPath = join(this.extensionPath, 'dist', 'mcp-server.mjs');
    this.process = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    this.process.stderr?.on('data', (d: Buffer) => this.logger.info(`[MCP] ${d.toString().trim()}`));
    this.process.on('exit', (code) => { this.process = null; });
    return true;
  }

  stop(): void { this.process?.kill(); this.process = null; }

  /** 自动写入 ~/.gemini/antigravity/mcp_config.json */
  private ensureMcpConfig(): void {
    const configDir = join(process.env.USERPROFILE || '', '.gemini', 'antigravity');
    const configPath = join(configDir, 'mcp_config.json');
    const serverPath = join(this.extensionPath, 'dist', 'mcp-server.mjs');

    let config: any = { mcpServers: {} };
    if (existsSync(configPath)) {
      try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { }
    }
    if (!config.mcpServers) config.mcpServers = {};

    const existing = config.mcpServers['local-assistant'];
    if (existing?.command === 'node' && existing?.args?.[0] === serverPath) return;

    config.mcpServers['local-assistant'] = { command: 'node', args: [serverPath], env: {} };
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    this.logger.info(`[MCP] 已自动更新 ${configPath}`);
  }
}
```

### 4.5 DashboardViewProvider — WebView 管理（新增）

```typescript
// src/webview-provider.ts

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'autoAccept.dashboard';
  private view?: vscode.WebviewView;
  private history: Array<ClickEvent | RetryEvent> = [];

  constructor(private extensionUri: vscode.Uri, private eventBus: EventBus) {
    eventBus.onClick(e => this.pushAndPost('click', e));
    eventBus.onRetry(e => this.pushAndPost('retry', e));
    eventBus.onStatus(e => this.post('status', e));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.loadHtml();
    view.webview.onDidReceiveMessage(msg =>
      vscode.commands.executeCommand(`autoAccept.${msg.command}`)
    );
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post('fullState', { history: this.history });
    });
  }

  private pushAndPost(type: string, event: any): void {
    this.history.push(event);
    if (this.history.length > 100) this.history.shift();
    this.post(type, event);
  }

  private post(type: string, data: any): void {
    this.view?.webview.postMessage({ type, data });
  }
}
```

**WebView 消息协议**：

| 方向 | type/command | 说明 |
|------|-------------|------|
| Ext→WV | `click` | 自动点击事件 |
| Ext→WV | `retry` | Smart Retry 事件 |
| Ext→WV | `status` | CDP 连接状态 |
| Ext→WV | `fullState` | 完整快照（首次可见） |
| WV→Ext | `toggle` | 暂停/恢复 |
| WV→Ext | `showLog` | 打开日志 |
| WV→Ext | `resetCount` | 重置计数 |

---

## 5. extension.ts 组装

```typescript
export async function activate(context: vscode.ExtensionContext) {
  const logger = new Logger();
  const config = new Config();

  // 1. 事件总线
  const eventBus = new EventBus();

  // 2. 重命名管理器（数据存 globalStorageUri）
  const storagePath = context.globalStorageUri.fsPath;
  mkdirSync(storagePath, { recursive: true });
  const renamer = new CDPRenamer(storagePath, logger);

  // 3. 核心 Auto-Accept
  const acceptor = new AutoAcceptor(config, logger, eventBus, renamer);

  // 4. WebView Dashboard
  const dashboard = new DashboardViewProvider(context.extensionUri, eventBus);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard)
  );

  // 5. MCP Server（内置，自动启动）
  const mcpManager = new McpManager(context.extensionPath, logger);
  await mcpManager.start(); // 失败不阻塞
  context.subscriptions.push({ dispose: () => mcpManager.stop() });

  // 6. 启动
  if (config.enabled) await acceptor.start();
}
```

---

## 6. 目录结构

```
extension/
├── src/
│   ├── extension.ts              # 入口：组装所有模块
│   ├── auto-acceptor.ts          # 核心控制器（改：接入 EventBus + Renamer）
│   ├── cdp-target-manager.ts     # CDP 扫描（改：Manager Target 注入重命名）
│   ├── cdp-smart-retry.ts        # Smart Retry（改：接入 EventBus）
│   ├── cdp-scripts.ts            # 按钮检测/Observer/Retry 注入脚本
│   ├── cdp-renamer.ts            # [NEW] 会话+Workspace 重命名
│   ├── event-bus.ts              # [NEW] 事件总线
│   ├── webview-provider.ts       # [NEW] WebView Dashboard
│   ├── mcp-manager.ts            # [NEW] MCP 进程管理
│   ├── config.ts
│   ├── statusbar.ts
│   └── logger.ts
├── mcp/                          # [NEW] MCP Server 源码（迁入）
│   ├── index.ts
│   ├── modules/
│   │   ├── task-hub.ts
│   │   ├── context-bridge.ts
│   │   ├── planner.ts
│   │   └── dashboard.ts          # 移除 spawn 逻辑
│   └── utils/storage.ts
├── webview/
│   └── dashboard.html            # [NEW] 侧边栏面板 HTML
├── esbuild.js                    # 改：双入口打包
└── package.json                  # 改：views + MCP 依赖
```

---

## 7. MCP 代码迁入

| 源（antigravity-local-mcp） | 目标 | 修改 |
|------|------|------|
| `src/index.ts` | `mcp/index.ts` | 移除 `startAutoAccept`/`stopAutoAccept` |
| `src/modules/task-hub.ts` | `mcp/modules/task-hub.ts` | 无改动 |
| `src/modules/context-bridge.ts` | `mcp/modules/context-bridge.ts` | 无改动 |
| `src/modules/planner.ts` | `mcp/modules/planner.ts` | 无改动 |
| `src/modules/dashboard.ts` | `mcp/modules/dashboard.ts` | 删除 spawn 相关 ~100行 |
| `src/utils/storage.ts` | `mcp/utils/storage.ts` | 无改动 |

**esbuild 双入口**：

```javascript
// 入口 1: dist/extension.js (CJS, external vscode)
// 入口 2: dist/mcp-server.mjs (ESM, 全部打包)
```

**新增依赖**：`@modelcontextprotocol/sdk` + `zod`（会被 esbuild 打包进 mjs）

---

## 8. auto-accept.js → 插件模块映射

| auto-accept.js 功能 | 目标模块 | 迁移方式 |
|---------------------|----------|----------|
| `buildDetectionScript()` L135-181 | `cdp-scripts.ts` | ✅ 已在 v2.0.0 中 |
| `buildObserverScript()` L187-277 | `cdp-scripts.ts` | ✅ 已在 v2.0.0 中 |
| `buildRenamerScript()` L282-439 | `cdp-renamer.ts` | **NEW** 完整移植 |
| `buildWorkspaceRenamerScript()` L597-778 | `cdp-renamer.ts` | **NEW** 完整移植 |
| `loadSessionNames/saveSessionName` L57-77 | `cdp-renamer.ts` | **NEW** 改用 globalStorageUri |
| `loadWorkspaceNames/saveWorkspaceName` L85-105 | `cdp-renamer.ts` | **NEW** 改用 globalStorageUri |
| `buildRetryDetectionScript()` L450-461 | `cdp-scripts.ts` | ✅ 已在 v2.0.0 中 |
| `buildReadDebugInfoScript()` L464-511 | `cdp-scripts.ts` | ✅ 已在 v2.0.0 中 |
| `buildSwitchModelScript()` L525-559 | `cdp-scripts.ts` | ✅ 已在 v2.0.0 中 |
| `buildClickRetryScript()` L514-522 | `cdp-scripts.ts` | ✅ 已在 v2.0.0 中 |
| `sendMessageViaCDP()` L564-591 | `cdp-smart-retry.ts` | ✅ 已在 v2.0.0 中 |
| `TargetManager.injectRenamer()` L1055-1128 | `cdp-renamer.ts` 被 `cdp-target-manager.ts` 调用 | **NEW** |
| `TargetManager.handleSmartRetry()` L1144-1270 | `cdp-smart-retry.ts` | ✅ 已在 v2.0.0 中 |
| `TargetManager.syncTargets()` L864-923 | `cdp-target-manager.ts` | ✅ 架构不同但功能等价 |

---

## 9. 实施顺序

| # | 任务 | 文件 | 工时 |
|---|------|------|------|
| 1 | 新增 `cdp-renamer.ts`（会话+WS 重命名） | `src/cdp-renamer.ts` | 40min |
| 2 | 新增 `event-bus.ts` | `src/event-bus.ts` | 10min |
| 3 | 新增 `webview-provider.ts` | `src/webview-provider.ts` | 20min |
| 4 | 新增 `webview/dashboard.html` | `webview/dashboard.html` | 30min |
| 5 | 新增 `mcp-manager.ts` | `src/mcp-manager.ts` | 20min |
| 6 | 复制 MCP 源码到 `mcp/` 并清理 | `mcp/*` | 20min |
| 7 | esbuild 双入口打包 | `esbuild.js` | 10min |
| 8 | 改 `cdp-target-manager.ts`：Manager 识别 + Renamer 注入 | `src/cdp-target-manager.ts` | 20min |
| 9 | 改 `cdp-smart-retry.ts`：EventBus 通知 | `src/cdp-smart-retry.ts` | 10min |
| 10 | 改 `auto-acceptor.ts`：组装 EventBus + Renamer | `src/auto-acceptor.ts` | 10min |
| 11 | 改 `extension.ts`：注册 WebView + McpManager | `src/extension.ts` | 10min |
| 12 | 改 `package.json`：views + 依赖 | `package.json` | 10min |
| 13 | 构建 + 打包验证 | — | 15min |

**预估总工时**：~3.5 小时

---

## 10. 验证清单

### 构建验证

```bash
npm run build     # dist/extension.js + dist/mcp-server.mjs
npm run lint      # TypeScript 零报错
npm run package   # VSIX 生成
```

### 功能验证

| # | 测试项 | 预期 |
|---|--------|------|
| 1 | 安装 VSIX | 侧边栏出现 🤖 Auto Accept |
| 2 | 触发 Agent 确认 | 自动点击 + WebView 统计 +1 |
| 3 | 双击会话标题 | 弹出 input 可编辑，保存后显示 ✏️ 前缀 |
| 4 | 双击 Workspace 名称 | 同上，显示 📂 前缀 |
| 5 | 关闭 IDE 重启 | 重命名数据持久化，恢复显示 |
| 6 | Smart Retry 触发 | 模型切换 + Retry + 切回 |
| 7 | 查看 `mcp_config.json` | 自动新增 `local-assistant` |
| 8 | 对 AI 说"创建任务" | 成功调用 MCP `task_create` |
| 9 | WebView [⏸ 暂停] | Auto-Accept 停止 |
| 10 | MCP Server 崩溃 | 不影响 Auto-Accept 核心功能 |
