import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTaskHub } from './modules/task-hub.js';
import { registerContextBridge } from './modules/context-bridge.js';
import { registerPlanner } from './modules/planner.js';
import { registerDashboard, startDashboard, stopDashboard } from './modules/dashboard.js';
import { registerPromptVault } from './modules/prompt-vault.js';
import { ensureDir, PATHS } from './utils/storage.js';

// 确保数据目录存在
await ensureDir(PATHS.tasks);
await ensureDir(PATHS.contexts);
await ensureDir(PATHS.plans);

// 创建 MCP Server
const server = new McpServer({
  name: 'antigravity-local',
  version: '2.0.0',
});

// 注册各功能模块（顺序决定工具列表顺序）
registerDashboard(server);       // session_report 放最前
registerTaskHub(server);         // 任务管理核心
registerContextBridge(server);   // 跨会话共享
registerPromptVault(server);     // 提示词模板
await registerPlanner(server);   // 规划调度

// 使用 stdio 传输启动服务
const transport = new StdioServerTransport();
await server.connect(transport);

// 自动启动 Dashboard（HTTP 服务端）
try {
  const dashboardUrl = await startDashboard();
  process.stderr.write(`🚀 Dashboard 已自动启动: ${dashboardUrl}\n`);
} catch (e) {
  process.stderr.write(`⚠️ Dashboard 启动失败: ${e}\n`);
}

// 注意：Auto-Accept 不再由 MCP 管理，已迁入 VS Code 插件内部

// 优雅退出 — 关闭 Dashboard
async function gracefulShutdown() {
  stopDashboard();
  await server.close();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.stdin.on('end', gracefulShutdown);
