import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger';
import { Config } from './config';
import { CDPMessenger } from './cdp-messenger';
import { EventBus } from './event-bus';
import type { SessionInfo } from './idle-detector';

/**
 * 任务派发器 — 从 MCP Task Hub 获取任务，通过 CDP 发送 Prompt
 *
 * 直接读取 MCP 的 JSON 数据文件（与 MCP Server 同机器，零 IPC 开销）
 *
 * 流程:
 *   1. 读取 tasks/ 目录，筛选 night-safe + todo 的任务
 *   2. 按优先级和预估时间排序
 *   3. 生成结构化 Prompt
 *   4. 通过 CDPMessenger 发送到目标会话
 *   5. 更新任务状态为 in-progress
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
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
    actualMinutes?: number;
}

export interface DispatchResult {
    success: boolean;
    taskId?: string;
    taskTitle?: string;
    targetId: string;
    error?: string;
}

export class TaskDispatcher {
    /** 每个 target 正在执行的任务 ID */
    private activeTaskMap = new Map<string, string>();
    /** 单任务超时定时器 */
    private taskTimers = new Map<string, NodeJS.Timeout>();
    private paused = false;

    /** MCP 数据目录 */
    private readonly tasksDir: string;

    constructor(
        private config: Config,
        private messenger: CDPMessenger,
        private logger: Logger,
        private eventBus: EventBus,
        extensionPath: string,
    ) {
        // MCP 数据存储在 extension/.mcp-data/tasks/
        this.tasksDir = path.join(extensionPath, '.mcp-data', 'tasks');
    }

    pause(): void {
        this.paused = true;
        this.logger.info('⏸ 任务派发已暂停');
    }

    resume(): void {
        this.paused = false;
        this.logger.info('▶️ 任务派发已恢复');
    }

    /** 检查指定 target 是否有正在执行的任务 */
    hasActiveTask(targetId: string): boolean {
        return this.activeTaskMap.has(targetId);
    }

    /**
     * 为指定空闲会话派发下一个任务
     */
    async dispatchNext(session: SessionInfo): Promise<DispatchResult> {
        if (this.paused) {
            return { success: false, targetId: session.targetId, error: '任务派发已暂停（额度耗尽？）' };
        }

        // 检查是否已有任务在执行
        if (this.activeTaskMap.has(session.targetId)) {
            return { success: false, targetId: session.targetId, error: '该会话已有任务在执行' };
        }

        // 获取下一个任务
        const task = await this.getNextTask();
        if (!task) {
            return { success: false, targetId: session.targetId, error: '任务队列为空' };
        }

        // 生成 Prompt
        const prompt = this.generatePrompt(task);

        // 发送 Prompt
        this.logger.info(`📋 派发任务: "${task.title}" → ${session.targetTitle}`);
        const sent = await this.messenger.sendMessage(session.targetId, prompt);
        if (!sent) {
            return { success: false, targetId: session.targetId, taskId: task.id, error: 'CDP 消息发送失败' };
        }

        // 标记任务为 in-progress
        await this.updateTaskStatus(task.id, 'in-progress');
        this.activeTaskMap.set(session.targetId, task.id);

        // 启动超时定时器
        const maxMs = (this.config.maxTaskDurationMinutes || 120) * 60 * 1000;
        const timer = setTimeout(() => {
            this.handleTaskTimeout(session.targetId, task.id, task.title);
        }, maxMs);
        this.taskTimers.set(session.targetId, timer);

        // 发送事件
        this.eventBus.emitDispatch({
            targetId: session.targetId,
            taskId: task.id,
            taskTitle: task.title,
            promptLength: prompt.length,
            timestamp: Date.now(),
        });

        return {
            success: true,
            targetId: session.targetId,
            taskId: task.id,
            taskTitle: task.title,
        };
    }

    /**
     * 标记指定会话的当前任务为完成
     */
    async markCurrentTaskDone(targetId: string): Promise<void> {
        const taskId = this.activeTaskMap.get(targetId);
        if (!taskId) return;

        this.activeTaskMap.delete(targetId);
        const timer = this.taskTimers.get(targetId);
        if (timer) {
            clearTimeout(timer);
            this.taskTimers.delete(targetId);
        }

        await this.updateTaskStatus(taskId, 'done');
        this.logger.info(`✅ 任务完成: ${taskId}`);
    }

    /**
     * 获取下一个可执行的 night-safe 任务
     */
    private async getNextTask(): Promise<TaskInfo | null> {
        try {
            if (!fs.existsSync(this.tasksDir)) {
                this.logger.debug(`TaskDispatcher: 任务目录不存在: ${this.tasksDir}`);
                return null;
            }

            const files = fs.readdirSync(this.tasksDir).filter(f => f.endsWith('.json'));
            const tasks: TaskInfo[] = [];

            for (const f of files) {
                try {
                    const raw = fs.readFileSync(path.join(this.tasksDir, f), 'utf-8');
                    tasks.push(JSON.parse(raw));
                } catch (_) { /* skip corrupted files */ }
            }

            // 当前正在执行的任务 ID 集合
            const activeTasks = new Set(this.activeTaskMap.values());

            // 筛选条件
            const candidates = tasks.filter(t =>
                t.status === 'todo' &&
                !activeTasks.has(t.id) &&
                (!this.config.nightSafeOnly || t.tags?.includes('night-safe')) &&
                this.checkDependencies(t, tasks),
            );

            if (candidates.length === 0) return null;

            // 排序：priority desc → estimatedMinutes asc
            const pMap: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
            candidates.sort((a, b) => {
                const pa = pMap[a.priority || 'medium'] || 2;
                const pb = pMap[b.priority || 'medium'] || 2;
                if (pb !== pa) return pb - pa;
                return (a.estimatedMinutes || 30) - (b.estimatedMinutes || 30);
            });

            return candidates[0];
        } catch (err: any) {
            this.logger.debug(`TaskDispatcher: 读取任务失败: ${err.message}`);
            return null;
        }
    }

    /** 检查任务的所有依赖是否已完成 */
    private checkDependencies(task: TaskInfo, allTasks: TaskInfo[]): boolean {
        if (!task.dependsOn || task.dependsOn.length === 0) return true;
        return task.dependsOn.every(depId =>
            allTasks.find(t => t.id === depId)?.status === 'done',
        );
    }

    /**
     * 生成夜间任务 Prompt
     */
    private generatePrompt(task: TaskInfo): string {
        const parts = [
            `## 任务: ${task.title}`,
            '',
            task.description || '',
            '',
            '## 执行要求',
            '- 这是一个夜间自动任务，当前无人值守',
            '- 遇到需要用户确认的操作，请采用最安全的默认选项',
            '- 遇到无法独立解决的问题，请在 walkthrough 中记录并标记为 blocked',
            '- 完成后请调用 notify_user 报告完成结果',
        ];

        if (task.codeContext) {
            parts.push('', `## 代码上下文`, task.codeContext);
        }

        if (task.workspace) {
            parts.push('', `## 工作空间: ${task.workspace}`);
        }

        return parts.filter(Boolean).join('\n');
    }

    /**
     * 更新任务 JSON 文件状态
     */
    private async updateTaskStatus(
        taskId: string,
        status: 'in-progress' | 'done' | 'blocked',
    ): Promise<void> {
        try {
            // 找到任务文件
            const files = fs.readdirSync(this.tasksDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                const filePath = path.join(this.tasksDir, f);
                const raw = fs.readFileSync(filePath, 'utf-8');
                const task = JSON.parse(raw);
                if (task.id === taskId) {
                    task.status = status;
                    task.updatedAt = new Date().toISOString();
                    if (status === 'in-progress') {
                        task.startedAt = new Date().toISOString();
                    } else if (status === 'done') {
                        task.completedAt = new Date().toISOString();
                        if (task.startedAt) {
                            task.actualMinutes = Math.round(
                                (Date.now() - new Date(task.startedAt).getTime()) / 60000,
                            );
                        }
                    }
                    fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
                    break;
                }
            }
        } catch (err: any) {
            this.logger.debug(`更新任务状态失败: ${err.message}`);
        }
    }

    /** 任务超时处理 */
    private handleTaskTimeout(targetId: string, taskId: string, taskTitle: string): void {
        this.logger.info(`⏰ 任务超时: "${taskTitle}" (${this.config.maxTaskDurationMinutes}min)`);
        this.activeTaskMap.delete(targetId);
        this.taskTimers.delete(targetId);
        this.updateTaskStatus(taskId, 'blocked').catch(() => {});

        this.eventBus.emitTaskComplete({
            targetId,
            taskId,
            taskTitle,
            durationMs: (this.config.maxTaskDurationMinutes || 120) * 60 * 1000,
            success: false,
            timestamp: Date.now(),
        });
    }

    dispose(): void {
        for (const timer of this.taskTimers.values()) {
            clearTimeout(timer);
        }
        this.taskTimers.clear();
        this.activeTaskMap.clear();
    }
}
