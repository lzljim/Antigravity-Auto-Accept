import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  readJSON, writeJSON, deleteJSON, readAllJSON,
  ensureDir, generateId, PATHS
} from '../utils/storage.js';
import { createTask } from './task-hub.js';

// ─── 数据结构 ─────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in-progress' | 'review' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'urgent';
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
  subtasks?: Subtask[];
  blockedBy?: string;
  blockedReason?: string;
  blockedAt?: string;
}

interface Subtask {
  title: string;
  estimatedMinutes: number;
  done: boolean;
}

interface WeekPlan {
  id: string;           // 格式: 2026-W12
  weekLabel: string;    // 如 "2026年第12周 (3/16–3/22)"
  goals: string[];      // 本周目标列表
  taskIds: string[];    // 关联的任务 ID
  notes: string;        // 备注
  createdAt: string;
  updatedAt: string;
}

interface DaySchedule {
  id: string;           // 格式: 2026-03-16
  weekId: string;       // 关联周计划
  slots: ScheduleSlot[];
  parallelCapacity: number;   // 并行槽位数
  totalMinutes: number;       // 当天总预计工时
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleSlot {
  taskId: string;
  taskTitle: string;
  estimatedMinutes: number;
  batchIndex: number;   // 第几批并行执行（DAG 层级）
  priority: string;
  status: string;
}

// ─── 提示词生成辅助 ─────────────────────────────────────────

/** 为一批任务生成提示词并写入独立 .md 文件，返回文件路径 */
async function generateBatchPromptsFile(tasks: Task[], date: string): Promise<string> {
  const promptLines: string[] = [
    `# 💬 第 1 批次任务提示词 (${date})`,
    '',
    `> 共 ${tasks.length} 个任务，以下提示词可直接复制到 Antigravity 新会话`,
    '',
  ];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const wsTag = t.workspace ? ` [${t.workspace}]` : '';
    promptLines.push(`---`, '');
    promptLines.push(`## ${i + 1}. ${t.title}${wsTag}`, '');
    promptLines.push('```');
    promptLines.push(`# 任务：${t.title}`);
    promptLines.push('');
    promptLines.push('## 目标');
    promptLines.push(t.description || `完成 ${t.title} 的开发工作`);
    promptLines.push('');
    if (t.subtasks && t.subtasks.length > 0) {
      promptLines.push('## 执行步骤');
      for (let si = 0; si < t.subtasks.length; si++) {
        promptLines.push(`${si + 1}. ${t.subtasks[si].title} (约${t.subtasks[si].estimatedMinutes}min)`);
      }
      promptLines.push('');
    }
    promptLines.push('## 要求');
    promptLines.push('实现功能，代码完整可运行，包含错误处理');
    promptLines.push('');
    promptLines.push(`## 预估工时: ${t.estimatedMinutes} 分钟`);
    promptLines.push('');
    promptLines.push('## ⚙️ 任务管理（请务必执行）');
    promptLines.push(`- 开始前: 调用 task_update(id="${t.id}", status="in-progress")`);
    promptLines.push(`- 完成后: 调用 task_update(id="${t.id}", status="done")`);
    promptLines.push(`- 有重要发现: 调用 context_share(key="${(t.workspace || 'task').replace(/\s/g, '-')}-findings", content="...")`);
    promptLines.push(`- 获取下一任务: 调用 plan_next_task(${t.workspace ? `workspace="${t.workspace}"` : ''})`);
    promptLines.push('```');
    promptLines.push('');
  }

  const filePath = join(PATHS.plans, `prompts-${date}.md`);
  await ensureDir(PATHS.plans);
  await writeFile(filePath, promptLines.join('\n'), 'utf-8');
  return filePath;
}

// ─── 辅助函数 ─────────────────────────────────────────────

function weekId(date: Date): string {
  // 计算 ISO week number
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function weekLabel(id: string): string {
  // 从 "2026-W12" 解析出友好标签
  const [year, w] = id.split('-W');
  const week = parseInt(w);
  // 找到该周的周一
  const jan4 = new Date(parseInt(year), 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1 + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${year}年第${week}周 (${fmt(monday)}–${fmt(sunday)})`;
}

function weekPlanPath(id: string): string {
  return join(PATHS.plans, 'weekly', `${id}.json`);
}

function daySchedulePath(id: string): string {
  return join(PATHS.plans, 'daily', `${id}.json`);
}

async function getAllTasks(): Promise<Task[]> {
  return readAllJSON<Task>(PATHS.tasks);
}

/** 拓扑排序，返回各层级（并行批次）的任务 ID 分组 */
function topoLevels(tasks: Task[]): string[][] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const taskSet = new Set(tasks.map(t => t.id));

  for (const t of tasks) {
    graph.set(t.id, []);
    inDegree.set(t.id, 0);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (taskSet.has(dep)) {
        graph.get(dep)!.push(t.id);
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
      }
    }
  }

  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const levels: string[][] = [];

  while (queue.length > 0) {
    const level = [...queue];
    levels.push(level);
    queue.length = 0;
    for (const id of level) {
      for (const next of graph.get(id) || []) {
        const nd = (inDegree.get(next) || 1) - 1;
        inDegree.set(next, nd);
        if (nd === 0) queue.push(next);
      }
    }
  }
  return levels;
}

// ─── 注册模块 ─────────────────────────────────────────────

export async function registerPlanner(server: McpServer): Promise<void> {
  // 确保目录存在
  await ensureDir(join(PATHS.plans, 'weekly'));
  await ensureDir(join(PATHS.plans, 'daily'));

  // ── tool: plan_week_create ──
  server.registerTool(
    'plan_week_create',
    {
      title: '创建/更新周计划',
      description: '创建或更新本周的工作计划，关联任务并设定目标',
      inputSchema: z.object({
        weekOffset: z.number().default(0).describe('相对于本周的偏移：0=本周, 1=下周, -1=上周'),
        goals: z.array(z.string()).default([]).describe('本周工作目标列表'),
        taskIds: z.array(z.string()).default([]).describe('关联到本周的任务 ID 列表（留空则自动关联所有 todo/in-progress 任务）'),
        notes: z.string().default('').describe('备注或说明'),
      }),
    },
    async ({ weekOffset, goals, taskIds, notes }) => {
      const now = new Date();
      now.setDate(now.getDate() + weekOffset * 7);
      const id = weekId(now);

      // 若未指定 taskIds，自动关联所有活跃任务
      let resolvedTaskIds = taskIds;
      if (resolvedTaskIds.length === 0) {
        const allTasks = await getAllTasks();
        resolvedTaskIds = allTasks
          .filter(t => t.status === 'todo' || t.status === 'in-progress')
          .map(t => t.id);
      }

      const existing = await readJSON<WeekPlan>(weekPlanPath(id));
      const plan: WeekPlan = {
        id,
        weekLabel: weekLabel(id),
        goals: goals.length > 0 ? goals : (existing?.goals || []),
        taskIds: resolvedTaskIds,
        notes: notes || existing?.notes || '',
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeJSON(weekPlanPath(id), plan);

      const action = existing ? '更新' : '创建';
      const taskCount = resolvedTaskIds.length;
      return {
        content: [{
          type: 'text',
          text: [
            `📅 周计划已${action}: **${plan.weekLabel}** (ID: ${id})`,
            `✅ 关联任务: ${taskCount} 个`,
            `🎯 本周目标:`,
            ...plan.goals.map(g => `  - ${g}`),
            plan.notes ? `\n📝 备注: ${plan.notes}` : '',
          ].filter(Boolean).join('\n'),
        }],
      };
    }
  );

  // ── tool: plan_week_get ──
  server.registerTool(
    'plan_week_get',
    {
      title: '查看周计划',
      description: '查看指定周的计划详情，包含关联任务的状态汇总',
      inputSchema: z.object({
        weekOffset: z.number().default(0).describe('0=本周, 1=下周, -1=上周'),
      }),
    },
    async ({ weekOffset }) => {
      const now = new Date();
      now.setDate(now.getDate() + weekOffset * 7);
      const id = weekId(now);
      const plan = await readJSON<WeekPlan>(weekPlanPath(id));

      if (!plan) {
        return {
          content: [{
            type: 'text',
            text: `📅 ${weekLabel(id)} 尚无计划\n\n💡 使用 plan_week_create 工具创建本周计划`,
          }],
        };
      }

      // 获取关联任务状态
      const allTasks = await getAllTasks();
      const taskMap = new Map(allTasks.map(t => [t.id, t]));
      const relatedTasks = plan.taskIds.map(id => taskMap.get(id)).filter(Boolean) as Task[];

      const byStatus = {
        done: relatedTasks.filter(t => t.status === 'done'),
        'in-progress': relatedTasks.filter(t => t.status === 'in-progress'),
        todo: relatedTasks.filter(t => t.status === 'todo'),
        blocked: relatedTasks.filter(t => t.status === 'blocked'),
      };
      const totalMin = relatedTasks.reduce((s, t) => s + t.estimatedMinutes, 0);
      const doneMin = byStatus.done.reduce((s, t) => s + t.estimatedMinutes, 0);
      const progressPct = totalMin > 0 ? Math.round(doneMin / totalMin * 100) : 0;

      const lines = [
        `📅 **${plan.weekLabel}**`,
        ``,
        `**整体进度**: ${progressPct}% (${doneMin}/${totalMin} 分钟)`,
        ``,
        `**本周目标**:`,
        ...plan.goals.map(g => `  - ${g}`),
        ``,
        `**任务状态**:`,
        `  ✅ 已完成 ${byStatus.done.length} 个`,
        `  🔄 进行中 ${byStatus['in-progress'].length} 个`,
        `  📋 待开始 ${byStatus.todo.length} 个`,
        `  🚫 阻塞中 ${byStatus.blocked.length} 个`,
      ];

      if (byStatus['in-progress'].length + byStatus.todo.length > 0) {
        lines.push('', '**待处理任务**:');
        for (const t of [...byStatus['in-progress'], ...byStatus.todo]) {
          lines.push(`  - [${t.status}] ${t.title} (${t.estimatedMinutes}min, ${t.priority}优先级)`);
        }
      }
      if (byStatus.blocked.length > 0) {
        lines.push('', '**阻塞任务** ⚠️:');
        for (const t of byStatus.blocked) {
          lines.push(`  - ${t.title}`);
        }
      }
      if (plan.notes) lines.push('', `📝 备注: ${plan.notes}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ── tool: plan_today_generate ──
  server.registerTool(
    'plan_today_generate',
    {
      title: '生成今日工作安排',
      description: [
        '根据任务 DAG 自动编排今天的工作时间线，考虑依赖关系和并行槽位。',
        '支持按工作空间分组调度：每个工作空间对应一个 git 分支，拥有独立的并行槽位和 DAG 排序。',
        '如不指定 workspaces 则回退到扁平模式（所有任务共享 parallelSlots）。',
      ].join('\n'),
      inputSchema: z.object({
        date: z.string().default('').describe('日期 YYYY-MM-DD，留空表示今天'),
        parallelSlots: z.number().default(2).describe('扁平模式的并行槽位数（未指定 workspaces 时生效）'),
        workspaces: z.array(z.object({
          name: z.string().describe('工作空间名称（与任务的 workspace 字段匹配）'),
          branch: z.string().default('').describe('git 分支名（可选，仅用于显示）'),
          slots: z.number().default(2).describe('该工作空间的并行槽位数'),
        })).default([]).describe('工作空间配置（AI 应根据任务的 workspace 字段自动分组）'),
        taskIds: z.array(z.string()).default([]).describe('指定任务 ID，留空则自动获取'),
        focusTag: z.string().default('').describe('只安排带有该标签的任务'),
      }),
    },
    async ({ date, parallelSlots, workspaces, taskIds, focusTag }) => {
      const today = date || new Date().toISOString().slice(0, 10);
      const todayWeekId = weekId(new Date(today + 'T12:00:00'));

      // 收集候选任务
      let candidateTasks: Task[];
      if (taskIds.length > 0) {
        const allTasks = await getAllTasks();
        const taskMap = new Map(allTasks.map(t => [t.id, t]));
        candidateTasks = taskIds.map(id => taskMap.get(id)).filter(Boolean) as Task[];
      } else {
        const weekPlan = await readJSON<WeekPlan>(weekPlanPath(todayWeekId));
        const allTasks = await getAllTasks();
        const activeTasks = allTasks.filter(t => t.status === 'todo' || t.status === 'in-progress');
        if (weekPlan) {
          const weekSet = new Set(weekPlan.taskIds);
          candidateTasks = activeTasks.filter(t => weekSet.has(t.id));
        } else {
          candidateTasks = activeTasks;
        }
      }
      if (focusTag) candidateTasks = candidateTasks.filter(t => t.tags.includes(focusTag));
      candidateTasks = candidateTasks.filter(t => t.status !== 'done');

      if (candidateTasks.length === 0) {
        return { content: [{ type: 'text', text: '🎉 今天没有待处理的任务！' }] };
      }

      const lines: string[] = [];
      const allSlots: ScheduleSlot[] = [];
      let grandTotalMin = 0;

      if (workspaces.length > 0) {
        // ── 工作空间模式 ──
        const totalSlots = workspaces.reduce((s, w) => s + w.slots, 0);
        lines.push(`🗓️ **${today} 工作安排** (${workspaces.length} 个工作空间, 共 ${totalSlots} 个并行槽位)`, '');

        // 按工作空间分组
        const wsNames = new Set(workspaces.map(w => w.name));
        const unassigned = candidateTasks.filter(t => !t.workspace || !wsNames.has(t.workspace));

        for (const ws of workspaces) {
          const wsTasks = candidateTasks.filter(t => t.workspace === ws.name);
          if (wsTasks.length === 0) {
            lines.push(`### 📂 ${ws.name}${ws.branch ? ` (${ws.branch})` : ''} — ${ws.slots} 并行`);
            lines.push('', '无待处理任务', '');
            continue;
          }

          // 工作空间内独立 DAG
          const levels = topoLevels(wsTasks);
          const taskMap = new Map(wsTasks.map(t => [t.id, t]));
          let wsTotalMin = 0;

          lines.push(`### 📂 ${ws.name}${ws.branch ? ` (${ws.branch})` : ''} — ${ws.slots} 并行`);
          lines.push('');

          for (let i = 0; i < levels.length; i++) {
            const levelTasks = levels[i].map(id => taskMap.get(id)).filter(Boolean) as Task[];
            const batchMax = Math.max(...levelTasks.map(t => t.estimatedMinutes));
            wsTotalMin += batchMax;

            lines.push(`**第 ${i + 1} 批次（约 ${batchMax} 分钟）**`);
            for (let s = 0; s < levelTasks.length; s += ws.slots) {
              const group = levelTasks.slice(s, s + ws.slots);
              for (let si = 0; si < group.length; si++) {
                const t = group[si];
                const icon = t.status === 'in-progress' ? '🔄' : '📋';
                lines.push(`  **槽位 ${si + 1}** ${icon} ${t.title} (${t.estimatedMinutes}min, ${t.priority})`);
                allSlots.push({
                  taskId: t.id, taskTitle: t.title,
                  estimatedMinutes: t.estimatedMinutes,
                  batchIndex: i, priority: t.priority, status: t.status,
                });
              }
            }
            lines.push('');
          }
          lines.push(`⏱️ 工作空间工时: ${wsTotalMin} 分钟 (${(wsTotalMin / 60).toFixed(1)}h)`);
          grandTotalMin = Math.max(grandTotalMin, wsTotalMin); // 工作空间并行，取最大值
          lines.push('');
        }

        // 未分配工作空间的任务
        if (unassigned.length > 0) {
          lines.push(`### ⚠️ 未分配工作空间的任务 (${unassigned.length} 个)`);
          for (const t of unassigned) {
            lines.push(`  - ${t.title} (workspace: ${t.workspace || '未设置'})`);
          }
          lines.push('');
          lines.push(`💡 使用 \`task_update\` 设置这些任务的 workspace 字段`);
          lines.push('');
        }

        // 跨工作空间依赖警告
        const allTaskMap = new Map(candidateTasks.map(t => [t.id, t]));
        const crossDeps: string[] = [];
        for (const t of candidateTasks) {
          if (!t.workspace) continue;
          for (const dep of t.dependsOn) {
            const depTask = allTaskMap.get(dep);
            if (depTask && depTask.workspace && depTask.workspace !== t.workspace) {
              crossDeps.push(`${t.title} [${t.workspace}] → 依赖 ${depTask.title} [${depTask.workspace}]`);
            }
          }
        }
        if (crossDeps.length > 0) {
          lines.push(`### ⚠️ 跨工作空间依赖警告`);
          for (const d of crossDeps) lines.push(`  - ${d}`);
          lines.push('', `建议将相互依赖的任务移到同一工作空间`);
          lines.push('');
        }
      } else {
        // ── 扁平模式（向后兼容）──
        lines.push(`🗓️ **${today} 工作安排** (${parallelSlots} 个并行槽位)`, '');
        const levels = topoLevels(candidateTasks);
        const taskMap = new Map(candidateTasks.map(t => [t.id, t]));

        for (let i = 0; i < levels.length; i++) {
          const levelTasks = levels[i].map(id => taskMap.get(id)).filter(Boolean) as Task[];
          const batchMax = Math.max(...levelTasks.map(t => t.estimatedMinutes));
          grandTotalMin += batchMax;
          lines.push(`### 第 ${i + 1} 批次（可并行，约 ${batchMax} 分钟）`);
          for (let s = 0; s < levelTasks.length; s += parallelSlots) {
            const group = levelTasks.slice(s, s + parallelSlots);
            lines.push('');
            for (let si = 0; si < group.length; si++) {
              const t = group[si];
              const icon = t.status === 'in-progress' ? '🔄' : '📋';
              const wsTag = t.workspace ? ` [${t.workspace}]` : '';
              lines.push(`  **槽位 ${si + 1}** ${icon} ${t.title}${wsTag} (${t.estimatedMinutes}min, ${t.priority})`);
              allSlots.push({
                taskId: t.id, taskTitle: t.title,
                estimatedMinutes: t.estimatedMinutes,
                batchIndex: i, priority: t.priority, status: t.status,
              });
            }
          }
          lines.push('');
        }
      }

      lines.push(`---`);
      lines.push(`⏱️ **今日总预计工时**: ${grandTotalMin} 分钟 (${(grandTotalMin / 60).toFixed(1)} 小时)`);
      lines.push(`📊 **任务数**: ${candidateTasks.length} 个`);

      // 持久化
      const schedule: DaySchedule = {
        id: today, weekId: todayWeekId, slots: allSlots,
        parallelCapacity: workspaces.length > 0 ? workspaces.reduce((s, w) => s + w.slots, 0) : parallelSlots,
        totalMinutes: grandTotalMin, notes: workspaces.length > 0 ? `workspaces: ${workspaces.map(w => w.name).join(', ')}` : '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeJSON(daySchedulePath(today), schedule);

      // 自动为第一批次任务生成提示词并写入文件
      const batch0Tasks = allSlots
        .filter(s => s.batchIndex === 0)
        .map(s => candidateTasks.find(t => t.id === s.taskId))
        .filter(Boolean) as Task[];

      if (batch0Tasks.length > 0) {
        const promptFile = await generateBatchPromptsFile(batch0Tasks, today);
        lines.push('', '---', '');
        lines.push(`💬 **第 1 批次提示词已生成** (${batch0Tasks.length} 个): \`${promptFile}\``);
        lines.push('');
        lines.push('💡 请打开上述文件查看可复制的提示词');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ── tool: plan_prompts_generate ──
  server.registerTool(
    'plan_prompts_generate',
    {
      title: '为任务批量生成 AI 提示词',
      description: '为 Task Hub 中的指定任务批量生成结构化 AI 编码提示词，可直接复制到 Antigravity 新会话',
      inputSchema: z.object({
        taskIds: z.array(z.string()).default([]).describe('要生成提示词的任务 ID 列表，留空则使用今日安排'),
        promptStyle: z.enum(['coding', 'review', 'analysis', 'refactoring']).default('coding')
          .describe('提示词风格：coding=新功能开发, review=代码审查, analysis=分析调研, refactoring=重构'),
        extraContext: z.string().default('').describe('额外的背景信息（项目名、技术栈等）'),
      }),
    },
    async ({ taskIds, promptStyle, extraContext }) => {
      let tasks: Task[];
      const allTasks = await getAllTasks();
      const taskMap = new Map(allTasks.map(t => [t.id, t]));

      if (taskIds.length > 0) {
        tasks = taskIds.map(id => taskMap.get(id)).filter(Boolean) as Task[];
      } else {
        // 读取今日安排
        const today = new Date().toISOString().slice(0, 10);
        const schedule = await readJSON<DaySchedule>(daySchedulePath(today));
        if (schedule) {
          tasks = schedule.slots.map(s => taskMap.get(s.taskId)).filter(Boolean) as Task[];
        } else {
          tasks = allTasks.filter(t => t.status === 'todo' || t.status === 'in-progress');
        }
      }

      if (tasks.length === 0) {
        return { content: [{ type: 'text', text: '❌ 没有找到要生成提示词的任务' }] };
      }

      const styleGuide: Record<string, string> = {
        coding: '实现功能，要求代码完整可运行，包含错误处理和单元测试',
        review: '审查代码质量、性能、安全性，给出改进建议',
        analysis: '调研技术方案，对比优劣，给出推荐方案和理由',
        refactoring: '重构代码，保持功能不变，提升可读性和可维护性',
      };

      // 生成提示词写入文件
      const fileLines: string[] = [
        `# 📝 AI 提示词 (${tasks.length} 个任务, 风格: ${promptStyle})`,
        '',
        '> 以下提示词可直接复制粘贴到 Antigravity 新会话中',
        '',
      ];

      const summaryItems: string[] = [];

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const depNames = t.dependsOn
          .map(dep => taskMap.get(dep)?.title || dep)
          .join(', ');

        const prompt = [
          `# 任务: ${t.title}`,
          '',
          `## 背景`,
          extraContext || '（请根据实际项目情况补充）',
          '',
          `## 目标`,
          t.description || t.title,
          '',
          `## 要求`,
          styleGuide[promptStyle],
          '',
          `## 约束`,
          `- 优先级: ${t.priority}`,
          `- 预估工时: ${t.estimatedMinutes} 分钟`,
          depNames ? `- 前置完成: ${depNames}` : '',
          '',
          `## 验收标准`,
          `- [ ] 功能正确实现`,
          `- [ ] 代码通过 TypeScript 类型检查`,
          `- [ ] 边界情况已处理`,
        ].filter(l => l !== null).join('\n');

        fileLines.push('---', '');
        fileLines.push(`## 任务 ${i + 1}: ${t.title}`);
        fileLines.push(`> ID: \`${t.id}\` | 优先级: ${t.priority} | 预估: ${t.estimatedMinutes}min`);
        fileLines.push('');
        fileLines.push('```');
        fileLines.push(prompt);
        fileLines.push('```');
        fileLines.push('');

        summaryItems.push(`${i + 1}. ${t.title} (${t.estimatedMinutes}min, ${t.priority})`);
      }

      const today = new Date().toISOString().slice(0, 10);
      const filePath = join(PATHS.plans, `prompts-${promptStyle}-${today}.md`);
      await ensureDir(PATHS.plans);
      await writeFile(filePath, fileLines.join('\n'), 'utf-8');

      const resultLines = [
        `📝 **AI 提示词已生成** (${tasks.length} 个任务, 风格: ${promptStyle})`,
        '',
        ...summaryItems,
        '',
        `📄 **提示词文件**: \`${filePath}\``,
        '',
        '💡 请打开上述文件查看完整提示词并复制到新会话',
      ];

      return { content: [{ type: 'text', text: resultLines.join('\n') }] };
    }
  );

  // ── tool: plan_progress_summary ──
  server.registerTool(
    'plan_progress_summary',
    {
      title: '进度总结',
      description: '汇总当前所有任务的进度，识别阻塞项，给出调整建议',
      inputSchema: z.object({
        weekOffset: z.number().default(0).describe('0=本周, -1=上周'),
        showCompleted: z.boolean().default(false).describe('是否显示已完成任务'),
      }),
    },
    async ({ weekOffset, showCompleted }) => {
      const now = new Date();
      now.setDate(now.getDate() + weekOffset * 7);
      const wid = weekId(now);
      const plan = await readJSON<WeekPlan>(weekPlanPath(wid));
      const allTasks = await getAllTasks();

      let tasks: Task[];
      if (plan) {
        const wSet = new Set(plan.taskIds);
        tasks = allTasks.filter(t => wSet.has(t.id));
      } else {
        tasks = allTasks;
      }

      const done = tasks.filter(t => t.status === 'done');
      const inProgress = tasks.filter(t => t.status === 'in-progress');
      const todo = tasks.filter(t => t.status === 'todo');
      const blocked = tasks.filter(t => t.status === 'blocked');

      const totalMin = tasks.reduce((s, t) => s + t.estimatedMinutes, 0);
      const doneMin = done.reduce((s, t) => s + t.estimatedMinutes, 0);
      const progressPct = totalMin > 0 ? Math.round(doneMin / totalMin * 100) : 0;

      // 进度条
      const barLen = 20;
      const filled = Math.round(progressPct / 100 * barLen);
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

      const lines: string[] = [
        `## 📊 进度总结 — ${weekLabel(wid)}`,
        '',
        `整体进度: [${bar}] ${progressPct}%`,
        `工时: ${doneMin}/${totalMin} 分钟完成`,
        '',
        `| 状态 | 数量 | 工时 |`,
        `|------|------|------|`,
        `| ✅ 已完成 | ${done.length} | ${doneMin}min |`,
        `| 🔄 进行中 | ${inProgress.length} | ${inProgress.reduce((s, t) => s + t.estimatedMinutes, 0)}min |`,
        `| 📋 待开始 | ${todo.length} | ${todo.reduce((s, t) => s + t.estimatedMinutes, 0)}min |`,
        `| 🚫 阻塞中 | ${blocked.length} | ${blocked.reduce((s, t) => s + t.estimatedMinutes, 0)}min |`,
      ];

      if (inProgress.length > 0) {
        lines.push('', '### 🔄 进行中');
        for (const t of inProgress) {
          lines.push(`- **${t.title}** (进度 ${t.progress}%, 剩余约 ${Math.round(t.estimatedMinutes * (1 - t.progress / 100))}min)`);
        }
      }

      if (blocked.length > 0) {
        lines.push('', '### 🚫 阻塞任务 — 需要跟进！');
        for (const t of blocked) {
          const blockedHours = t.blockedAt
            ? Math.round((Date.now() - new Date(t.blockedAt).getTime()) / 3600_000)
            : 0;
          const durStr = blockedHours < 24 ? `${blockedHours} 小时` : `${Math.round(blockedHours / 24)} 天`;
          lines.push(`- **${t.title}**${t.blockedBy ? ` — 被 **${t.blockedBy}** 阻塞 (${durStr})` : ''}`);
          if (t.blockedReason) lines.push(`  - 原因: ${t.blockedReason}`);
          if (blockedHours >= 24) lines.push(`  - ⚠️ 阻塞超 1 天，建议主动沟通`);
        }
      }

      // 高优先级未开始
      const urgentTodo = todo.filter(t => t.priority === 'urgent' || t.priority === 'high');
      if (urgentTodo.length > 0) {
        lines.push('', '### ⚡ 高优先级待开始');
        for (const t of urgentTodo) {
          lines.push(`- [${t.priority}] **${t.title}** (${t.estimatedMinutes}min)`);
        }
      }

      if (showCompleted && done.length > 0) {
        lines.push('', '### ✅ 已完成');
        for (const t of done) {
          lines.push(`- ~~${t.title}~~ (${t.estimatedMinutes}min)`);
        }
      }

      // 建议
      lines.push('', '### 💡 建议');
      if (blocked.length > 0) lines.push(`- 优先解决 ${blocked.length} 个阻塞任务${blocked.some(t => {
        const h = t.blockedAt ? Math.round((Date.now() - new Date(t.blockedAt).getTime()) / 3600_000) : 0;
        return h >= 24;
      }) ? '（部分已超 1 天，紧急！）' : ''}`);
      if (urgentTodo.length > 0) lines.push(`- 有 ${urgentTodo.length} 个高优先级任务待启动`);
      if (progressPct < 30 && todo.length > 5) lines.push('- 任务较多，建议使用 `plan_today_generate` 合理安排今日工作');
      if (progressPct === 100) lines.push('- 🎉 本周任务全部完成！');

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ── tool: plan_quick_start ──
  server.registerTool(
    'plan_quick_start',
    {
      title: '一键开始本周',
      description: [
        '一步完成「创建任务 → 建立周计划 → 生成今日工作安排」的完整流程。',
        'AI 应根据用户的简单描述自动推断每个任务的 priority、tags、estimatedMinutes 和依赖关系。',
        '支持临时 ID 引用：dependsOn 中使用 "#1" 表示依赖本批次第 1 个任务（从 1 开始）。',
        '如果不传 tasks 参数，则基于已有的未完成任务直接创建周计划和今日安排。',
      ].join('\n'),
      inputSchema: z.object({
        tasks: z.array(z.object({
          title: z.string().describe('任务标题'),
          description: z.string().default('').describe('任务描述（AI 自动生成）'),
          priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium')
            .describe('优先级（AI 自动推断）'),
          tags: z.array(z.string()).default([])
            .describe('标签（AI 自动推断）'),
          dependsOn: z.array(z.string()).default([])
            .describe('依赖："#N" 引用本批次第 N 个任务，或已有任务 ID'),
          estimatedMinutes: z.number().default(30)
            .describe('预估分钟数（AI 自动推断）'),
          workspace: z.string().optional()
            .describe('工作空间（AI 根据任务内容自动分组，同一 git 分支的任务归同一空间）'),
        })).default([]).describe('要创建的新任务（可选）'),
        goals: z.array(z.string()).default([]).describe('本周工作目标'),
        workspaces: z.array(z.object({
          name: z.string().describe('工作空间名称'),
          branch: z.string().default('').describe('git 分支名（可选）'),
          slots: z.number().default(2).describe('该工作空间的并行槽位数'),
        })).default([]).describe('工作空间配置'),
        parallelSlots: z.number().default(2).describe('扁平模式并行槽位数（未指定 workspaces 时生效）'),
        notes: z.string().default('').describe('备注'),
      }),
    },
    async ({ tasks: taskInputs, goals, workspaces, parallelSlots, notes }) => {
      const resultLines: string[] = [];

      // ── 第 1 步：批量创建新任务（如有）──
      const newTaskIds: string[] = [];
      if (taskInputs.length > 0) {
        const created: Task[] = [];
        for (const input of taskInputs) {
          const task = await createTask({
            title: input.title,
            description: input.description,
            priority: input.priority,
            tags: input.tags,
            dependsOn: [],
            estimatedMinutes: input.estimatedMinutes,
            workspace: input.workspace,
          });
          created.push(task);
          newTaskIds.push(task.id);
        }

        // 解析临时 ID 依赖
        for (let i = 0; i < taskInputs.length; i++) {
          const deps = taskInputs[i].dependsOn;
          if (deps.length === 0) continue;
          const resolvedDeps: string[] = [];
          for (const dep of deps) {
            const match = dep.match(/^#(\d+)$/);
            if (match) {
              const idx = parseInt(match[1]) - 1;
              if (idx >= 0 && idx < created.length) resolvedDeps.push(created[idx].id);
            } else {
              resolvedDeps.push(dep);
            }
          }
          if (resolvedDeps.length > 0) {
            created[i].dependsOn = resolvedDeps;
            created[i].updatedAt = new Date().toISOString();
            await writeJSON(join(PATHS.tasks, `${created[i].id}.json`), created[i]);
          }
        }

        resultLines.push(`## ✅ 第 1 步：创建任务 (${created.length} 个)`, '');
        resultLines.push('| # | 标题 | 优先级 | 预估 | 标签 |');
        resultLines.push('|---|------|--------|------|------|');
        for (let i = 0; i < created.length; i++) {
          const t = created[i];
          resultLines.push(`| #${i + 1} | ${t.title} | ${t.priority} | ${t.estimatedMinutes}min | ${t.tags.join(', ') || '—'} |`);
        }
        resultLines.push('');
      }

      // ── 第 2 步：创建周计划 ──
      const now = new Date();
      const wid = weekId(now);
      const allTasks = await getAllTasks();
      const activeTasks = allTasks.filter(t => t.status === 'todo' || t.status === 'in-progress');
      const allTaskIds = activeTasks.map(t => t.id);

      const existing = await readJSON<WeekPlan>(weekPlanPath(wid));
      const plan: WeekPlan = {
        id: wid,
        weekLabel: weekLabel(wid),
        goals: goals.length > 0 ? goals : (existing?.goals || []),
        taskIds: allTaskIds,
        notes: notes || existing?.notes || '',
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeJSON(weekPlanPath(wid), plan);

      resultLines.push(`## 📅 第 2 步：本周计划 — ${plan.weekLabel}`, '');
      resultLines.push(`- 关联任务: ${allTaskIds.length} 个`);
      if (plan.goals.length > 0) {
        resultLines.push('- 本周目标:');
        for (const g of plan.goals) resultLines.push(`  - ${g}`);
      }
      resultLines.push('');

      // ── 第 3 步：生成今日安排 ──
      const today = new Date().toISOString().slice(0, 10);
      const candidateTasks = activeTasks.filter(t => t.status !== 'done');

      if (candidateTasks.length > 0) {
        const allSlots: ScheduleSlot[] = [];
        let grandTotalMin = 0;

        if (workspaces.length > 0) {
          // 工作空间模式
          const totalSlotCount = workspaces.reduce((s, w) => s + w.slots, 0);
          resultLines.push(`## 🗓️ 第 3 步：今日安排 (${workspaces.length} 工作空间, ${totalSlotCount} 并行)`, '');

          const wsNames = new Set(workspaces.map(w => w.name));
          for (const ws of workspaces) {
            const wsTasks = candidateTasks.filter(t => t.workspace === ws.name);
            resultLines.push(`### 📂 ${ws.name}${ws.branch ? ` (${ws.branch})` : ''} — ${ws.slots} 并行`);
            if (wsTasks.length === 0) {
              resultLines.push('', '无待处理任务', '');
              continue;
            }
            const levels = topoLevels(wsTasks);
            const taskMap = new Map(wsTasks.map(t => [t.id, t]));
            let wsTotalMin = 0;
            resultLines.push('');
            for (let i = 0; i < levels.length; i++) {
              const levelTasks = levels[i].map(id => taskMap.get(id)).filter(Boolean) as Task[];
              const batchMax = Math.max(...levelTasks.map(t => t.estimatedMinutes));
              wsTotalMin += batchMax;
              resultLines.push(`**第 ${i + 1} 批次（约 ${batchMax} 分钟）**`);
              for (let s = 0; s < levelTasks.length; s += ws.slots) {
                const group = levelTasks.slice(s, s + ws.slots);
                for (let si = 0; si < group.length; si++) {
                  const t = group[si];
                  const icon = t.status === 'in-progress' ? '🔄' : '📋';
                  resultLines.push(`  **槽位 ${si + 1}** ${icon} ${t.title} (${t.estimatedMinutes}min, ${t.priority})`);
                  allSlots.push({ taskId: t.id, taskTitle: t.title, estimatedMinutes: t.estimatedMinutes, batchIndex: i, priority: t.priority, status: t.status });
                }
              }
              resultLines.push('');
            }
            resultLines.push(`⏱️ 工时: ${wsTotalMin}min (${(wsTotalMin / 60).toFixed(1)}h)`, '');
            grandTotalMin = Math.max(grandTotalMin, wsTotalMin);
          }

          const unassigned = candidateTasks.filter(t => !t.workspace || !wsNames.has(t.workspace));
          if (unassigned.length > 0) {
            resultLines.push(`### ⚠️ 未分配工作空间 (${unassigned.length} 个)`);
            for (const t of unassigned) resultLines.push(`  - ${t.title}`);
            resultLines.push('');
          }
        } else {
          // 扁平模式
          const levels = topoLevels(candidateTasks);
          const taskMap = new Map(candidateTasks.map(t => [t.id, t]));
          resultLines.push(`## 🗓️ 第 3 步：今日安排 (${parallelSlots} 个并行槽位)`, '');
          for (let i = 0; i < levels.length; i++) {
            const levelTasks = levels[i].map(id => taskMap.get(id)).filter(Boolean) as Task[];
            const batchMax = Math.max(...levelTasks.map(t => t.estimatedMinutes));
            grandTotalMin += batchMax;
            resultLines.push(`### 第 ${i + 1} 批次（约 ${batchMax} 分钟）`);
            for (let s = 0; s < levelTasks.length; s += parallelSlots) {
              const group = levelTasks.slice(s, s + parallelSlots);
              resultLines.push('');
              for (let si = 0; si < group.length; si++) {
                const t = group[si];
                const icon = t.status === 'in-progress' ? '🔄' : '📋';
                const wsTag = t.workspace ? ` [${t.workspace}]` : '';
                resultLines.push(`  **槽位 ${si + 1}** ${icon} ${t.title}${wsTag} (${t.estimatedMinutes}min, ${t.priority})`);
                allSlots.push({ taskId: t.id, taskTitle: t.title, estimatedMinutes: t.estimatedMinutes, batchIndex: i, priority: t.priority, status: t.status });
              }
            }
            resultLines.push('');
          }
        }

        resultLines.push('---');
        resultLines.push(`⏱️ **总预计工时**: ${grandTotalMin} 分钟 (${(grandTotalMin / 60).toFixed(1)} 小时)`);
        resultLines.push(`📊 **任务数**: ${candidateTasks.length} 个`);

        const schedule: DaySchedule = {
          id: today, weekId: wid, slots: allSlots,
          parallelCapacity: workspaces.length > 0 ? workspaces.reduce((s, w) => s + w.slots, 0) : parallelSlots,
          totalMinutes: grandTotalMin, notes: workspaces.length > 0 ? `workspaces: ${workspaces.map(w => w.name).join(', ')}` : '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeJSON(daySchedulePath(today), schedule);

        // 自动为第一批次任务生成提示词并写入文件
        const batch0Tasks = allSlots
          .filter(s => s.batchIndex === 0)
          .map(s => candidateTasks.find(t => t.id === s.taskId))
          .filter(Boolean) as Task[];

        if (batch0Tasks.length > 0) {
          const promptFile = await generateBatchPromptsFile(batch0Tasks, today);
          resultLines.push('', '---', '');
          resultLines.push(`💬 **第 1 批次提示词已生成** (${batch0Tasks.length} 个): \`${promptFile}\``);
          resultLines.push('');
          resultLines.push('💡 请打开上述文件查看可复制的提示词');
        }
      } else {
        resultLines.push('## 🎉 今天没有待处理的任务！');
      }

      return { content: [{ type: 'text', text: resultLines.join('\n') }] };
    }
  );

  // ── tool: plan_deep_start ──
  server.registerTool(
    'plan_deep_start',
    {
      title: '深度规划（代码分析 + 子任务 + 提示词）',
      description: [
        'ℹ️ 重要：调用此工具前，AI 必须先完成以下步骤：',
        '1) 使用 codebase_search / view_file 等工具浏览相关代码文件',
        '2) 分析每个任务涉及的文件、函数、复杂度',
        '3) 将分析结果填入 codeContext 和 subtasks 字段',
        '',
        '功能：创建带有详细子任务拆分、代码上下文和开发提示词的深度工作规划。',
        '包含：任务创建 + 子任务拆分 + 周计划 + 今日排程 + 每个任务的 AI 提示词',
      ].join('\n'),
      inputSchema: z.object({
        tasks: z.array(z.object({
          title: z.string().describe('任务标题'),
          description: z.string().default('').describe('任务描述'),
          priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium')
            .describe('优先级'),
          tags: z.array(z.string()).default([]).describe('标签'),
          workspace: z.string().optional().describe('工作空间'),
          dependsOn: z.array(z.string()).default([]).describe('依赖（"#N" 或真实 ID）'),
          estimatedMinutes: z.number().default(30).describe('总预估分钟数'),
          codeContext: z.string().default('').describe(
            'AI 分析后填入的代码上下文：涉及的文件、函数、模块、架构特征、潜在难点'
          ),
          subtasks: z.array(z.object({
            title: z.string().describe('子任务标题'),
            estimatedMinutes: z.number().describe('预估分钟数'),
          })).default([]).describe('AI 分析后拆分的子任务（应包括编码、测试、联调等步骤）'),
          promptStyle: z.enum(['coding', 'review', 'analysis', 'refactoring']).default('coding')
            .describe('提示词风格'),
        })).min(1).describe('任务列表（AI 应先分析代码再填写）'),
        goals: z.array(z.string()).default([]).describe('本周目标'),
        workspaces: z.array(z.object({
          name: z.string().describe('工作空间名称'),
          branch: z.string().default('').describe('git 分支名'),
          slots: z.number().default(2).describe('并行槽位'),
        })).default([]).describe('工作空间配置'),
        parallelSlots: z.number().default(2).describe('扁平模式并行槽位'),
        notes: z.string().default('').describe('备注'),
      }),
    },
    async ({ tasks: taskInputs, goals, workspaces, parallelSlots, notes }) => {
      const resultLines: string[] = [];

      // ── 第 1 步：创建任务（含子任务）──
      const created: Task[] = [];
      for (const input of taskInputs) {
        const subtasks: Subtask[] = (input.subtasks || []).map(st => ({
          title: st.title,
          estimatedMinutes: st.estimatedMinutes,
          done: false,
        }));
        // 如果有子任务，总时间用子任务之和
        const totalMin = subtasks.length > 0
          ? subtasks.reduce((s, st) => s + st.estimatedMinutes, 0)
          : input.estimatedMinutes;
        const task = await createTask({
          title: input.title,
          description: input.description,
          priority: input.priority,
          tags: input.tags,
          dependsOn: [],
          estimatedMinutes: totalMin,
          workspace: input.workspace,
        });
        // 写入子任务
        if (subtasks.length > 0) {
          task.subtasks = subtasks;
          await writeJSON(join(PATHS.tasks, `${task.id}.json`), task);
        }
        created.push(task);
      }

      // 解析临时 ID
      for (let i = 0; i < taskInputs.length; i++) {
        const deps = taskInputs[i].dependsOn;
        if (deps.length === 0) continue;
        const resolved: string[] = [];
        for (const dep of deps) {
          const m = dep.match(/^#(\d+)$/);
          if (m) {
            const idx = parseInt(m[1]) - 1;
            if (idx >= 0 && idx < created.length) resolved.push(created[idx].id);
          } else resolved.push(dep);
        }
        if (resolved.length > 0) {
          created[i].dependsOn = resolved;
          created[i].updatedAt = new Date().toISOString();
          await writeJSON(join(PATHS.tasks, `${created[i].id}.json`), created[i]);
        }
      }

      resultLines.push(`## 🔍 深度规划报告`, '');

      // ── 任务概览 + 子任务拆分 ──
      resultLines.push(`### 第 1 步：任务创建与子任务拆分 (${created.length} 个)`, '');

      for (let i = 0; i < created.length; i++) {
        const t = created[i];
        const input = taskInputs[i];
        const wsTag = t.workspace ? ` [${t.workspace}]` : '';
        resultLines.push(`#### #${i + 1} ${t.title}${wsTag}`);
        resultLines.push('');
        resultLines.push(`| 属性 | 值 |`);
        resultLines.push(`|------|------|`);
        resultLines.push(`| 优先级 | ${t.priority} |`);
        resultLines.push(`| 预估工时 | ${t.estimatedMinutes}min |`);
        resultLines.push(`| 标签 | ${t.tags.join(', ') || '—'} |`);
        resultLines.push(`| ID | \`${t.id}\` |`);
        resultLines.push('');

        if (input.codeContext) {
          resultLines.push('**💻 代码分析:**');
          resultLines.push(input.codeContext);
          resultLines.push('');
        }

        if (t.subtasks && t.subtasks.length > 0) {
          resultLines.push('**📝 子任务拆分:**');
          resultLines.push('| 序号 | 子任务 | 预估 |');
          resultLines.push('|------|--------|------|');
          for (let si = 0; si < t.subtasks.length; si++) {
            const st = t.subtasks[si];
            resultLines.push(`| ${si + 1} | ${st.title} | ${st.estimatedMinutes}min |`);
          }
          resultLines.push('');
        }
      }

      // ── 第 2 步：周计划 ──
      const wid = weekId(new Date());
      const allTasks = await getAllTasks();
      const activeTasks = allTasks.filter(t => t.status === 'todo' || t.status === 'in-progress');
      const existing = await readJSON<WeekPlan>(weekPlanPath(wid));
      const plan: WeekPlan = {
        id: wid,
        weekLabel: weekLabel(wid),
        goals: goals.length > 0 ? goals : (existing?.goals || []),
        taskIds: activeTasks.map(t => t.id),
        notes: notes || existing?.notes || '',
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeJSON(weekPlanPath(wid), plan);
      resultLines.push(`### 第 2 步：本周计划 — ${plan.weekLabel}`);
      resultLines.push(`关联 ${activeTasks.length} 个任务`, '');

      // ── 第 3 步：排程 ──
      const today = new Date().toISOString().slice(0, 10);
      const candidateTasks = activeTasks.filter(t => t.status !== 'done');
      const allSlots: ScheduleSlot[] = [];
      let grandTotalMin = 0;

      if (candidateTasks.length > 0 && workspaces.length > 0) {
        const totalSlotCount = workspaces.reduce((s, w) => s + w.slots, 0);
        resultLines.push(`### 第 3 步：今日排程 (${workspaces.length} 工作空间, ${totalSlotCount} 并行)`, '');
        for (const ws of workspaces) {
          const wsTasks = candidateTasks.filter(t => t.workspace === ws.name);
          resultLines.push(`#### 📂 ${ws.name}${ws.branch ? ` (${ws.branch})` : ''} — ${ws.slots} 并行`);
          if (wsTasks.length === 0) { resultLines.push('无任务', ''); continue; }
          const levels = topoLevels(wsTasks);
          const tMap = new Map(wsTasks.map(t => [t.id, t]));
          let wsMin = 0;
          for (let i = 0; i < levels.length; i++) {
            const lt = levels[i].map(id => tMap.get(id)).filter(Boolean) as Task[];
            const bMax = Math.max(...lt.map(t => t.estimatedMinutes));
            wsMin += bMax;
            resultLines.push(`**批次 ${i + 1} (约${bMax}min)**`);
            for (let s = 0; s < lt.length; s += ws.slots) {
              for (let si = 0; si < Math.min(ws.slots, lt.length - s); si++) {
                const t = lt[s + si];
                resultLines.push(`  槽位${si + 1}: ${t.title} (${t.estimatedMinutes}min)`);
                allSlots.push({ taskId: t.id, taskTitle: t.title, estimatedMinutes: t.estimatedMinutes, batchIndex: i, priority: t.priority, status: t.status });
              }
            }
            resultLines.push('');
          }
          resultLines.push(`→ 工时: ${wsMin}min`, '');
          grandTotalMin = Math.max(grandTotalMin, wsMin);
        }
      } else if (candidateTasks.length > 0) {
        resultLines.push(`### 第 3 步：今日排程 (${parallelSlots} 并行)`, '');
        const levels = topoLevels(candidateTasks);
        const tMap = new Map(candidateTasks.map(t => [t.id, t]));
        for (let i = 0; i < levels.length; i++) {
          const lt = levels[i].map(id => tMap.get(id)).filter(Boolean) as Task[];
          const bMax = Math.max(...lt.map(t => t.estimatedMinutes));
          grandTotalMin += bMax;
          resultLines.push(`**批次 ${i + 1} (约${bMax}min)**`);
          for (const t of lt) {
            const wsTag = t.workspace ? ` [${t.workspace}]` : '';
            resultLines.push(`  ${t.title}${wsTag} (${t.estimatedMinutes}min)`);
            allSlots.push({ taskId: t.id, taskTitle: t.title, estimatedMinutes: t.estimatedMinutes, batchIndex: i, priority: t.priority, status: t.status });
          }
          resultLines.push('');
        }
      }

      if (allSlots.length > 0) {
        resultLines.push(`⏱️ 总工时: ${grandTotalMin}min (${(grandTotalMin / 60).toFixed(1)}h)`, '');
        const schedule: DaySchedule = {
          id: today, weekId: wid, slots: allSlots,
          parallelCapacity: workspaces.length > 0 ? workspaces.reduce((s, w) => s + w.slots, 0) : parallelSlots,
          totalMinutes: grandTotalMin, notes: 'deep-plan',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        await writeJSON(daySchedulePath(today), schedule);
      }

      // ── 第 4 步：生成提示词 ──
      const styleGuide: Record<string, string> = {
        coding: '实现功能，代码完整可运行，包含错误处理和单元测试',
        review: '审查代码质量、性能、安全性，给出改进建议',
        analysis: '调研技术方案，对比优劣，给出推荐方案',
        refactoring: '重构代码，保持功能不变，提升可维护性',
      };

      resultLines.push(`### 第 4 步：AI 开发提示词`, '');
      resultLines.push('> 以下提示词可直接复制到 Antigravity 新会话', '');

      for (let i = 0; i < created.length; i++) {
        const t = created[i];
        const input = taskInputs[i];
        const style = styleGuide[input.promptStyle] || styleGuide.coding;
        const wsTag = t.workspace ? ` [${t.workspace}]` : '';

        resultLines.push(`#### 💬 任务 #${i + 1}: ${t.title}${wsTag}`, '');
        resultLines.push('```markdown');

        // 生成提示词内容
        const promptParts: string[] = [
          `# 任务：${t.title}`,
          '',
          `## 目标`,
          t.description || `完成 ${t.title} 的开发工作`,
          '',
          `## 要求`,
          style,
          '',
        ];

        if (input.codeContext) {
          promptParts.push('## 代码上下文', input.codeContext, '');
        }

        if (t.subtasks && t.subtasks.length > 0) {
          promptParts.push('## 执行步骤');
          for (let si = 0; si < t.subtasks.length; si++) {
            promptParts.push(`${si + 1}. ${t.subtasks[si].title} (约${t.subtasks[si].estimatedMinutes}min)`);
          }
          promptParts.push('');
        }

        if (t.dependsOn.length > 0) {
          const depNames = t.dependsOn.map(d => {
            const dt = created.find(c => c.id === d);
            return dt ? dt.title : d;
          }).join(', ');
          promptParts.push(`## 前置依赖`, `本任务依赖: ${depNames}，请确保这些任务已完成再开始。`, '');
        }

        promptParts.push(`## 预估工时: ${t.estimatedMinutes} 分钟`);

        for (const line of promptParts) resultLines.push(line);
        resultLines.push('```');
        resultLines.push('');
      }

      return { content: [{ type: 'text', text: resultLines.join('\n') }] };
    }
  );

  // ── tool: plan_today_adjust ──
  server.registerTool(
    'plan_today_adjust',
    {
      title: '调整今日安排',
      description: [
        '根据实际进展动态调整今日工作安排。',
        '可以：更新任务预估时间、将任务推迟到明天、标记完成、添加新的紧急任务。',
        '调整后自动重新生成时间线。',
      ].join('\n'),
      inputSchema: z.object({
        updates: z.array(z.object({
          taskId: z.string().describe('任务 ID'),
          action: z.enum(['done', 'update-estimate', 'defer', 'progress']).describe(
            'done=标记完成, update-estimate=更新预估时间, defer=推迟到明天, progress=更新进度'
          ),
          newMinutes: z.number().optional().describe('update-estimate 时的新预估分钟数'),
          progress: z.number().min(0).max(100).optional().describe('progress 时的新进度百分比'),
          reason: z.string().default('').describe('调整原因'),
        })).min(1).describe('要调整的任务列表'),
        parallelSlots: z.number().default(2).describe('并行槽位数'),
      }),
    },
    async ({ updates, parallelSlots }) => {
      const allTasks = await getAllTasks();
      const taskMap = new Map(allTasks.map(t => [t.id, t]));
      const changeLog: string[] = ['## 🔄 今日安排调整', ''];

      for (const u of updates) {
        const task = taskMap.get(u.taskId);
        if (!task) {
          changeLog.push(`- ❌ 任务不存在: ${u.taskId}`);
          continue;
        }

        switch (u.action) {
          case 'done':
            task.status = 'done';
            task.progress = 100;
            task.completedAt = new Date().toISOString();
            changeLog.push(`- ✅ **${task.title}** → 已完成`);
            break;
          case 'update-estimate':
            if (u.newMinutes !== undefined) {
              const oldMin = task.estimatedMinutes;
              task.estimatedMinutes = u.newMinutes;
              const diff = u.newMinutes - oldMin;
              changeLog.push(`- ⏱️ **${task.title}** 预估: ${oldMin}min → ${u.newMinutes}min (${diff > 0 ? '+' : ''}${diff}min)${u.reason ? ` | ${u.reason}` : ''}`);
            }
            break;
          case 'defer':
            changeLog.push(`- ⏭️ **${task.title}** 推迟到明天${u.reason ? ` | ${u.reason}` : ''}`);
            // 从this schedule中移除，但不改变任务状态
            break;
          case 'progress':
            if (u.progress !== undefined) {
              task.progress = u.progress;
              if (task.status === 'todo') task.status = 'in-progress';
              changeLog.push(`- 📊 **${task.title}** 进度: ${u.progress}% (剩余约 ${Math.round(task.estimatedMinutes * (1 - u.progress / 100))}min)`);
            }
            break;
        }
        task.updatedAt = new Date().toISOString();
        await writeJSON(join(PATHS.tasks, `${task.id}.json`), task);
      }

      // 重新生成今日安排
      const today = new Date().toISOString().slice(0, 10);
      const deferredIds = new Set(updates.filter(u => u.action === 'defer').map(u => u.taskId));
      const refreshedTasks = await getAllTasks();
      const activeTasks = refreshedTasks.filter(
        t => (t.status === 'todo' || t.status === 'in-progress') && !deferredIds.has(t.id)
      );

      if (activeTasks.length > 0) {
        const levels = topoLevels(activeTasks);
        const tMap = new Map(activeTasks.map(t => [t.id, t]));
        const slots: ScheduleSlot[] = [];
        let totalMin = 0;

        changeLog.push('', `## 🗓️ 更新后的今日安排 (${parallelSlots} 个并行槽位)`, '');

        for (let i = 0; i < levels.length; i++) {
          const levelTasks = levels[i].map(id => tMap.get(id)).filter(Boolean) as Task[];
          const batchMax = Math.max(...levelTasks.map(t => t.estimatedMinutes));
          totalMin += batchMax;
          changeLog.push(`### 第 ${i + 1} 批次（约 ${batchMax} 分钟）`);
          for (const t of levelTasks) {
            const icon = t.status === 'in-progress' ? '🔄' : '📋';
            const pctStr = t.progress > 0 ? ` ${t.progress}%完成` : '';
            changeLog.push(`  ${icon} ${t.title} (${t.estimatedMinutes}min${pctStr})`);
            slots.push({
              taskId: t.id, taskTitle: t.title,
              estimatedMinutes: t.estimatedMinutes,
              batchIndex: i, priority: t.priority, status: t.status,
            });
          }
          changeLog.push('');
        }
        changeLog.push(`⏱️ 今日剩余工时: ${totalMin} 分钟 (${(totalMin / 60).toFixed(1)} 小时)`);

        const schedule: DaySchedule = {
          id: today, weekId: weekId(new Date()),
          slots, parallelCapacity: parallelSlots,
          totalMinutes: totalMin, notes: 'adjusted',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeJSON(daySchedulePath(today), schedule);
      } else {
        changeLog.push('', '🎉 今日任务已全部完成！');
      }

      return { content: [{ type: 'text', text: changeLog.join('\n') }] };
    }
  );

  // ── tool: plan_daily_standup ──
  server.registerTool(
    'plan_daily_standup',
    {
      title: '每日站会总结',
      description: '生成站会风格的每日汇报：昨日完成、今日计划、阻塞项、时间偏差分析和 AI 智能建议',
      inputSchema: z.object({
        date: z.string().default('').describe('日期 YYYY-MM-DD，留空表示今天'),
      }),
    },
    async ({ date }) => {
      const today = date || new Date().toISOString().slice(0, 10);
      const yesterday = new Date(new Date(today + 'T12:00:00').getTime() - 86400_000)
        .toISOString().slice(0, 10);
      const allTasks = await getAllTasks();

      // 昨日安排
      const yesterdaySchedule = await readJSON<DaySchedule>(daySchedulePath(yesterday));
      // 今日安排
      const todaySchedule = await readJSON<DaySchedule>(daySchedulePath(today));
      // 本周计划
      const wid = weekId(new Date(today + 'T12:00:00'));
      const weekPlan = await readJSON<WeekPlan>(weekPlanPath(wid));

      const taskMap = new Map(allTasks.map(t => [t.id, t]));

      const lines: string[] = [
        `## 📋 每日站会 — ${today}`,
        '',
      ];

      // ── 昨日完成 ──
      const recentDone = allTasks.filter(t => {
        if (t.status !== 'done' || !t.completedAt) return false;
        const doneDate = t.completedAt.slice(0, 10);
        return doneDate === yesterday || doneDate === today;
      });

      lines.push('### ✅ 昨日完成');
      if (recentDone.length > 0) {
        for (const t of recentDone) {
          lines.push(`- ~~${t.title}~~ (${t.estimatedMinutes}min)`);
        }
        const actualDone = recentDone.length;
        const plannedCount = yesterdaySchedule?.slots.length || 0;
        if (plannedCount > 0) {
          lines.push(`- 昨日计划 ${plannedCount} 个，实际完成 ${actualDone} 个`);
        }
      } else {
        lines.push('- 无完成记录');
      }

      // ── 今日计划 ──
      lines.push('', '### 🔄 今日计划');
      const activeTasks = allTasks.filter(t => t.status === 'in-progress');
      const todoTasks = allTasks.filter(t => t.status === 'todo');

      if (activeTasks.length > 0) {
        lines.push('**继续进行中:**');
        for (const t of activeTasks) {
          const remain = Math.round(t.estimatedMinutes * (1 - t.progress / 100));
          lines.push(`- 🔄 **${t.title}** (进度 ${t.progress}%, 剩余约 ${remain}min)`);
        }
      }

      if (todaySchedule && todaySchedule.slots.length > 0) {
        const todoSlots = todaySchedule.slots.filter(s => {
          const t = taskMap.get(s.taskId);
          return t && t.status === 'todo';
        });
        if (todoSlots.length > 0) {
          lines.push('**今日新开始:**');
          for (const s of todoSlots) {
            lines.push(`- 📋 ${s.taskTitle} (${s.estimatedMinutes}min, ${s.priority})`);
          }
        }
      } else if (todoTasks.length > 0) {
        // 优先显示高优先级
        const highPri = todoTasks.filter(t => t.priority === 'urgent' || t.priority === 'high');
        if (highPri.length > 0) {
          lines.push('**高优先级待开始:**');
          for (const t of highPri.slice(0, 5)) {
            lines.push(`- 📋 ${t.title} (${t.estimatedMinutes}min, ${t.priority})`);
          }
        }
      }

      if (activeTasks.length === 0 && (!todaySchedule || todaySchedule.slots.length === 0) && todoTasks.length === 0) {
        lines.push('- 无计划任务。使用 `plan_today_generate` 生成今日安排。');
      }

      // ── 阻塞项 ──
      const blockedTasks = allTasks.filter(t => t.status === 'blocked');
      if (blockedTasks.length > 0) {
        lines.push('', '### ⛔ 阻塞项');
        for (const t of blockedTasks) {
          const hours = t.blockedAt
            ? Math.round((Date.now() - new Date(t.blockedAt).getTime()) / 3600_000)
            : 0;
          const durStr = hours < 24 ? `${hours}小时` : `${Math.round(hours / 24)}天`;
          lines.push(`- ⛔ **${t.title}**${t.blockedBy ? ` — 被 ${t.blockedBy} 阻塞 (${durStr})` : ''}`);
          if (t.blockedReason) lines.push(`  - ${t.blockedReason}`);
        }
      }

      // ── 本周进度 ──
      if (weekPlan) {
        const weekTasks = weekPlan.taskIds.map(id => taskMap.get(id)).filter(Boolean) as Task[];
        const totalMin = weekTasks.reduce((s, t) => s + t.estimatedMinutes, 0);
        const doneMin = weekTasks.filter(t => t.status === 'done').reduce((s, t) => s + t.estimatedMinutes, 0);
        const pct = totalMin > 0 ? Math.round(doneMin / totalMin * 100) : 0;
        const barLen = 15;
        const filled = Math.round(pct / 100 * barLen);
        const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

        lines.push('', '### 📊 本周进度');
        lines.push(`[${bar}] ${pct}% (${doneMin}/${totalMin}min)`);

        // 简单预测
        const daysLeft = 5 - new Date(today + 'T12:00:00').getDay(); // 工作日剩余
        if (daysLeft > 0 && pct < 100) {
          const remainMin = totalMin - doneMin;
          const avgPerDay = Math.round(remainMin / daysLeft);
          lines.push(`剩余 ${remainMin}min 工作量，还有 ${daysLeft} 个工作日，每天约 ${avgPerDay}min`);
        }
      }

      // ── AI 建议 ──
      lines.push('', '### 💡 建议');
      if (blockedTasks.length > 0) {
        const longBlocked = blockedTasks.filter(t => {
          const h = t.blockedAt ? Math.round((Date.now() - new Date(t.blockedAt).getTime()) / 3600_000) : 0;
          return h >= 24;
        });
        if (longBlocked.length > 0) {
          lines.push(`- ⚠️ ${longBlocked.length} 个任务阻塞超 1 天，建议今天主动联系阻塞方`);
        } else {
          lines.push(`- 有 ${blockedTasks.length} 个阻塞任务，注意跟进`);
        }
      }
      const overdueTasks = activeTasks.filter(t => {
        return t.progress < 50 && t.priority === 'urgent';
      });
      if (overdueTasks.length > 0) {
        lines.push(`- 🚨 ${overdueTasks.length} 个紧急任务进度低于 50%，建议优先处理`);
      }
      if (activeTasks.length === 0 && todoTasks.length > 0) {
        lines.push('- 当前没有进行中的任务，建议发起新任务');
      }
      if (blockedTasks.length === 0 && overdueTasks.length === 0 && activeTasks.length > 0) {
        lines.push('- ✅ 一切顺利，继续保持！');
      }
      lines.push(`- 使用 \`plan_today_adjust\` 随时调整今日安排`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ── resource: plan://week/{weekId} ──
  server.registerResource(
    'week-plan',
    new ResourceTemplate('plan://week/{wid}', {
      list: async () => {
        const files = await readAllJSON<WeekPlan>(join(PATHS.plans, 'weekly'));
        return {
          resources: files.map(p => ({ uri: `plan://week/${p.id}`, name: p.weekLabel })),
        };
      },
    }),
    {
      title: '周计划',
      description: '获取指定周的计划数据',
      mimeType: 'application/json',
    },
    async (uri, { wid }) => {
      const plan = await readJSON<WeekPlan>(weekPlanPath(wid as string));
      return {
        contents: [{
          uri: uri.href,
          text: plan ? JSON.stringify(plan, null, 2) : '{"error": "Week plan not found"}',
        }],
      };
    }
  );

  // ── resource: plan://today ──
  server.registerResource(
    'today-schedule',
    'plan://today',
    {
      title: '今日安排',
      description: '获取今天生成的工作安排',
      mimeType: 'application/json',
    },
    async () => {
      const today = new Date().toISOString().slice(0, 10);
      const schedule = await readJSON<DaySchedule>(daySchedulePath(today));
      return {
        contents: [{
          uri: 'plan://today',
          text: schedule ? JSON.stringify(schedule, null, 2) : '{"message": "今日尚无安排，请先调用 plan_today_generate"}',
        }],
      };
    }
  );

  // ── tool: plan_week_schedule ──
  server.registerTool(
    'plan_week_schedule',
    {
      title: '生成一周工作安排（周一~周五）',
      description: [
        '将所有活跃任务按依赖关系和优先级分配到本周的工作日（周一到周五）。',
        '每天根据容量上限分配任务，自动生成 DaySchedule 文件。',
        '适合在周一早上或周日晚上规划整周工作时使用。',
      ].join('\n'),
      inputSchema: z.object({
        dailyCapacityMinutes: z.number().default(360)
          .describe('每天的工作容量（分钟），默认 360（6小时）'),
        parallelSlots: z.number().default(2)
          .describe('每天的并行槽位数'),
        workspaces: z.array(z.object({
          name: z.string().describe('工作空间名称'),
          branch: z.string().default('').describe('git 分支名'),
          slots: z.number().default(2).describe('并行槽位'),
        })).default([]).describe('工作空间配置（可选）'),
      }),
    },
    async ({ dailyCapacityMinutes, parallelSlots, workspaces }) => {
      const allTasks = await getAllTasks();
      const activeTasks = allTasks.filter(t =>
        t.status === 'todo' || t.status === 'in-progress'
      );

      if (activeTasks.length === 0) {
        return { content: [{ type: 'text', text: '🎉 没有待安排的任务！' }] };
      }

      // 计算工作日（周一到周五）
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dow = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const monday = new Date(today);
      if (dow === 0) {
        // 周日 → 下周一
        monday.setDate(today.getDate() + 1);
      } else if (dow === 6) {
        // 周六 → 下周一
        monday.setDate(today.getDate() + 2);
      } else {
        // 工作日 → 本周一
        monday.setDate(today.getDate() - dow + 1);
      }

      const workdays: string[] = [];
      const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        workdays.push(fmtDate(d));
      }

      // 拓扑排序 + 优先级排序
      const levels = topoLevels(activeTasks);
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      const taskMap = new Map(activeTasks.map(t => [t.id, t]));

      // 扁平化 levels 为有序任务列表（保持依赖顺序，同 level 内按优先级排序）
      const orderedTasks: Task[] = [];
      for (const level of levels) {
        const levelTasks = level
          .map(id => taskMap.get(id))
          .filter(Boolean) as Task[];
        levelTasks.sort((a, b) =>
          (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2)
        );
        orderedTasks.push(...levelTasks);
      }

      // 分配任务到每一天
      const daySlots: Map<string, ScheduleSlot[]> = new Map();
      const dayMinutes: Map<string, number> = new Map();
      for (const day of workdays) {
        daySlots.set(day, []);
        dayMinutes.set(day, 0);
      }

      // 已完成的任务 ID（用于依赖检查）
      const scheduledIds = new Set(
        allTasks.filter(t => t.status === 'done' || t.status === 'review').map(t => t.id)
      );

      for (const task of orderedTasks) {
        // 找到最早能放入该任务的日子（依赖必须在之前的日子或同一天）
        let assigned = false;
        for (const day of workdays) {
          const currentMin = dayMinutes.get(day) || 0;
          if (currentMin + task.estimatedMinutes > dailyCapacityMinutes) continue;

          // 检查依赖是否已在此天之前被安排
          const depsSatisfied = task.dependsOn.every(dep => {
            if (scheduledIds.has(dep)) return true;
            // 检查前面的日子是否已安排
            for (const prevDay of workdays) {
              if (prevDay >= day) break;
              if (daySlots.get(prevDay)?.some(s => s.taskId === dep)) return true;
            }
            return false;
          });

          if (!depsSatisfied) continue;

          const slots = daySlots.get(day)!;
          slots.push({
            taskId: task.id,
            taskTitle: task.title,
            estimatedMinutes: task.estimatedMinutes,
            batchIndex: 0,
            priority: task.priority,
            status: task.status,
          });
          dayMinutes.set(day, currentMin + task.estimatedMinutes);
          assigned = true;
          break;
        }

        // 如果五天都放不下，放到最空的一天
        if (!assigned) {
          let minDay = workdays[0];
          let minLoad = Infinity;
          for (const day of workdays) {
            const load = dayMinutes.get(day) || 0;
            if (load < minLoad) { minLoad = load; minDay = day; }
          }
          daySlots.get(minDay)!.push({
            taskId: task.id,
            taskTitle: task.title,
            estimatedMinutes: task.estimatedMinutes,
            batchIndex: 0,
            priority: task.priority,
            status: task.status,
          });
          dayMinutes.set(minDay, (dayMinutes.get(minDay) || 0) + task.estimatedMinutes);
        }
      }

      // 保存每天的 DaySchedule
      const wid = weekId(now);
      const resultLines: string[] = [
        `## 📅 本周工作安排 (${workdays[0]} ~ ${workdays[4]})`,
        '',
      ];

      let totalWeekMin = 0;
      for (let i = 0; i < workdays.length; i++) {
        const day = workdays[i];
        const slots = daySlots.get(day) || [];
        const dayTotal = dayMinutes.get(day) || 0;
        totalWeekMin += dayTotal;

        // 为每天重新分配 batchIndex（按工作空间或顺序）
        const capacity = workspaces.length > 0
          ? workspaces.reduce((s, w) => s + w.slots, 0)
          : parallelSlots;

        const daySchedule: DaySchedule = {
          id: day,
          weekId: wid,
          slots,
          parallelCapacity: capacity,
          totalMinutes: dayTotal,
          notes: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeJSON(daySchedulePath(day), daySchedule);

        const dayLabel = dayNames[i + 1];
        const bar = dayTotal > 0
          ? '█'.repeat(Math.round(dayTotal / dailyCapacityMinutes * 10)) + '░'.repeat(10 - Math.round(dayTotal / dailyCapacityMinutes * 10))
          : '░'.repeat(10);
        const isToday = day === fmtDate(now);

        resultLines.push(`### ${dayLabel} ${day}${isToday ? ' 📍今天' : ''}`);
        resultLines.push(`[${bar}] ${dayTotal}min / ${dailyCapacityMinutes}min`);
        resultLines.push('');

        if (slots.length === 0) {
          resultLines.push('  暂无安排\n');
        } else {
          for (const s of slots) {
            const icon = s.status === 'in-progress' ? '🔄' : '📋';
            resultLines.push(`  ${icon} **${s.taskTitle}** (${s.estimatedMinutes}min, ${s.priority})`);
          }
          resultLines.push('');
        }
      }

      resultLines.push('---');
      resultLines.push(`📊 **本周总工时**: ${totalWeekMin}min (${(totalWeekMin / 60).toFixed(1)}h)`);
      resultLines.push(`📋 **已安排任务**: ${activeTasks.length} 个`);
      resultLines.push(`⏱️ **每日容量**: ${dailyCapacityMinutes}min (${(dailyCapacityMinutes / 60).toFixed(1)}h)`);

      // 检查是否有任务超出本周容量
      const totalCapacity = dailyCapacityMinutes * 5;
      if (totalWeekMin > totalCapacity) {
        resultLines.push('');
        resultLines.push(`> ⚠️ 工作量 (${totalWeekMin}min) 超出本周容量 (${totalCapacity}min)，建议调整优先级或延期部分任务`);
      }

      return { content: [{ type: 'text', text: resultLines.join('\n') }] };
    }
  );

  // ── tool: plan_next_task ──
  server.registerTool(
    'plan_next_task',
    {
      title: '获取下一个可做任务',
      description: [
        '当前任务完成后调用此工具，自动获取指定工作空间中下一个可做的任务。',
        '逻辑：找到依赖全部完成、状态为 todo、优先级最高的任务，',
        '自动标记为 in-progress 并生成完整提示词。',
        '如果没有可做的任务，会返回等待信息或提示切换工作空间。',
      ].join('\n'),
      inputSchema: z.object({
        workspace: z.string().optional()
          .describe('工作空间名称（留空则在所有任务中查找）'),
        currentTaskId: z.string().optional()
          .describe('当前刚完成的任务 ID（会自动标记为 done）'),
      }),
    },
    async ({ workspace, currentTaskId }) => {
      // 如果有当前任务，自动标记完成
      if (currentTaskId) {
        const current = await readJSON<Task>(join(PATHS.tasks, `${currentTaskId}.json`));
        if (current) {
          current.status = 'done';
          current.progress = 100;
          current.completedAt = new Date().toISOString();
          current.updatedAt = new Date().toISOString();
          await writeJSON(join(PATHS.tasks, `${currentTaskId}.json`), current);
        }
      }

      const allTasks = await getAllTasks();
      const doneIds = new Set(allTasks.filter(t => t.status === 'done').map(t => t.id));

      // 筛选候选任务：todo + 依赖全部完成
      let candidates = allTasks.filter(t => {
        if (t.status !== 'todo') return false;
        if (workspace && t.workspace !== workspace) return false;
        return t.dependsOn.every(dep => doneIds.has(dep));
      });

      // 按优先级排序
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      candidates.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));

      if (candidates.length === 0) {
        // 检查是否有等待依赖的任务
        const waiting = allTasks.filter(t => {
          if (t.status !== 'todo') return false;
          if (workspace && t.workspace !== workspace) return false;
          return !t.dependsOn.every(dep => doneIds.has(dep));
        });

        if (waiting.length > 0) {
          const waitInfo = waiting.map(t => {
            const pendingDeps = t.dependsOn
              .filter(d => !doneIds.has(d))
              .map(d => allTasks.find(at => at.id === d)?.title || d);
            return `- ${t.title} → 等待: ${pendingDeps.join(', ')}`;
          }).join('\n');
          return {
            content: [{
              type: 'text',
              text: `⏳ **${workspace || '所有'}工作空间暂无可做任务**\n\n等待依赖完成的任务:\n${waitInfo}\n\n💡 建议切换到其他工作空间，或等待上述依赖任务完成。`,
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `🎉 **${workspace || '所有'}工作空间的任务已全部完成！**`,
          }],
        };
      }

      // 取最高优先级任务
      const next = candidates[0];

      // 自动标记为进行中
      next.status = 'in-progress';
      next.updatedAt = new Date().toISOString();
      await writeJSON(join(PATHS.tasks, `${next.id}.json`), next);

      // 生成提示词
      const wsTag = next.workspace ? ` [${next.workspace}]` : '';
      const promptParts: string[] = [
        `# 任务：${next.title}`,
        '',
        '## 目标',
        next.description || `完成 ${next.title} 的开发工作`,
        '',
      ];

      if (next.subtasks && next.subtasks.length > 0) {
        promptParts.push('## 执行步骤');
        for (let si = 0; si < next.subtasks.length; si++) {
          promptParts.push(`${si + 1}. ${next.subtasks[si].title} (约${next.subtasks[si].estimatedMinutes}min)`);
        }
        promptParts.push('');
      }

      promptParts.push('## 要求');
      promptParts.push('实现功能，代码完整可运行，包含错误处理');
      promptParts.push('');
      promptParts.push(`## 预估工时: ${next.estimatedMinutes} 分钟`);
      promptParts.push('');

      // 检查是否有前序任务的上下文可以引用
      if (next.dependsOn.length > 0) {
        const depNames = next.dependsOn
          .map(d => allTasks.find(t => t.id === d)?.title || d)
          .join(', ');
        promptParts.push('## 前置上下文');
        promptParts.push(`本任务依赖: ${depNames}（已完成）`);
        promptParts.push('请先用 context_get 获取前序任务的发现和上下文。');
        promptParts.push('');
      }

      // 生命周期指令
      promptParts.push('## ⚙️ 任务管理（请务必执行）');
      promptParts.push(`- 任务已自动标记为进行中`);
      promptParts.push(`- 完成后: 调用 task_update(id="${next.id}", status="done")`);
      promptParts.push(`- 有重要发现: 调用 context_share(key="${(next.workspace || 'task').replace(/\s/g, '-')}-findings", content="...")`);
      promptParts.push(`- 获取下一任务: 调用 plan_next_task(${next.workspace ? `workspace="${next.workspace}"` : ''})`);

      // 写入文件
      const today = new Date().toISOString().slice(0, 10);
      const filePath = join(PATHS.plans, `next-task-${today}-${next.id.slice(0, 6)}.md`);
      await ensureDir(PATHS.plans);

      const fileContent = [
        `# 📌 下一个任务${wsTag}`,
        '',
        `> 自动分配: ${next.title} (${next.priority}, ${next.estimatedMinutes}min)`,
        '',
        '---',
        '',
        '```',
        ...promptParts,
        '```',
      ].join('\n');
      await writeFile(filePath, fileContent, 'utf-8');

      // 构建返回结果
      const remaining = candidates.length - 1;
      const lines = [
        `✅ **下一个任务**${wsTag}: ${next.title}`,
        '',
        `| 属性 | 值 |`,
        `|------|------|`,
        `| 优先级 | ${next.priority} |`,
        `| 预估 | ${next.estimatedMinutes}min |`,
        `| 状态 | 已自动标记为 in-progress |`,
        `| ID | \`${next.id}\` |`,
        '',
        `📄 **提示词文件**: \`${filePath}\``,
        '',
        remaining > 0 ? `📋 ${workspace || ''}队列中还有 ${remaining} 个任务等待` : '🎯 这是最后一个任务！',
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );
}
