# Night Mode (夜间 AI 自动化) 端到端测试指南

本文档描述了如何针对“夜间 AI 自动化”功能（Night Pilot, Idle Detector, CDP Messenger 等模块）进行完整的端到端集成测试，涵盖了模式开关、消息传递、空闲检测、任务分派、额度熔断等所有关键场景。

## 概要说明
涉及的外围系统较多（VS Code 面板、CDP 接口、MCP 本地服务器），最高效的测试方式是通过运行 VS Code“Extension Development Host”来进行本地手工联合验证。

---

## 阶段 1：基础装配与启停测试

**验证目标**：主控类加载正常，能正确地根据时间或手动指令开关模式，并且日志能正常打印。

**测试步骤**：
1. **启动测试环境**：

   > **⚠️ 注意**：`F5` 调试必须满足两个前提：
   > 1. VS Code **当前工作区根目录**必须是 `extension/` 子目录（不是项目根目录）。
   > 2. `extension/.vscode/launch.json` 必须存在。

   **首次设置（只需做一次）：**

   **步骤 A**：在 `extension/` 目录下新建 `.vscode/launch.json`，内容如下：
   ```json
   {
     "version": "0.2.0",
     "configurations": [
       {
         "name": "Run Extension",
         "type": "extensionHost",
         "request": "launch",
         "args": [
           "--extensionDevelopmentPath=${workspaceFolder}"
         ],
         "outFiles": [
           "${workspaceFolder}/dist/**/*.js"
         ],
         "preLaunchTask": "npm: build"
       }
     ]
   }
   ```

   **步骤 B**：在 `extension/` 目录下新建 `.vscode/tasks.json`，用于在启动前自动构建：
   ```json
   {
     "version": "2.0.0",
     "tasks": [
       {
         "type": "npm",
         "script": "build",
         "group": "build",
         "label": "npm: build",
         "detail": "node esbuild.js"
       }
     ]
   }
   ```

   **步骤 C**：用 VS Code 打开 `extension/` 子目录：
   ```
   code d:\lzl\work\dev\Antigravity-Auto-Accept\extension
   ```
   > 也可以在 VS Code 中选择菜单 **文件 → 打开文件夹…** 并选择 `extension/` 目录。

   **步骤 D**：按 `F5`（或菜单 **运行 → 启动调试**），VS Code 会自动执行 `npm run build` 构建，然后弹出一个新的"Extension Development Host"窗口。
2. **命令测试**：
   在调试宿主中按 `Ctrl+Shift+P` 运行命令：`Auto Accept: Toggle Night Mode 🌙`。
3. **日志查验**：
   - 打开下方的“输出” (Output) 面板，切换至 `Auto Accept` 频道。
   - 验证日志是否打印了启动参数配置，并输出了：`🌙 模式变更: off → standby`（如果未打开任何 Agent 会话）。
   - 打开一个带有 Agent 的对话面板，确认模式是否自动切入 `active` 状态（说明已监听到 CDP 连接）。
4. **生成晨间报告测试**：
   - 再次运行 `Auto Accept: Toggle Night Mode 🌙` 命令关闭夜间模式。
   - 此时应该能够在控制台看到夜间工作的总览数据（时长、处理任务均应为 0）。
   - 运行命令 `Auto Accept: Night Mode Report 🌅` 检查是否成功强行唤起最后生成的 `night-report-xxxx.md` 文件预览。

---

## 阶段 2：CDP 消息信使验证 (CDPMessenger)

**验证目标**：保证系统新添加的 CDP 输入流程能够精确定位到 Agent 输入框、清空残留字段并成功敲下回车发车。

**测试步骤**：
1. 随意点开一条历史 Agent 对话，并保证它处于等待用户输入的空闲态。
2. 在底部的 `contenteditable` 文本框里随意敲入乱码但不回车，如 `asdgasf9723#`。
3. **临时触发逻辑**（用于快速验证）： 
   在代码 `src/night-pilot.ts` 的 `activate()` 方法末尾插入：
   ```typescript
   setTimeout(() => this.messenger.sendMessage('当前面板的TargetID', '这是一条测试用的自动化消息'), 5000);
   ```
4. 开始调试并启动夜间模式，5秒到达时，观察：
   - 输入框的乱码被无缝清空（利用了对 `a` 和 `Backspace` 的按键模拟）。
   - 瞬间填入 `这是一条测试用的自动化消息`。
   - 自动模拟了 `Enter` 按键并成功发出了该条消息。

---

## 阶段 3：双重空闲挂起判定验证 (IdleDetector)

**验证目标**：测试其是否能准确抛出 `onIdle` 事件，以及它的 15秒常规监控 + 30秒复查防呆机制是否有用。

**测试步骤（预备）**：
为了不漫长等待，可以在 VS Code `Settings` 中临时将 `Auto Accept: Night Mode Idle Threshold Seconds` (`autoAccept.nightMode.idleThresholdSeconds`) 下调至 `15` 秒。

1. 启动 `Night Mode` 并挂载好一个 Agent 对话保持 `active` 模式。
2. **正常空闲触发路径**：
   - 不操作 Agent 键盘和鼠标，静置。
   - 观察控制台，15秒时出现：`💤 可能空闲: <面板Title> (等待确认...)`。
   - 维持静置至双重确认倒计时结束（默认额外等待 30 秒）。
   - 控制台出现判定：`😴 会话已空闲: <面板Title> (空闲 30s)`。
3. **人机冲突打断路径**：
   - 在触发 `💤 可能空闲` 日志后，立即在 Agent 流中人工点击任意区域，或者直接发消息。
   - 此时应该出现日志：`✅ 会话活跃: <面板Title> (清除 pending)`。且在 30 秒期限满时**不应该**触发已空闲事件。

---

## 阶段 4：MCP 任务分配闭环测试 (TaskDispatcher)

**验证目标**：确认与 Local Assistant Server (Task Hub) 的通道顺畅，空闲时能将新任务推向浏览器控制台。

**测试步骤**：
1. 前置条件：本地启动 Local Assistant MCP Server 工具栈。在 Task Hub 里准备 2 个带有 `night-safe` 标签且处于 `todo` 状态的任务记录。
2. 启动 `Night Mode` -> `active`。
3. 把 Agent 对话框空置在一旁，触发完整的阶段 3 空闲探测。
4. **链路流转观察**：
   - 触发空闲后，控制台应该打印调用：`mcp_local-assistant_plan_next_task` 获取到当前可进行的最高优先级任务。
   - 系统生成 Prompt 并在日志输出：`🚀 任务已派发: "某某任务" -> 面板Title`。
   - 此时 `CDPMessenger` 执行动作，Prompt 直接推入 Agent 开始分析和打字。
   - 原先的空闲挂起被 `markBusy` 清理，系统重新回到活跃关注状态。
5. **串行排队**：
   - 让它自行发酵处理完 Task 1 -> 触发空闲判定 -> 取出 Task 2 继续执行，以此达成夜间批处理流水线。

---

## 阶段 5：额度监控与熔断自愈 (QuotaTracker)

**验证目标**：当云端接口限制（Rate Limit/Quota）阻断了问答，系统是否能主动挂起并转入 `paused`，以及解封后是否能回调 `active`。

**测试步骤**：
1. **强制熔断模拟**：由于很难真地耗光数千万的额度，可以直接修改 `src/cdp-scripts.ts`。
   找到 `buildQuotaExhaustionDetectionScript` 临时改为：`return { hasRateLimit: true };` 并保存。
   为了迅速观察，可以把 `NightPilot.startQuotaMonitor` 的定时间隔由 `5 * 60 * 1000` 改为 `10 * 1000`（10秒）。
2. **观察熔断暂停**：
   10秒后引擎捕捉到拦截，应抛出：`⚠️ 检测到额度可能耗尽，暂停任务派发`。
   控制台输出模式变更：`🌙 模式变更: active -> paused`。此时无论处于何种空闲状态，绝对不再派发任何下文任务。
3. **观察解封自愈**：
   把刚才临时修改的 `hasRateLimit: true` 删除，恢复原生判定。
   经过又一次 10 秒轮询后，拦截警报解除，应该抛出：`🔋 额度已刷新，恢复任务派发`，并打出日志：`🌙 模式变更: paused -> active`。
