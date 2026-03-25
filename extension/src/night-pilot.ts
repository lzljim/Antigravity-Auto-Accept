import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger';
import { Config } from './config';
import { EventBus, type NightMode } from './event-bus';
import { CDPTargetManager } from './cdp-target-manager';
import { CDPMessenger } from './cdp-messenger';
import { IdleDetector, type SessionInfo } from './idle-detector';
import { TaskDispatcher } from './task-dispatcher';
import { QuotaTracker } from './quota-tracker';
import { NightReport } from './night-report';
import { buildQuotaExhaustionDetectionScript } from './cdp-scripts';

/**
 * NightPilot — 夜间调度总控
 *
 * 管理模式切换、子模块生命周期、全局状态机。
 *
 * 状态机:
 *   off → standby → active → paused → active → off
 *
 * 职责:
 *   - 定时或手动激活/关闭夜间模式
 *   - 空闲检测 → 派发任务闭环
 *   - 额度耗尽 → 暂停 → 刷新 → 恢复
 *   - 夜间工作数据收集
 */
export class NightPilot implements vscode.Disposable {
    private mode: NightMode = 'off';

    private idleDetector: IdleDetector;
    private taskDispatcher: TaskDispatcher;
    private messenger: CDPMessenger;
    private quotaTracker: QuotaTracker;
    private nightReport: NightReport;

    private schedulerTimer: NodeJS.Timeout | null = null;
    private quotaCheckTimer: NodeJS.Timeout | null = null;
    private disposables: vscode.Disposable[] = [];

    /** 夜间工作统计 */
    private nightStats = {
        activatedAt: 0,
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
        this.taskDispatcher = new TaskDispatcher(config, this.messenger, logger, eventBus, extensionPath);

        const storagePath = path.join(extensionPath, '.mcp-data');
        this.quotaTracker = new QuotaTracker(config, eventBus, logger, storagePath);
        this.nightReport = new NightReport(this.quotaTracker, logger, storagePath);

        // 订阅空闲事件 → 派发任务
        this.disposables.push(
            this.idleDetector.onIdle((session) => this.handleSessionIdle(session)),
        );

        // 订阅 QuotaTracker 事件
        this.disposables.push(
            this.quotaTracker.onQuotaExhausted(() => this.handleQuotaExhausted()),
            this.quotaTracker.onQuotaRefreshed(() => this.handleQuotaRefreshed()),
        );

        // 订阅派发事件 → 统计
        eventBus.onDispatch(() => { this.nightStats.tasksDispatched++; });
        eventBus.onTaskComplete((e) => {
            if (e.success) {
                this.nightStats.tasksCompleted++;
            } else {
                this.nightStats.tasksFailed++;
            }
        });
    }

    /** 当前模式 */
    get currentMode(): NightMode {
        return this.mode;
    }

    /**
     * 切换夜间模式
     */
    async toggle(): Promise<void> {
        if (this.mode === 'off') {
            await this.activate();
            vscode.window.showInformationMessage('🌙 夜间模式已激活');
        } else {
            this.deactivate();
            vscode.window.showInformationMessage('☀️ 夜间模式已关闭');
        }
    }

    /**
     * 激活夜间模式
     */
    async activate(): Promise<void> {
        if (this.mode !== 'off') {
            this.logger.debug('NightPilot: 已在运行中');
            return;
        }

        this.logger.info('');
        this.logger.info('==========================================');
        this.logger.info('  🌙 夜间模式已激活');
        this.logger.info('==========================================');
        this.logger.info(`  仅 night-safe: ${this.config.nightSafeOnly ? '是' : '否'}`);
        this.logger.info(`  最大任务时间: ${this.config.maxTaskDurationMinutes}min`);
        this.logger.info(`  空闲阈值: ${this.config.idleThresholdSeconds}s`);
        this.logger.info(`  额度窗口: ${this.config.quotaWindowHours}h`);
        this.logger.info('==========================================');
        this.logger.info('');

        // 重置统计
        this.nightStats = {
            activatedAt: Date.now(),
            tasksDispatched: 0,
            tasksCompleted: 0,
            tasksFailed: 0,
            quotaExhaustedCount: 0,
        };

        // 启动子模块
        this.idleDetector.start();
        this.quotaTracker.start();
        this.startQuotaMonitor();

        // 设置自动停止定时器
        this.startAutoDeactivateTimer();

        // 切换状态
        this.setMode(this.cdpManager.connected ? 'active' : 'standby');

        // 如果当前没有 CDP 连接，等待连接
        if (!this.cdpManager.connected) {
            this.logger.info('⏳ 等待 CDP 连接...');
            this.eventBus.onStatus((e) => {
                if (e.connected && this.mode === 'standby') {
                    this.setMode('active');
                }
            });
        }
    }

    /**
     * 停止夜间模式
     */
    deactivate(): void {
        if (this.mode === 'off') return;

        // 停止子模块
        this.idleDetector.stop();
        this.quotaTracker.stop();
        this.stopQuotaMonitor();

        if (this.schedulerTimer) {
            clearTimeout(this.schedulerTimer);
            this.schedulerTimer = null;
        }

        // 生成晨间报告
        const reportData = this.nightReport.generate(this.nightStats);
        this.nightReport.logReport(reportData);
        this.nightReport.save(reportData).catch(() => {});

        this.setMode('off');
    }

    /**
     * 检查是否应该自动激活（用于启动时检查）
     */
    checkAutoActivate(): void {
        const hour = new Date().getHours();
        const activateHour = this.config.autoActivateHour;
        const deactivateHour = this.config.autoDeactivateHour;

        let shouldActivate = false;
        if (activateHour < deactivateHour) {
            // 如 23 ~ 9：不跨天的不太对，应该是 activateHour > deactivateHour
            shouldActivate = hour >= activateHour && hour < deactivateHour;
        } else {
            // 如 23 ~ 9：跨天
            shouldActivate = hour >= activateHour || hour < deactivateHour;
        }

        if (shouldActivate && this.config.nightModeEnabled) {
            this.logger.info('🕐 自动激活夜间模式（在预设时间范围内）');
            this.activate();
        }
    }

    /**
     * 生成夜间工作报告
     */
    showReport(): void {
        const reportData = this.nightReport.generate(this.nightStats);
        this.nightReport.logReport(reportData);

        // 尝试保存并打开 Markdown 文件
        this.nightReport.save(reportData).then(filePath => {
            if (filePath) {
                Promise.resolve(
                    vscode.commands.executeCommand('markdown.showPreview',
                        vscode.Uri.file(filePath),
                    ),
                ).catch(() => {});
            }
        });

        vscode.window.showInformationMessage(
            `🌅 夜间报告: 派发 ${reportData.tasksDispatched} · 完成 ${reportData.tasksCompleted} · 利用率 ${reportData.quotaUtilization}%`,
        );
    }

    // ── 内部逻辑 ──────────────────────────────────────────

    /** 会话空闲 → 派发任务 */
    private async handleSessionIdle(session: SessionInfo): Promise<void> {
        if (this.mode !== 'active') {
            this.logger.debug(`NightPilot: 非 active 状态，跳过派发`);
            return;
        }

        // 先标记当前任务完成（如果有）
        await this.taskDispatcher.markCurrentTaskDone(session.targetId);

        // 派发下一个任务
        const result = await this.taskDispatcher.dispatchNext(session);
        if (result.success) {
            this.logger.info(
                `🚀 任务已派发: "${result.taskTitle}" → ${session.targetTitle}`,
            );
            this.idleDetector.markBusy(session.targetId);
        } else {
            this.logger.info(`📭 未派发任务: ${result.error}`);
            if (result.error === '任务队列为空') {
                this.setMode('standby');
                this.logger.info('📭 所有任务已完成，进入待命模式');
            }
        }
    }

    /** 额度耗尽处理 */
    private handleQuotaExhausted(): void {
        if (this.mode !== 'active') return;
        this.nightStats.quotaExhaustedCount++;
        this.logger.info('⚠️ 检测到额度可能耗尽，暂停任务派发');
        this.taskDispatcher.pause();
        this.setMode('paused');
    }

    /** 额度刷新处理（TODO: 需要更精确的检测） */
    private handleQuotaRefreshed(): void {
        if (this.mode !== 'paused') return;
        this.logger.info('🔋 额度已刷新，恢复任务派发');
        this.taskDispatcher.resume();
        this.setMode('active');
    }

    /** 额度监控定时器 */
    private startQuotaMonitor(): void {
        // 每 5 分钟检查一次额度状态
        this.quotaCheckTimer = setInterval(async () => {
            if (this.mode !== 'active' && this.mode !== 'paused') return;

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
                    if (state?.hasRateLimit && this.mode === 'active') {
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
        }, 5 * 60 * 1000); // 5min
    }

    private stopQuotaMonitor(): void {
        if (this.quotaCheckTimer) {
            clearInterval(this.quotaCheckTimer);
            this.quotaCheckTimer = null;
        }
    }

    /** 自动停止定时器 */
    private startAutoDeactivateTimer(): void {
        const now = new Date();
        const deactivateHour = this.config.autoDeactivateHour;
        const target = new Date(now);
        target.setHours(deactivateHour, 0, 0, 0);

        // 如果目标时间已过，设置为明天
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }

        const ms = target.getTime() - now.getTime();
        this.logger.info(
            `⏰ 自动停止时间: ${target.toLocaleTimeString('zh-CN', { hour12: false })} (${(ms / 3600000).toFixed(1)}h 后)`,
        );

        this.schedulerTimer = setTimeout(() => {
            this.logger.info('⏰ 到达自动停止时间');
            this.deactivate();
        }, ms);
    }

    /** 设置模式并发出事件 */
    private setMode(mode: NightMode): void {
        const prev = this.mode;
        this.mode = mode;
        this.logger.info(`🌙 模式变更: ${prev} → ${mode}`);
        this.eventBus.emitNightMode({
            mode,
            reason: `${prev} → ${mode}`,
            timestamp: Date.now(),
        });
    }

    dispose(): void {
        this.deactivate();
        this.taskDispatcher.dispose();
        this.idleDetector.dispose();
        this.quotaTracker.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
