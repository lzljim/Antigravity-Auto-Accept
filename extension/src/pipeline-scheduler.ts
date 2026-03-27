import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger';
import { Config } from './config';
import {
    EventBus,
    type PipelineMode,
    type PipelineStateEvent,
} from './event-bus';
import { CDPTargetManager } from './cdp-target-manager';
import { CDPMessenger } from './cdp-messenger';
import { IdleDetector, type SessionInfo } from './idle-detector';
import { WorkspaceRouter } from './workspace-router';
import { QuotaTracker } from './quota-tracker';
import { buildQuotaExhaustionDetectionScript } from './cdp-scripts';
import { ModelRouter } from './model-router';
import { ModelSwitcher } from './model-switcher';
import { TaskDecomposer } from './task-decomposer';

/**
 * 任务信息
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

/**
 * PipelineScheduler — 全天候任务流水线调度器
 *
 * 基于 NightPilot 架构，升级为全天候、多 Workspace 感知的流水线。
 *
 * 状态机：off → running → paused → running → off
 *
 * 核心闭环：
 *   IdleDetector.onIdle(session)
 *     → WorkspaceRouter.resolve(session)
 *     → 从该 workspace 任务队列取最高优先级任务
 *     → CDPMessenger.sendMessage(prompt)
 *     → 监控完成 → 通知用户
 */
export class PipelineScheduler implements vscode.Disposable {
    private mode: PipelineMode = 'off';

    private idleDetector: IdleDetector;
    private messenger: CDPMessenger;
    private workspaceRouter: WorkspaceRouter;
    private quotaTracker: QuotaTracker;
    private modelRouter: ModelRouter;
    private modelSwitcher: ModelSwitcher;
    private taskDecomposer: TaskDecomposer;

    private quotaCheckTimer: NodeJS.Timeout | null = null;
    private syncTimer: NodeJS.Timeout | null = null;
    private stateUpdateTimer: NodeJS.Timeout | null = null;
    private disposables: vscode.Disposable[] = [];

    /** 每个 target 正在执行的任务 ID */
    private activeTaskMap = new Map<string, string>();
    /** 单任务超时定时器 */
    private taskTimers = new Map<string, NodeJS.Timeout>();
    /** 冷却中的 target（避免连续派发） */
    private cooldownTargets = new Set<string>();

    /** MCP 数据目录 */
    private readonly tasksDir: string;
    private readonly storagePath: string;

    /** 统计 */
    private stats = {
        startedAt: 0,
        tasksDispatched: 0,
        tasksCompleted: 0,
        tasksFailed: 0,
        quotaExhaustedCount: 0,
    };

    constructor(
        private config: Config,
        private logger: Logger,
        private eventBus: EventBus,
        private cdpManager: CDPTargetManager,
        extensionPath: string,
    ) {
        this.messenger = new CDPMessenger(cdpManager, logger);
        this.idleDetector = new IdleDetector(config, eventBus, cdpManager, logger);
        this.workspaceRouter = new WorkspaceRouter(config, cdpManager, logger);
        this.modelRouter = new ModelRouter(config, logger);
        this.modelSwitcher = new ModelSwitcher(cdpManager, logger);
        this.taskDecomposer = new TaskDecomposer(
            config, logger, eventBus, this.messenger,
            cdpManager, this.workspaceRouter, extensionPath,
        );

        this.storagePath = path.join(extensionPath, '.mcp-data');
        this.tasksDir = path.join(this.storagePath, 'tasks');
        this.quotaTracker = new QuotaTracker(config, eventBus, logger, this.storagePath);

        // 空闲事件 → 派发任务
        this.disposables.push(
            this.idleDetector.onIdle((session) => this.handleSessionIdle(session)),
        );

        // 额度事件
        this.disposables.push(
            this.quotaTracker.onQuotaExhausted(() => this.handleQuotaExhausted()),
            this.quotaTracker.onQuotaRefreshed(() => this.handleQuotaRefreshed()),
        );

        // 统计
        eventBus.onDispatch(() => { this.stats.tasksDispatched++; });
        eventBus.onTaskComplete((e) => {
            if (e.success) this.stats.tasksCompleted++;
            else this.stats.tasksFailed++;
        });
    }

    get currentMode(): PipelineMode {
        return this.mode;
    }

    /**
     * 切换 Pipeline
     */
    async toggle(): Promise<void> {
        if (this.mode === 'off') {
            await this.start();
            vscode.window.showInformationMessage('🏭 Pipeline 已启动');
        } else {
            this.stop();
            vscode.window.showInformationMessage('⏹ Pipeline 已停止');
        }
    }

    /**
     * 启动 Pipeline
     */
    async start(): Promise<void> {
        if (this.mode !== 'off') {
            this.logger.debug('PipelineScheduler: 已在运行中');
            return;
        }

        this.logger.info('');
        this.logger.info('==========================================');
        this.logger.info('  🏭 Pipeline 已启动');
        this.logger.info('==========================================');

        const workspaces = this.config.pipelineWorkspaces;
        for (const ws of workspaces) {
            this.logger.info(`  📂 ${ws.name} (branch: ${ws.branch || '-'})`);
        }
        this.logger.info(`  隔离模式: ${this.config.workspaceIsolation}`);
        this.logger.info(`  任务超时: ${this.config.taskTimeout}min`);
        this.logger.info(`  冷却间隔: ${this.config.cooldownBetweenTasks}s`);
        this.logger.info('==========================================');
        this.logger.info('');

        // 重置统计
        this.stats = {
            startedAt: Date.now(),
            tasksDispatched: 0,
            tasksCompleted: 0,
            tasksFailed: 0,
            quotaExhaustedCount: 0,
        };

        // 启动子模块
        this.workspaceRouter.rebuildPools();
        this.idleDetector.start();
        this.quotaTracker.start();
        this.startQuotaMonitor();

        // 定期同步 targets → workspace
        this.syncTimer = setInterval(() => {
            this.workspaceRouter.syncTargets();
        }, 10_000);
        this.workspaceRouter.syncTargets();

        // 定期推送状态到 Dashboard
        this.stateUpdateTimer = setInterval(() => {
            this.broadcastState();
        }, 5_000);

        this.setMode(this.cdpManager.connected ? 'running' : 'off');

        if (!this.cdpManager.connected) {
            this.logger.info('⏳ 等待 CDP 连接...');
            const handler = (e: any) => {
                if (e.connected && this.mode === 'off') {
                    this.setMode('running');
                }
            };
            this.eventBus.onStatus(handler);
        }
    }

    /**
     * 停止 Pipeline
     */
    stop(): void {
        if (this.mode === 'off') return;

        this.idleDetector.stop();
        this.quotaTracker.stop();
        this.stopQuotaMonitor();

        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
        if (this.stateUpdateTimer) {
            clearInterval(this.stateUpdateTimer);
            this.stateUpdateTimer = null;
        }

        // 清理任务超时计时器
        for (const timer of this.taskTimers.values()) {
            clearTimeout(timer);
        }
        this.taskTimers.clear();
        this.activeTaskMap.clear();
        this.cooldownTargets.clear();

        this.setMode('off');
        this.broadcastState();

        this.logger.info('⏹ Pipeline 已停止');
    }

    /**
     * 快速添加任务
     */
    async addTask(title: string, workspace?: string): Promise<string | null> {
        try {
            if (!fs.existsSync(this.tasksDir)) {
                fs.mkdirSync(this.tasksDir, { recursive: true });
            }

            const id = this.generateId();
            const task: TaskInfo = {
                id,
                title,
                status: 'todo',
                priority: 'medium',
                workspace: workspace || undefined,
                createdAt: new Date().toISOString(),
            };

            const filePath = path.join(this.tasksDir, `${id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(task, null, 2));

            this.logger.info(`➕ 任务已添加: "${title}" (${workspace || 'no workspace'})`);
            this.broadcastState();

            return id;
        } catch (err: any) {
            this.logger.debug(`添加任务失败: ${err.message}`);
            return null;
        }
    }

    /**
     * 请求拆解一个任务
     */
    async decomposeTask(taskId: string): Promise<void> {
        const tasks = this.readAllTasks();
        const task = tasks.find(t => t.id === taskId);
        if (!task) {
            this.logger.debug(`TaskDecompose: 任务 ${taskId} 不存在`);
            return;
        }

        await this.taskDecomposer.requestDecompose(
            task.id,
            task.title,
            task.description,
            task.workspace,
        );

        this.broadcastState();
    }

    /**
     * 通过标题快速添加并拆解任务
     */
    async addAndDecompose(title: string, workspace?: string): Promise<void> {
        const id = await this.addTask(title, workspace);
        if (id) {
            await this.decomposeTask(id);
        }
    }

    // ── 内部逻辑 ──

    /**
     * 会话空闲 → 派发任务
     */
    private async handleSessionIdle(session: SessionInfo): Promise<void> {
        if (this.mode !== 'running') return;

        const { targetId } = session;

        // 冷却检查
        if (this.cooldownTargets.has(targetId)) return;

        // 检查是否是拆解任务完成
        if (this.taskDecomposer.isDecomposing(targetId)) {
            const handled = await this.taskDecomposer.handleDecomposeComplete(targetId);
            if (handled) {
                this.broadcastState();
                return;
            }
        }

        // 先标记当前任务完成（如果有）
        const prevTaskId = this.activeTaskMap.get(targetId);
        if (prevTaskId) {
            await this.markTaskDone(targetId, prevTaskId, true);
        }

        // 查找该 target 所属的 workspace
        this.workspaceRouter.syncTargets();

        // 获取 workspace 感知的下一个任务
        const task = await this.getNextTaskForTarget(targetId);
        if (!task) {
            this.logger.debug(`📭 ${session.targetTitle}: 无可派发任务`);
            return;
        }

        // ── 智能模型路由 ──
        let routedModel: string | undefined;
        if (this.config.modelRoutingEnabled) {
            // 获取 workspace 的偏好模型
            let preferredModels: string[] | undefined;
            for (const [wsName, pool] of this.workspaceRouter.getPools()) {
                if (pool.sessions.has(targetId)) {
                    preferredModels = pool.config.preferredModels;
                    break;
                }
            }

            const routing = this.modelRouter.resolveModel(task, preferredModels);
            routedModel = routing.model;

            // 通过 CDP 切换模型
            const switchResult = await this.modelSwitcher.switchModel(targetId, routing.model);
            if (!switchResult.success) {
                this.logger.debug(`⚠️ 模型切换失败 (${switchResult.error})，继续使用当前模型派发`);
            }
        }

        // 生成 Prompt 并发送
        const prompt = this.generatePrompt(task);
        this.logger.info(`📋 派发任务: "${task.title}" → ${session.targetTitle}${routedModel ? ` [${this.modelRouter.getDisplayName(routedModel)}]` : ''}`);

        const sent = await this.messenger.sendMessage(targetId, prompt);
        if (!sent) {
            this.logger.info(`❌ 消息发送失败: ${session.targetTitle}`);
            return;
        }

        // 更新状态
        const displayModel = routedModel ? this.modelRouter.getDisplayName(routedModel) : undefined;
        await this.updateTaskStatus(task.id, 'in-progress');
        this.activeTaskMap.set(targetId, task.id);
        this.workspaceRouter.setSessionStatus(targetId, 'busy', task.id, task.title, displayModel);
        this.idleDetector.markBusy(targetId);

        // 启动超时定时器
        const maxMs = this.config.taskTimeout * 60 * 1000;
        const timer = setTimeout(() => {
            this.handleTaskTimeout(targetId, task.id, task.title);
        }, maxMs);
        this.taskTimers.set(targetId, timer);

        // 冷却
        this.cooldownTargets.add(targetId);
        setTimeout(() => {
            this.cooldownTargets.delete(targetId);
        }, this.config.cooldownBetweenTasks * 1000);

        // 发送事件
        this.eventBus.emitDispatch({
            targetId,
            taskId: task.id,
            taskTitle: task.title,
            promptLength: prompt.length,
            timestamp: Date.now(),
        });

        this.eventBus.emitTaskNotify({
            type: 'dispatched',
            taskId: task.id,
            taskTitle: task.title,
            workspace: task.workspace || '',
            timestamp: Date.now(),
        });

        this.broadcastState();
    }

    /**
     * 获取指定 target 的下一个可执行任务（workspace 感知）
     */
    private async getNextTaskForTarget(targetId: string): Promise<TaskInfo | null> {
        try {
            if (!fs.existsSync(this.tasksDir)) return null;

            const files = fs.readdirSync(this.tasksDir).filter(f => f.endsWith('.json'));
            const tasks: TaskInfo[] = [];

            for (const f of files) {
                try {
                    const raw = fs.readFileSync(path.join(this.tasksDir, f), 'utf-8');
                    tasks.push(JSON.parse(raw));
                } catch (_) { /* skip */ }
            }

            // 正在执行的任务 ID
            const activeTasks = new Set(this.activeTaskMap.values());

            // 找到 target 所属的 workspace
            let targetWorkspace: string | null = null;
            for (const [wsName, pool] of this.workspaceRouter.getPools()) {
                if (pool.sessions.has(targetId)) {
                    targetWorkspace = wsName;
                    break;
                }
            }

            // 筛选候选任务
            const candidates = tasks.filter(t => {
                if (t.status !== 'todo') return false;
                if (activeTasks.has(t.id)) return false;
                if (!this.checkDependencies(t, tasks)) return false;

                // workspace 隔离
                if (this.config.workspaceIsolation === 'strict') {
                    if (t.workspace && targetWorkspace && t.workspace !== targetWorkspace) return false;
                    if (t.workspace && !targetWorkspace) return false;
                }

                return true;
            });

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
            this.logger.debug(`获取任务失败: ${err.message}`);
            return null;
        }
    }

    /** 检查依赖 */
    private checkDependencies(task: TaskInfo, allTasks: TaskInfo[]): boolean {
        if (!task.dependsOn || task.dependsOn.length === 0) return true;
        return task.dependsOn.every(depId =>
            allTasks.find(t => t.id === depId)?.status === 'done',
        );
    }

    /** 生成 Prompt */
    private generatePrompt(task: TaskInfo): string {
        const parts = [
            `## 任务: ${task.title}`,
            '',
            task.description || '',
            '',
            '## 执行要求',
            '- 完成后请调用 notify_user 报告完成结果',
            '- 遇到无法独立解决的问题，请在 walkthrough 中记录并标记为 blocked',
        ];

        if (task.codeContext) {
            parts.push('', `## 代码上下文`, task.codeContext);
        }
        if (task.workspace) {
            parts.push('', `## 工作空间: ${task.workspace}`);
        }

        return parts.filter(Boolean).join('\n');
    }

    /** 标记任务完成 */
    private async markTaskDone(targetId: string, taskId: string, success: boolean): Promise<void> {
        this.activeTaskMap.delete(targetId);
        const timer = this.taskTimers.get(targetId);
        if (timer) {
            clearTimeout(timer);
            this.taskTimers.delete(targetId);
        }

        this.workspaceRouter.setSessionStatus(targetId, 'idle');
        await this.updateTaskStatus(taskId, success ? 'done' : 'blocked');

        // 获取任务信息用于通知
        const taskTitle = await this.getTaskTitle(taskId);
        const workspace = await this.getTaskWorkspace(taskId);

        if (success) {
            this.logger.info(`✅ 任务完成: "${taskTitle}"`);

            // VS Code 通知
            vscode.window.showInformationMessage(
                `✅ 任务完成: "${taskTitle}"${workspace ? ` (${workspace})` : ''}`,
            );
        }

        this.eventBus.emitTaskNotify({
            type: success ? 'completed' : 'failed',
            taskId,
            taskTitle: taskTitle || taskId,
            workspace: workspace || '',
            timestamp: Date.now(),
        });

        this.eventBus.emitTaskComplete({
            targetId,
            taskId,
            taskTitle: taskTitle || taskId,
            durationMs: 0,
            success,
            timestamp: Date.now(),
        });

        this.broadcastState();
    }

    /** 任务超时 */
    private handleTaskTimeout(targetId: string, taskId: string, taskTitle: string): void {
        this.logger.info(`⏰ 任务超时: "${taskTitle}" (${this.config.taskTimeout}min)`);
        this.activeTaskMap.delete(targetId);
        this.taskTimers.delete(targetId);
        this.workspaceRouter.setSessionStatus(targetId, 'idle');
        this.updateTaskStatus(taskId, 'blocked').catch(() => {});

        vscode.window.showWarningMessage(`⏰ 任务超时: "${taskTitle}"`);

        this.eventBus.emitTaskNotify({
            type: 'blocked',
            taskId,
            taskTitle,
            workspace: '',
            timestamp: Date.now(),
        });

        this.broadcastState();
    }

    /** 额度耗尽 */
    private handleQuotaExhausted(): void {
        if (this.mode !== 'running') return;
        this.stats.quotaExhaustedCount++;
        this.logger.info('⚠️ 额度耗尽，暂停 Pipeline');
        this.setMode('paused');
    }

    /** 额度刷新 */
    private handleQuotaRefreshed(): void {
        if (this.mode !== 'paused') return;
        this.logger.info('🔋 额度已刷新，恢复 Pipeline');
        this.setMode('running');
    }

    /** 额度监控 */
    private startQuotaMonitor(): void {
        this.quotaCheckTimer = setInterval(async () => {
            if (this.mode !== 'running' && this.mode !== 'paused') return;

            try {
                const targets = this.cdpManager.getConnectedTargets();
                const script = buildQuotaExhaustionDetectionScript();

                for (const { targetId, info } of targets) {
                    if (info.title === 'Manager') continue;
                    const conn = this.cdpManager.getConnection(targetId);
                    if (!conn?.ready) continue;

                    const result = await conn.client.Runtime.evaluate({
                        expression: script,
                        returnByValue: true,
                        awaitPromise: false,
                    });

                    const state = result?.result?.value;
                    if (state?.hasRateLimit && this.mode === 'running') {
                        this.handleQuotaExhausted();
                        this.eventBus.emitQuota({
                            type: 'exhausted',
                            windowStart: Date.now(),
                            estimatedUsage: 100,
                            timestamp: Date.now(),
                        });
                        break;
                    } else if (!state?.hasRateLimit && this.mode === 'paused') {
                        this.handleQuotaRefreshed();
                        this.eventBus.emitQuota({
                            type: 'refreshed',
                            windowStart: Date.now(),
                            estimatedUsage: 0,
                            timestamp: Date.now(),
                        });
                        break;
                    }
                }
            } catch (err: any) {
                this.logger.debug(`额度检查异常: ${err.message}`);
            }
        }, 5 * 60 * 1000);
    }

    private stopQuotaMonitor(): void {
        if (this.quotaCheckTimer) {
            clearInterval(this.quotaCheckTimer);
            this.quotaCheckTimer = null;
        }
    }

    /** 设置模式 */
    private setMode(mode: PipelineMode): void {
        const prev = this.mode;
        this.mode = mode;
        this.logger.info(`🏭 Pipeline: ${prev} → ${mode}`);
        this.broadcastState();
    }

    /** 广播状态到 EventBus → Dashboard */
    private broadcastState(): void {
        const taskStats = this.getTaskStats();
        const wsSnapshot = this.workspaceRouter.getStateSnapshot();

        // 填充每个 workspace 的队列数
        const tasks = this.readAllTasks();
        for (const ws of wsSnapshot) {
            ws.queueCount = tasks.filter(t =>
                t.status === 'todo' && t.workspace === ws.name,
            ).length;
        }

        const event: PipelineStateEvent = {
            mode: this.mode,
            workspaces: wsSnapshot,
            stats: taskStats,
            timestamp: Date.now(),
        };

        this.eventBus.emitPipelineState(event);
    }

    /** 获取任务统计 */
    private getTaskStats(): { queued: number; running: number; done: number; blocked: number } {
        const tasks = this.readAllTasks();
        return {
            queued: tasks.filter(t => t.status === 'todo').length,
            running: tasks.filter(t => t.status === 'in-progress').length,
            done: tasks.filter(t => t.status === 'done').length,
            blocked: tasks.filter(t => t.status === 'blocked').length,
        };
    }

    /** 读取所有任务 */
    private readAllTasks(): TaskInfo[] {
        try {
            if (!fs.existsSync(this.tasksDir)) return [];
            const files = fs.readdirSync(this.tasksDir).filter(f => f.endsWith('.json'));
            const tasks: TaskInfo[] = [];
            for (const f of files) {
                try {
                    const raw = fs.readFileSync(path.join(this.tasksDir, f), 'utf-8');
                    tasks.push(JSON.parse(raw));
                } catch (_) { /* skip */ }
            }
            return tasks;
        } catch (_) {
            return [];
        }
    }

    /** 更新任务状态 */
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

    /** 获取任务标题 */
    private async getTaskTitle(taskId: string): Promise<string> {
        const tasks = this.readAllTasks();
        return tasks.find(t => t.id === taskId)?.title || taskId;
    }

    /** 获取任务 workspace */
    private async getTaskWorkspace(taskId: string): Promise<string> {
        const tasks = this.readAllTasks();
        return tasks.find(t => t.id === taskId)?.workspace || '';
    }

    /** 生成唯一 ID */
    private generateId(): string {
        return `task-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
    }

    dispose(): void {
        this.stop();
        this.idleDetector.dispose();
        this.quotaTracker.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
