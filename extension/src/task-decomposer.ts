import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger';
import { Config } from './config';
import { CDPMessenger } from './cdp-messenger';
import { CDPTargetManager } from './cdp-target-manager';
import { IdleDetector, type SessionInfo } from './idle-detector';
import { WorkspaceRouter } from './workspace-router';
import { EventBus } from './event-bus';

/**
 * 任务信息（拆解用）
 */
interface TaskInfo {
    id: string;
    title: string;
    description?: string;
    status: string;
    priority?: string;
    tags?: string[];
    estimatedMinutes?: number;
    dependsOn?: string[];
    codeContext?: string;
    workspace?: string;
    /** 标记为 "decomposing" 表示正在拆解中 */
    decomposing?: boolean;
    /** 标记为 parent 表示已被拆解，子任务的 dependsOn 中引用此 ID */
    decomposedInto?: string[];
}

/**
 * 拆解请求队列项
 */
interface DecomposeRequest {
    taskId: string;
    title: string;
    description: string;
    workspace?: string;
    /** 用户是否需要审核（默认 true） */
    needsReview: boolean;
}

/**
 * TaskDecomposer — AI 自动任务拆解引擎
 *
 * 将粗粒度的高层任务自动拆解为可执行的子任务。
 *
 * 工作流：
 *   1. 用户标记一个任务为「需要拆解」或系统自动检测
 *   2. 生成结构化的拆解 Prompt
 *   3. 发送到一个空闲的 Agent 会话（优先使用 Opus 模型）
 *   4. Prompt 指示 AI 使用 MCP task_batch_create 工具创建子任务
 *   5. 等待 AI 完成拆解（通过 idle 检测）
 *   6. 将原始任务标记为 "decomposed"
 *   7. 通知用户审核拆解结果
 *
 * 拆解 Prompt 策略：
 *   - 要求 AI 分析任务复杂度和涉及的技术栈
 *   - 按照 L4-L1 难度等级拆解
 *   - 为每个子任务指定 priority, tags, estimatedMinutes
 *   - 设置子任务间的依赖关系（dependsOn）
 *   - 若有 workspace 信息则传递给子任务
 */
export class TaskDecomposer {
    /** 拆解请求队列 */
    private queue: DecomposeRequest[] = [];
    /** 当前正在拆解的请求 */
    private currentRequest: DecomposeRequest | null = null;
    /** 正在拆解中使用的 target */
    private activeTargetId: string | null = null;

    /** MCP 数据目录 */
    private readonly tasksDir: string;

    constructor(
        private config: Config,
        private logger: Logger,
        private eventBus: EventBus,
        private messenger: CDPMessenger,
        private cdpManager: CDPTargetManager,
        private workspaceRouter: WorkspaceRouter,
        extensionPath: string,
    ) {
        this.tasksDir = path.join(extensionPath, '.mcp-data', 'tasks');
    }

    /**
     * 请求拆解一个任务
     *
     * @param taskId       任务 ID
     * @param title        任务标题
     * @param description  任务描述（如果为空，使用 title 作为描述）
     * @param workspace    目标工作空间
     * @param needsReview  拆解后是否需要用户审核（默认 true）
     */
    async requestDecompose(
        taskId: string,
        title: string,
        description?: string,
        workspace?: string,
        needsReview: boolean = true,
    ): Promise<void> {
        // 检查是否已在队列中
        if (this.queue.some(r => r.taskId === taskId) ||
            this.currentRequest?.taskId === taskId) {
            this.logger.debug(`TaskDecomposer: 任务 "${title}" 已在拆解队列中`);
            return;
        }

        this.queue.push({
            taskId,
            title,
            description: description || title,
            workspace,
            needsReview,
        });

        // 标记原始任务为 decomposing
        await this.setTaskDecomposing(taskId, true);

        this.logger.info(`🔬 任务已加入拆解队列: "${title}" (队列长度: ${this.queue.length})`);

        // 尝试立即处理
        this.processNext();
    }

    /**
     * 处理拆解完成事件（由 PipelineScheduler 在检测到空闲时调用）
     */
    async handleDecomposeComplete(targetId: string): Promise<boolean> {
        if (this.activeTargetId !== targetId || !this.currentRequest) {
            return false;
        }

        const req = this.currentRequest;
        this.logger.info(`✅ 任务拆解完成: "${req.title}"`);

        // 标记原始任务为已拆解
        await this.setTaskDecomposing(req.taskId, false);
        await this.updateTaskStatus(req.taskId, 'done');

        // 通知用户
        if (req.needsReview) {
            const action = await vscode.window.showInformationMessage(
                `🔬 任务 "${req.title}" 已拆解完成，请在 Dashboard 中审核子任务`,
                '查看 Dashboard',
            );
            if (action === '查看 Dashboard') {
                vscode.commands.executeCommand('autoAccept.openDashboard');
            }
        } else {
            vscode.window.showInformationMessage(`🔬 任务 "${req.title}" 已自动拆解`);
        }

        this.eventBus.emitTaskNotify({
            type: 'completed',
            taskId: req.taskId,
            taskTitle: `[拆解] ${req.title}`,
            workspace: req.workspace || '',
            timestamp: Date.now(),
        });

        // 清理状态
        this.currentRequest = null;
        this.activeTargetId = null;

        // 处理下一个
        this.processNext();

        return true;
    }

    /**
     * 检查指定 target 是否正在执行拆解任务
     */
    isDecomposing(targetId: string): boolean {
        return this.activeTargetId === targetId;
    }

    /**
     * 获取拆解队列长度
     */
    get queueLength(): number {
        return this.queue.length + (this.currentRequest ? 1 : 0);
    }

    // ── 内部逻辑 ──

    /**
     * 处理队列中的下一个拆解请求
     */
    private async processNext(): Promise<void> {
        if (this.currentRequest) return; // 正在处理中
        if (this.queue.length === 0) return; // 队列为空

        const req = this.queue.shift()!;
        this.currentRequest = req;

        // 找到一个空闲的 Agent session
        const session = this.findIdleSession(req.workspace);
        if (!session) {
            this.logger.debug('TaskDecomposer: 无空闲会话可用，等待...');
            // 放回队列头部
            this.queue.unshift(req);
            this.currentRequest = null;
            return;
        }

        this.activeTargetId = session.targetId;

        // 生成拆解 Prompt
        const prompt = this.generateDecomposePrompt(req);

        this.logger.info(`🔬 开始拆解: "${req.title}" → ${session.targetTitle}`);

        // 发送到 Agent 会话
        const sent = await this.messenger.sendMessage(session.targetId, prompt);
        if (!sent) {
            this.logger.info(`❌ 拆解 Prompt 发送失败: ${session.targetTitle}`);
            this.currentRequest = null;
            this.activeTargetId = null;
            // 放回队列
            this.queue.unshift(req);
            return;
        }

        this.logger.info(`📤 拆解 Prompt 已发送 (${prompt.length} 字符)`);
    }

    /**
     * 找到一个空闲的 Agent 会话
     */
    private findIdleSession(workspace?: string): { targetId: string; targetTitle: string } | null {
        // 优先在指定 workspace 中找
        if (workspace) {
            const result = this.workspaceRouter.getIdleSessionForTask({ workspace });
            if (result) {
                const conn = this.cdpManager.getConnection(result.targetId);
                return {
                    targetId: result.targetId,
                    targetTitle: conn?.info?.title || 'unknown',
                };
            }
        }

        // 任意空闲 session
        const targets = this.cdpManager.getConnectedTargets();
        for (const { targetId, info } of targets) {
            if (info.title === 'Manager') continue;
            // 检查是否空闲
            let isIdle = true;
            for (const pool of this.workspaceRouter.getPools().values()) {
                const session = pool.sessions.get(targetId);
                if (session && session.status !== 'idle') {
                    isIdle = false;
                    break;
                }
            }
            if (isIdle) {
                return { targetId, targetTitle: info.title || 'unknown' };
            }
        }

        return null;
    }

    /**
     * 生成拆解 Prompt
     *
     * 核心策略：
     * - 指示 AI 使用 MCP `task_batch_create` 工具创建子任务
     * - 按 L4-L1 难度分级
     * - 设置合理的依赖关系
     */
    private generateDecomposePrompt(req: DecomposeRequest): string {
        const workspaceHint = req.workspace
            ? `\n所有子任务的 workspace 字段应设为 "${req.workspace}"。`
            : '';

        return `## 任务拆解请求

你是一个任务分析专家。请将以下高层任务拆解为可独立执行的子任务。

### 原始任务
**标题**: ${req.title}
**描述**: ${req.description}

### 拆解要求

请分析这个任务，将其拆解为 3-8 个子任务，并使用 MCP 工具 \`task_batch_create\` 创建它们。

每个子任务需要：

1. **title**: 清晰具体的任务标题
2. **description**: 详细的执行说明（包含参考文件、关键函数、实现思路）
3. **priority**: 基于以下规则判断
   - \`urgent\`: 架构设计、接口定义、多模块协调
   - \`high\`: 完整功能开发、算法实现、大量业务逻辑
   - \`medium\`: 明确规格的功能编码
   - \`low\`: 测试编写、文档撰写、配置修改
4. **tags**: 从以下选择 1-2 个：\`architecture\`, \`feature\`, \`bugfix\`, \`refactoring\`, \`testing\`, \`documentation\`, \`review\`
5. **estimatedMinutes**: 预估完成时间（分钟）
6. **dependsOn**: 使用 "#N" 格式引用依赖的子任务（N 从 1 开始）${workspaceHint}

### 拆解原则

- **先设计后实现**: 架构/接口设计任务排在前面
- **先核心后周边**: 核心功能先于辅助功能
- **先实现后测试**: 实现任务排在测试任务前面
- **粒度适中**: 每个子任务 15-120 分钟，避免过粗或过细

### 示例输出格式

请直接调用 \`task_batch_create\` 工具，格式如：

\`\`\`
tasks: [
  { title: "设计模块接口", priority: "urgent", tags: ["architecture"], estimatedMinutes: 60${req.workspace ? `, workspace: "${req.workspace}"` : ''} },
  { title: "实现核心功能", priority: "high", tags: ["feature"], estimatedMinutes: 90, dependsOn: ["#1"]${req.workspace ? `, workspace: "${req.workspace}"` : ''} },
  { title: "编写单元测试", priority: "low", tags: ["testing"], estimatedMinutes: 45, dependsOn: ["#2"]${req.workspace ? `, workspace: "${req.workspace}"` : ''} },
]
\`\`\`

请现在开始分析并创建子任务。完成后请简要说明拆解结果。`;
    }

    // ── 任务文件操作 ──

    /**
     * 设置任务的 decomposing 标记
     */
    private async setTaskDecomposing(taskId: string, decomposing: boolean): Promise<void> {
        try {
            if (!fs.existsSync(this.tasksDir)) return;
            const files = fs.readdirSync(this.tasksDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                const filePath = path.join(this.tasksDir, f);
                const raw = fs.readFileSync(filePath, 'utf-8');
                const task = JSON.parse(raw);
                if (task.id === taskId) {
                    task.decomposing = decomposing;
                    if (decomposing) {
                        task.status = 'in-progress';
                    }
                    task.updatedAt = new Date().toISOString();
                    fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
                    break;
                }
            }
        } catch (err: any) {
            this.logger.debug(`设置 decomposing 失败: ${err.message}`);
        }
    }

    /**
     * 更新任务状态
     */
    private async updateTaskStatus(taskId: string, status: string): Promise<void> {
        try {
            if (!fs.existsSync(this.tasksDir)) return;
            const files = fs.readdirSync(this.tasksDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                const filePath = path.join(this.tasksDir, f);
                const raw = fs.readFileSync(filePath, 'utf-8');
                const task = JSON.parse(raw);
                if (task.id === taskId) {
                    task.status = status;
                    task.decomposing = false;
                    task.updatedAt = new Date().toISOString();
                    if (status === 'done') {
                        task.completedAt = new Date().toISOString();
                    }
                    fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
                    break;
                }
            }
        } catch (err: any) {
            this.logger.debug(`更新任务状态失败: ${err.message}`);
        }
    }
}
