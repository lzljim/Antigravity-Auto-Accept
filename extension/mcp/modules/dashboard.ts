import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch, FSWatcher, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readAllJSON, readJSON, writeJSON, PATHS } from '../utils/storage.js';

// ─── 数据结构（与其他模块保持一致） ─────────────────────────────

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  tags: string[];
  dependsOn: string[];
  estimatedMinutes: number;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  actualMinutes?: number;
  workspace?: string;
  subtasks?: { title: string; estimatedMinutes: number; done: boolean }[];
  blockedBy?: string;
  blockedReason?: string;
  blockedAt?: string;
}

interface DaySchedule {
  id: string;
  weekId: string;
  slots: { taskId: string; taskTitle: string; estimatedMinutes: number; batchIndex: number; priority: string; status: string }[];
  parallelCapacity: number;
  totalMinutes: number;
  notes: string;
}

interface WeekPlan {
  id: string;
  weekLabel: string;
  goals: string[];
  taskIds: string[];
  notes: string;
}

// ─── SSE 客户端管理 ─────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

function broadcastSSE(data: unknown): void {
  const payload = `event: update\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ─── Auto-Accept 日志缓冲区 ─────────────────────────────────

interface LogEntry {
  time: string;
  text: string;
  type: 'stdout' | 'stderr' | 'system';
}

const MAX_LOG_ENTRIES = 200;
const autoAcceptLogs: LogEntry[] = [];

export function pushAutoAcceptLog(text: string, type: LogEntry['type'] = 'stdout'): void {
  const entry: LogEntry = { time: new Date().toISOString(), text: text.trim(), type };
  autoAcceptLogs.push(entry);
  if (autoAcceptLogs.length > MAX_LOG_ENTRIES) {
    autoAcceptLogs.splice(0, autoAcceptLogs.length - MAX_LOG_ENTRIES);
  }
  // SSE 推送日志事件
  const payload = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// 注意：Auto-Accept 进程管理已迁入 VS Code 插件内部（McpManager）

// ─── 会话状态追踪 ─────────────────────────────────────────────

interface Session {
  id: string;
  name: string;
  taskId?: string;
  taskTitle?: string;
  status: 'working' | 'idle' | 'done';
  description?: string;
  lastSeen: string;
  startedAt: string;
}

const activeSessions = new Map<string, Session>();

export function reportSession(
  id: string, name: string,
  status: Session['status'],
  taskId?: string, taskTitle?: string, description?: string,
): Session {
  const existing = activeSessions.get(id);
  const session: Session = {
    id, name, status, taskId, taskTitle, description,
    lastSeen: new Date().toISOString(),
    startedAt: existing?.startedAt || new Date().toISOString(),
  };
  if (status === 'done') {
    activeSessions.delete(id);
  } else {
    activeSessions.set(id, session);
  }
  broadcastSessions();
  return session;
}

export function getActiveSessions(): Session[] {
  // 过滤掉超过 30 分钟无心跳的会话
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of activeSessions) {
    if (new Date(s.lastSeen).getTime() < cutoff) activeSessions.delete(id);
  }
  return [...activeSessions.values()];
}

function broadcastSessions(): void {
  const sessions = getActiveSessions();
  const payload = `event: sessions\ndata: ${JSON.stringify(sessions)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ─── 数据加载 ─────────────────────────────────────────────

function getWeekDates(refDate: Date): { monday: Date; dates: string[] } {
  const d = new Date(refDate);
  const dayNum = d.getDay() || 7; // 1=Mon ... 7=Sun
  const monday = new Date(d);
  monday.setDate(d.getDate() - dayNum + 1);
  monday.setHours(12, 0, 0, 0); // 避免 DST 边界问题
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    // 用本地日期格式，避免 toISOString() 的 UTC 偏移问题
    const y = dd.getFullYear();
    const m = String(dd.getMonth() + 1).padStart(2, '0');
    const day = String(dd.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }
  return { monday, dates };
}

async function loadAllData() {
  const tasks = await readAllJSON<Task>(PATHS.tasks);

  // 今日排程
  const today = new Date().toISOString().slice(0, 10);
  const schedule = await readJSON<DaySchedule>(join(PATHS.plans, 'daily', `${today}.json`));

  // 本周每日排程（周一到周日）
  const { dates: weekDates } = getWeekDates(new Date());
  const weekSchedules: Record<string, DaySchedule | null> = {};
  for (const date of weekDates) {
    weekSchedules[date] = await readJSON<DaySchedule>(join(PATHS.plans, 'daily', `${date}.json`));
  }

  // 本周计划
  const d = new Date();
  const dayNum = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const wid = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  const weekPlan = await readJSON<WeekPlan>(join(PATHS.plans, 'weekly', `${wid}.json`));

  return { tasks, schedule, weekPlan, weekSchedules, weekDates };
}

// ─── 提示词生成 ─────────────────────────────────────────

function generateTaskPrompt(task: Task, allTasks: Task[]): string {
  const lines: string[] = [];

  lines.push(`# 任务：${task.title}`);
  lines.push('');
  lines.push('## 目标');
  lines.push(task.description || `完成 ${task.title} 的开发工作`);
  lines.push('');

  // 子任务步骤
  if (task.subtasks && task.subtasks.length > 0) {
    lines.push('## 执行步骤');
    task.subtasks.forEach((st, i) => {
      lines.push(`${i + 1}. ${st.title} (约${st.estimatedMinutes}min)`);
    });
    lines.push('');
  }

  // 前置依赖
  if (task.dependsOn && task.dependsOn.length > 0) {
    const depNames = task.dependsOn
      .map(d => allTasks.find(t => t.id === d)?.title || d)
      .join(', ');
    lines.push('## 前置上下文');
    lines.push(`本任务依赖: ${depNames}（已完成）`);
    lines.push('请先用 context_get 获取前序任务的发现和上下文。');
    lines.push('');
  }

  lines.push('## 要求');
  lines.push('实现功能，代码完整可运行，包含错误处理');
  lines.push('');
  lines.push(`## 预估工时: ${task.estimatedMinutes} 分钟`);
  lines.push('');

  // 完成回调指令
  lines.push('## ⚙️ 任务管理（请务必执行）');
  lines.push(`- 完成后调用: task_update(id="${task.id}", status="done")`);
  lines.push(`- 有重要发现: 调用 context_share(key="${(task.workspace || 'task').replace(/\\s/g, '-')}-findings", content="...")`);
  lines.push(`- 中途遇到阻塞: 调用 task_block(id="${task.id}", blockedBy="说明")`);

  return lines.join('\n');
}

// ─── HTTP 服务器 ─────────────────────────────────────────

let httpServer: ReturnType<typeof createServer> | null = null;
let watchers: FSWatcher[] = [];

export async function startDashboard(port: number = DEFAULT_PORT): Promise<string> {
  if (httpServer) return `http://localhost:${port}`;

  const htmlPath = join(__dirname, '..', 'dashboard.html');

  httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/' || req.url === '/index.html') {
      try {
        const html = await readFile(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('Dashboard HTML not found');
      }
    } else if (req.url === '/api/data') {
      const data = await loadAllData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } else if (req.url === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(autoAcceptLogs));
    } else if (req.url === '/api/events') {
      // SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(':\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
    } else if (req.url?.startsWith('/api/prompt/')) {
      // 生成任务提示词
      const taskId = req.url.slice('/api/prompt/'.length);
      const task = await readJSON<Task>(join(PATHS.tasks, `${taskId}.json`));
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      const allTasks = await readAllJSON<Task>(PATHS.tasks);
      const prompt = generateTaskPrompt(task, allTasks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt, taskId: task.id, title: task.title }));
    } else if (req.url === '/api/action' && req.method === 'POST') {
      // 处理任务操作
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { taskId, action } = JSON.parse(body);
          const task = await readJSON<Task>(join(PATHS.tasks, `${taskId}.json`));
          if (!task) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Task not found' }));
            return;
          }
          let message = '';
          switch (action) {
            case 'start':
              task.status = 'in-progress';
              if (!task.startedAt) task.startedAt = new Date().toISOString();
              message = `任务 "${task.title}" 已开始`;
              break;
            case 'approve':
              task.status = 'done';
              task.completedAt = new Date().toISOString();
              task.progress = 100;
              message = `任务 "${task.title}" 已确认完成`;
              break;
            case 'reject':
              task.status = 'in-progress';
              task.progress = Math.min(task.progress, 80);
              message = `任务 "${task.title}" 已退回重做`;
              break;
            case 'skip':
              task.status = 'todo';
              message = `任务 "${task.title}" 已跳过`;
              break;
            default:
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Unknown action' }));
              return;
          }
          task.updatedAt = new Date().toISOString();
          await writeJSON(join(PATHS.tasks, `${taskId}.json`), task);
          // 触发 SSE 推送
          const data = await loadAllData();
          broadcastSSE(data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message, task }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
      });
      return; // 异步处理，不走下面的 404
    } else if (req.url === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getActiveSessions()));
    } else if (req.url === '/api/restart' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '正在重启...' }));
      setTimeout(() => {
        stopDashboard();
        process.exit(75);
      }, 300);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  // 用 Promise 包装 listen，正确处理端口占用等错误
  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', (err: NodeJS.ErrnoException) => {
      httpServer = null;
      if (err.code === 'EADDRINUSE') {
        // 端口已被另一个 MCP 实例占用（通常是 Antigravity IDE 直接通过 stdio 启动的那个）
        // 静默复用，直接返回 URL，不报错也不退出
        resolve();
      } else {
        reject(err);
      }
    });
    httpServer!.listen(port, () => resolve());
  });

  // 监听 .mcp-data 变化并推送 SSE
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pushUpdate = async () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const data = await loadAllData();
        broadcastSSE(data);
      } catch { /* ignore */ }
    }, 300); // 300ms 防抖
  };

  // 监听 tasks 和 plans 目录
  try {
    const taskWatcher = watch(PATHS.tasks, { recursive: true }, pushUpdate);
    const planWatcher = watch(PATHS.plans, { recursive: true }, pushUpdate);
    watchers = [taskWatcher, planWatcher];
    process.on('exit', () => {
      watchers.forEach(w => w.close());
    });
  } catch {
    // fs.watch 不支持时回退到轮询
    setInterval(pushUpdate, 3000);
  }

  return `http://localhost:${port}`;
}

export function stopDashboard(): boolean {
  if (!httpServer) return false;

  // 关闭所有 SSE 连接
  for (const client of sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  sseClients.clear();

  // 关闭文件监听
  watchers.forEach(w => w.close());
  watchers = [];

  // 关闭 HTTP 服务器
  httpServer.close();
  httpServer = null;

  return true;
}

// ─── 注册模块 ─────────────────────────────────────────────

const DEFAULT_PORT = 3456;

export function registerDashboard(server: McpServer): void {

  // ── tool: session_report ──
  server.registerTool(
    'session_report',
    {
      title: '报告会话状态',
      description: [
        '向 Dashboard 报告当前 AI 会话的状态。',
        '建议在开始任务时调用 (status="working")，完成时调用 (status="done")。',
        '看板会实时展示所有活跃会话，方便用户掌握 AI 的工作动态。',
      ].join('\n'),
      inputSchema: z.object({
        sessionName: z.string().describe('会话名称或主题，如 "修复登录 Bug"、"重构数据层"'),
        status: z.enum(['working', 'idle', 'done']).default('working')
          .describe('working=正在工作, idle=空闲等待指令, done=工作结束'),
        taskId: z.string().optional().describe('当前正在处理的任务 ID'),
        description: z.string().optional().describe('当前正在做什么的简要描述'),
      }),
    },
    async ({ sessionName, status, taskId, description }) => {
      // 用 sessionName 作为 ID（同名会话会覆盖）
      const id = sessionName.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');

      // 如果有 taskId，自动拉取任务标题
      let taskTitle: string | undefined;
      if (taskId) {
        const task = await readJSON<Task>(join(PATHS.tasks, `${taskId}.json`));
        taskTitle = task?.title;
      }

      const session = reportSession(id, sessionName, status, taskId, taskTitle, description);

      const statusEmoji = { working: '🟢', idle: '🟡', done: '⚪' };
      const lines = [
        `${statusEmoji[status]} 会话已报告: **${sessionName}** (${status})`,
      ];
      if (taskTitle) lines.push(`📋 当前任务: ${taskTitle}`);
      if (description) lines.push(`📝 ${description}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );
}
