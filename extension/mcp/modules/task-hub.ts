import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'node:path';
import {
  readJSON, writeJSON, deleteJSON, readAllJSON,
  generateId, PATHS
} from '../utils/storage.js';

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
  startedAt?: string;      // 开始时间（自动记录）
  completedAt?: string;
  actualMinutes?: number;  // 实际耗时（自动计算）
  workspace?: string;
  subtasks?: Subtask[];    // 子任务拆分
  blockedBy?: string;
  blockedReason?: string;
  blockedAt?: string;
}

interface Subtask {
  title: string;
  estimatedMinutes: number;
  done: boolean;
}

// ─── 辅助函数 ─────────────────────────────────────────────

function taskPath(id: string): string {
  return join(PATHS.tasks, `${id}.json`);
}

async function getAllTasks(): Promise<Task[]> {
  return readAllJSON<Task>(PATHS.tasks);
}

function formatTask(t: Task): string {
  const ws = t.workspace ? ` [${t.workspace}]` : '';
  let text = `[${t.status}] ${t.title}${ws} (ID: ${t.id}, 优先级: ${t.priority}, 进度: ${t.progress}%)`;
  if (t.status === 'blocked' && t.blockedBy) {
    text += ` ⛔ 被 ${t.blockedBy} 阻塞`;
  }
  return text;
}

/** 创建单个任务并持久化，返回创建的 Task 对象（供其他模块复用） */
export async function createTask(input: {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  tags?: string[];
  dependsOn?: string[];
  estimatedMinutes?: number;
  workspace?: string;
}): Promise<Task> {
  const task: Task = {
    id: generateId(),
    title: input.title,
    description: input.description || '',
    status: 'todo',
    priority: input.priority || 'medium',
    tags: input.tags || [],
    dependsOn: input.dependsOn || [],
    estimatedMinutes: input.estimatedMinutes || 30,
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspace: input.workspace,
  };
  await writeJSON(taskPath(task.id), task);
  return task;
}

// ─── DAG 分析 ──────────────────────────────────────────────

function analyzeDag(tasks: Task[]): string {
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // 构建邻接表
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    graph.set(t.id, []);
    inDegree.set(t.id, 0);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (graph.has(dep)) {
        graph.get(dep)!.push(t.id);
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
      }
    }
  }

  // 拓扑排序（Kahn 算法）
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  const levels: string[][] = [];

  while (queue.length > 0) {
    const level = [...queue];
    levels.push(level);
    queue.length = 0;
    for (const id of level) {
      sorted.push(id);
      for (const next of graph.get(id) || []) {
        const newDeg = (inDegree.get(next) || 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }
  }

  // 检测循环依赖
  if (sorted.length < tasks.length) {
    const unsorted = tasks.filter(t => !sorted.includes(t.id));
    return `⚠️ 检测到循环依赖！涉及任务：${unsorted.map(t => t.title).join(', ')}`;
  }

  // 关键路径计算
  const dist = new Map<string, number>();
  for (const t of tasks) dist.set(t.id, t.estimatedMinutes);

  for (const id of sorted) {
    const task = taskMap.get(id)!;
    for (const dep of task.dependsOn) {
      const via = (dist.get(dep) || 0) + task.estimatedMinutes;
      if (via > (dist.get(id) || 0)) {
        dist.set(id, via);
      }
    }
  }

  const maxTime = Math.max(...dist.values());

  // 生成 Mermaid 图
  const mermaidLines = ['```mermaid', 'graph LR'];
  for (const t of tasks) {
    const label = `${t.title}<br/>${t.estimatedMinutes}min`;
    mermaidLines.push(`    ${t.id}["${label}"]`);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (taskMap.has(dep)) {
        mermaidLines.push(`    ${dep} --> ${t.id}`);
      }
    }
  }
  mermaidLines.push('```');

  // 生成结果
  const lines: string[] = [
    '## 任务依赖分析结果',
    '',
    `**总任务数**: ${tasks.length}`,
    `**预估最长路径耗时**: ${maxTime} 分钟`,
    '',
    '### 并行执行分组',
    '',
  ];

  for (let i = 0; i < levels.length; i++) {
    const levelTasks = levels[i].map(id => taskMap.get(id)!);
    const levelTime = Math.max(...levelTasks.map(t => t.estimatedMinutes));
    lines.push(`**第 ${i + 1} 批（可并行执行，预计 ${levelTime} 分钟）**:`);
    for (const t of levelTasks) {
      lines.push(`  - ${formatTask(t)}`);
    }
    lines.push('');
  }

  lines.push('### 依赖关系图');
  lines.push('');
  lines.push(...mermaidLines);

  return lines.join('\n');
}

// ─── 注册模块 ─────────────────────────────────────────────

export function registerTaskHub(server: McpServer): void {

  // ── tool: task_create ──
  server.registerTool(
    'task_create',
    {
      title: '创建任务',
      description: '创建一个新的任务，可指定优先级、标签、依赖关系和预估工时',
      inputSchema: z.object({
        title: z.string().describe('任务标题'),
        description: z.string().default('').describe('任务描述'),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium').describe('优先级'),
        tags: z.array(z.string()).default([]).describe('标签列表'),
        dependsOn: z.array(z.string()).default([]).describe('依赖的任务 ID 列表'),
        estimatedMinutes: z.number().default(30).describe('预估耗时（分钟）'),
        workspace: z.string().optional().describe('工作空间名称（如 "数据集重构"、"地图组件"）'),
      }),
    },
    async ({ title, description, priority, tags, dependsOn, estimatedMinutes, workspace }) => {
      const task = await createTask({ title, description, priority, tags, dependsOn, estimatedMinutes, workspace });
      return {
        content: [{ type: 'text', text: `✅ 任务已创建: ${formatTask(task)}\nID: ${task.id}` }],
      };
    }
  );

  // ── tool: task_update ──
  server.registerTool(
    'task_update',
    {
      title: '更新任务',
      description: '更新任务的状态、标题、描述或进度',
      inputSchema: z.object({
        id: z.string().describe('任务 ID'),
        status: z.enum(['todo', 'in-progress', 'review', 'done', 'blocked']).optional().describe('新状态'),
        title: z.string().optional().describe('新标题'),
        description: z.string().optional().describe('新描述'),
        progress: z.number().min(0).max(100).optional().describe('进度 0-100'),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('新优先级'),
      }),
    },
    async ({ id, status, title, description, progress, priority }) => {
      const task = await readJSON<Task>(taskPath(id));
      if (!task) {
        return { content: [{ type: 'text', text: `❌ 任务不存在: ${id}` }], isError: true };
      }
      // AI 标记 done → 自动变为 review，需由用户在 Dashboard 确认
      if (status === 'done' && task.status !== 'review') {
        status = 'review' as any;
      }
      if (status) task.status = status;
      if (title) task.title = title;
      if (description !== undefined) task.description = description;
      if (progress !== undefined) task.progress = progress;
      if (priority) task.priority = priority;
      // 自动记录时间节点
      if (status === 'in-progress' && !task.startedAt) {
        task.startedAt = new Date().toISOString();
      }
      if (status === 'review') {
        task.completedAt = new Date().toISOString();
        task.progress = 100;
        if (task.startedAt) {
          task.actualMinutes = Math.round((Date.now() - new Date(task.startedAt).getTime()) / 60000);
        }
      }
      if (status === 'done') task.completedAt = new Date().toISOString();
      task.updatedAt = new Date().toISOString();
      await writeJSON(taskPath(id), task);
      return { content: [{ type: 'text', text: `✅ 任务已更新: ${formatTask(task)}` }] };
    }
  );

  // ── tool: task_list ──
  server.registerTool(
    'task_list',
    {
      title: '列出任务',
      description: '列出所有任务，可按状态、标签或优先级过滤',
      inputSchema: z.object({
        status: z.enum(['todo', 'in-progress', 'review', 'done', 'blocked']).optional().describe('按状态过滤'),
        tag: z.string().optional().describe('按标签过滤'),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('按优先级过滤'),
      }),
    },
    async ({ status, tag, priority }) => {
      let tasks = await getAllTasks();
      if (status) tasks = tasks.filter(t => t.status === status);
      if (tag) tasks = tasks.filter(t => t.tags.includes(tag));
      if (priority) tasks = tasks.filter(t => t.priority === priority);

      if (tasks.length === 0) {
        return { content: [{ type: 'text', text: '📋 没有找到匹配的任务' }] };
      }

      const lines = tasks.map(t => formatTask(t));
      return {
        content: [{ type: 'text', text: `📋 任务列表 (${tasks.length} 个):\n\n${lines.join('\n')}` }],
      };
    }
  );

  // ── tool: task_get ──
  server.registerTool(
    'task_get',
    {
      title: '获取任务详情',
      description: '获取单个任务的完整信息',
      inputSchema: z.object({
        id: z.string().describe('任务 ID'),
      }),
    },
    async ({ id }) => {
      const task = await readJSON<Task>(taskPath(id));
      if (!task) {
        return { content: [{ type: 'text', text: `❌ 任务不存在: ${id}` }], isError: true };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
      };
    }
  );

  // ── tool: task_batch_delete ──
  server.registerTool(
    'task_batch_delete',
    {
      title: '批量删除任务',
      description: '批量删除多个任务。可指定 ID 列表，或设置 deleteAll=true 清空所有任务',
      inputSchema: z.object({
        ids: z.array(z.string()).default([]).describe('要删除的任务 ID 列表'),
        deleteAll: z.boolean().default(false).describe('是否删除所有任务（危险！）'),
        status: z.enum(['todo', 'in-progress', 'review', 'done', 'blocked']).optional()
          .describe('只删除指定状态的任务（可选，配合 deleteAll 使用，如只删已完成的）'),
      }),
    },
    async ({ ids, deleteAll, status }) => {
      let tasks = await getAllTasks();
      let toDelete: Task[];

      if (deleteAll) {
        toDelete = status ? tasks.filter(t => t.status === status) : tasks;
      } else if (ids.length > 0) {
        const idSet = new Set(ids);
        toDelete = tasks.filter(t => idSet.has(t.id));
      } else {
        return { content: [{ type: 'text', text: '❌ 请指定要删除的任务 ID 或设置 deleteAll=true' }], isError: true };
      }

      let deleted = 0;
      for (const t of toDelete) {
        const ok = await deleteJSON(taskPath(t.id));
        if (ok) deleted++;
      }

      const statusLabel = status ? ` (状态: ${status})` : '';
      return {
        content: [{ type: 'text', text: `🗑️ 已删除 ${deleted}/${toDelete.length} 个任务${statusLabel}` }],
      };
    }
  );

  // ── tool: task_block ──
  server.registerTool(
    'task_block',
    {
      title: '标记任务阻塞',
      description: '将任务标记为被同事或外部因素阻塞，记录阻塞人和原因',
      inputSchema: z.object({
        id: z.string().describe('任务 ID'),
        blockedBy: z.string().describe('阻塞人或团队（如 "张三"、"后端组"）'),
        reason: z.string().default('').describe('阻塞原因（如 "等待用户模块接口完成"）'),
      }),
    },
    async ({ id, blockedBy, reason }) => {
      const task = await readJSON<Task>(taskPath(id));
      if (!task) {
        return { content: [{ type: 'text', text: `❌ 任务不存在: ${id}` }], isError: true };
      }
      task.status = 'blocked';
      task.blockedBy = blockedBy;
      task.blockedReason = reason;
      task.blockedAt = new Date().toISOString();
      task.updatedAt = new Date().toISOString();
      await writeJSON(taskPath(id), task);
      return {
        content: [{ type: 'text', text: `⛔ 任务已标记阻塞: ${formatTask(task)}\n原因: ${reason || '未说明'}\n阻塞方: ${blockedBy}` }],
      };
    }
  );

  // ── tool: task_unblock ──
  server.registerTool(
    'task_unblock',
    {
      title: '解除任务阻塞',
      description: '解除任务的阻塞状态，自动恢复为 todo 并记录阻塞时长',
      inputSchema: z.object({
        id: z.string().describe('任务 ID'),
        resumeAs: z.enum(['todo', 'in-progress']).default('todo').describe('解除后恢复为什么状态'),
      }),
    },
    async ({ id, resumeAs }) => {
      const task = await readJSON<Task>(taskPath(id));
      if (!task) {
        return { content: [{ type: 'text', text: `❌ 任务不存在: ${id}` }], isError: true };
      }
      // 计算阻塞时长
      let blockedDuration = '';
      if (task.blockedAt) {
        const hours = Math.round((Date.now() - new Date(task.blockedAt).getTime()) / 3600_000);
        if (hours < 24) {
          blockedDuration = `${hours} 小时`;
        } else {
          blockedDuration = `${Math.round(hours / 24)} 天`;
        }
      }
      const prevBlocker = task.blockedBy || '未知';
      task.status = resumeAs;
      task.blockedBy = undefined;
      task.blockedReason = undefined;
      task.blockedAt = undefined;
      task.updatedAt = new Date().toISOString();
      await writeJSON(taskPath(id), task);
      return {
        content: [{ type: 'text', text: `✅ 任务已解除阻塞: ${formatTask(task)}${blockedDuration ? `\n⏱️ 阻塞时长: ${blockedDuration} (阻塞方: ${prevBlocker})` : ''}` }],
      };
    }
  );

  // ── tool: task_batch_create ──
  server.registerTool(
    'task_batch_create',
    {
      title: '批量创建任务',
      description: [
        '一次创建多个任务。AI 应根据任务内容自动推断 priority、tags、estimatedMinutes 等字段。',
        '支持临时 ID 引用同批次任务的依赖关系：dependsOn 中使用 "#1" 表示依赖本批次第 1 个任务（从 1 开始），创建后自动替换为真实 ID。',
        '也可混合使用已有的真实任务 ID。',
      ].join('\n'),
      inputSchema: z.object({
        tasks: z.array(z.object({
          title: z.string().describe('任务标题'),
          description: z.string().default('').describe('任务描述（AI 可根据标题自动生成）'),
          priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium')
            .describe('优先级（AI 应根据紧急程度自动推断）'),
          tags: z.array(z.string()).default([])
            .describe('标签列表（AI 应根据任务内容自动推断，如 backend/frontend/bugfix/design）'),
          dependsOn: z.array(z.string()).default([])
            .describe('依赖列表：使用 "#N" 引用本批次第 N 个任务（从 1 开始），或使用已有任务的真实 ID'),
          estimatedMinutes: z.number().default(30)
            .describe('预估耗时分钟数（AI 应根据任务复杂度自动推断）'),
          workspace: z.string().optional()
            .describe('工作空间（AI 应根据任务内容自动分组，同一 git 分支/项目的任务归为同一工作空间）'),
        })).min(1).describe('要创建的任务列表'),
      }),
    },
    async ({ tasks: taskInputs }) => {
      // 第一遍：创建所有任务（先不处理临时依赖）
      const created: Task[] = [];
      for (const input of taskInputs) {
        const task = await createTask({
          title: input.title,
          description: input.description,
          priority: input.priority,
          tags: input.tags,
          dependsOn: [], // 先留空
          estimatedMinutes: input.estimatedMinutes,
          workspace: input.workspace,
        });
        created.push(task);
      }

      // 第二遍：解析临时 ID 并更新依赖关系
      for (let i = 0; i < taskInputs.length; i++) {
        const deps = taskInputs[i].dependsOn;
        if (deps.length === 0) continue;

        const resolvedDeps: string[] = [];
        for (const dep of deps) {
          const match = dep.match(/^#(\d+)$/);
          if (match) {
            const idx = parseInt(match[1]) - 1; // "#1" → index 0
            if (idx >= 0 && idx < created.length) {
              resolvedDeps.push(created[idx].id);
            }
          } else {
            resolvedDeps.push(dep); // 已有的真实 ID
          }
        }

        if (resolvedDeps.length > 0) {
          created[i].dependsOn = resolvedDeps;
          created[i].updatedAt = new Date().toISOString();
          await writeJSON(taskPath(created[i].id), created[i]);
        }
      }

      // 生成结果
      const lines = [
        `✅ 批量创建 ${created.length} 个任务：`,
        '',
        '| # | ID | 标题 | 优先级 | 预估 | 标签 | 依赖 |',
        '|---|-----|------|--------|------|------|------|',
      ];
      for (let i = 0; i < created.length; i++) {
        const t = created[i];
        const depStr = t.dependsOn.length > 0
          ? t.dependsOn.map(d => {
              const idx = created.findIndex(c => c.id === d);
              return idx >= 0 ? `#${idx + 1}` : d.slice(0, 6);
            }).join(', ')
          : '—';
        lines.push(
          `| #${i + 1} | \`${t.id}\` | ${t.title} | ${t.priority} | ${t.estimatedMinutes}min | ${t.tags.join(', ') || '—'} | ${depStr} |`
        );
      }
      lines.push('', `💡 使用 \`plan_quick_start\` 可一键生成周计划和今日安排`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ── resource: task://all ──
  server.registerResource(
    'all-tasks',
    'task://all',
    {
      title: '所有任务',
      description: '返回所有任务的摘要列表',
      mimeType: 'application/json',
    },
    async () => {
      const tasks = await getAllTasks();
      const summary = tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        progress: t.progress,
      }));
      return {
        contents: [{ uri: 'task://all', text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── resource: task://{taskId} ──
  server.registerResource(
    'task-detail',
    new ResourceTemplate('task://{taskId}', {
      list: async () => {
        const tasks = await getAllTasks();
        return {
          resources: tasks.map(t => ({
            uri: `task://${t.id}`,
            name: t.title,
          })),
        };
      },
    }),
    {
      title: '任务详情',
      description: '获取单个任务的完整详情',
      mimeType: 'application/json',
    },
    async (uri, { taskId }) => {
      const task = await readJSON<Task>(taskPath(taskId as string));
      if (!task) {
        return { contents: [{ uri: uri.href, text: '{"error": "Task not found"}' }] };
      }
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(task, null, 2) }],
      };
    }
  );
}
