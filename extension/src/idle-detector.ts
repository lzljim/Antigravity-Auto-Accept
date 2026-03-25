import * as vscode from 'vscode';
import { Logger } from './logger';
import { Config } from './config';
import { CDPTargetManager } from './cdp-target-manager';
import { EventBus } from './event-bus';
import { buildIdleDetectionScript } from './cdp-scripts';

/**
 * 会话空闲检测器
 *
 * 定时探测各个 Agent 会话的 DOM 状态，判断是否处于
 * "已完成任务、等待用户输入" 的空闲状态。
 *
 * 采用双重确认机制：首次检测到空闲后等待一段时间再次确认，
 * 避免 AI 思考间歇期被误判为空闲。
 */

export interface SessionInfo {
    targetId: string;
    targetTitle: string;
    idleSince: number;
}

export class IdleDetector implements vscode.Disposable {
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    /** 首次检测到空闲的时间（targetId → timestamp） */
    private pendingIdle = new Map<string, number>();
    /** 已确认空闲的 target（避免重复触发） */
    private confirmedIdle = new Set<string>();

    /** 双重确认等待时间 */
    private static readonly CONFIRM_DELAY_MS = 30_000; // 30s
    /** 探测间隔 */
    private static readonly PROBE_INTERVAL_MS = 15_000; // 15s

    private _onIdle = new vscode.EventEmitter<SessionInfo>();
    readonly onIdle = this._onIdle.event;

    constructor(
        private config: Config,
        private eventBus: EventBus,
        private cdpManager: CDPTargetManager,
        private logger: Logger,
    ) {
        // 有新的点击事件 → 说明会话不是空闲的，清除该 target 的空闲标记
        eventBus.onClick((e) => {
            this.clearIdleState(e.target);
        });
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.logger.info('🔍 空闲检测器已启动');

        this.timer = setInterval(() => {
            if (this.running) {
                this.probeAll().catch(err =>
                    this.logger.debug(`空闲探测异常: ${err.message}`)
                );
            }
        }, IdleDetector.PROBE_INTERVAL_MS);

        // 立即执行一次
        this.probeAll().catch(() => {});
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.pendingIdle.clear();
        this.confirmedIdle.clear();
        this.logger.info('⏹ 空闲检测器已停止');
    }

    /** 标记某个 target 为"已派发任务"，从空闲集合中移除 */
    markBusy(targetId: string): void {
        this.clearIdleState(targetId);
    }

    /** 清除某个 target 的空闲状态 */
    private clearIdleState(targetIdOrTitle: string): void {
        // 按 targetId 清除
        this.pendingIdle.delete(targetIdOrTitle);
        this.confirmedIdle.delete(targetIdOrTitle);
        // 按 title 查找并清除
        for (const [id] of this.pendingIdle) {
            const conn = this.cdpManager.getConnection(id);
            if (conn?.info?.title === targetIdOrTitle) {
                this.pendingIdle.delete(id);
                this.confirmedIdle.delete(id);
            }
        }
    }

    /**
     * 探测所有持久连接的 Agent target
     */
    private async probeAll(): Promise<void> {
        const targets = this.cdpManager.getConnectedTargets();
        if (targets.length === 0) return;

        const script = buildIdleDetectionScript();

        for (const { targetId, info } of targets) {
            // 跳过 Manager target
            if (info.title === 'Manager') continue;
            // 跳过已确认空闲的（等待 NightPilot 处理）
            if (this.confirmedIdle.has(targetId)) continue;

            try {
                const conn = this.cdpManager.getConnection(targetId);
                if (!conn?.ready) continue;

                const result = await conn.client.Runtime.evaluate({
                    expression: script,
                    returnByValue: true,
                    awaitPromise: false,
                });

                const state = result?.result?.value;
                if (!state) continue;

                if (state.isIdle) {
                    const now = Date.now();
                    const pendingSince = this.pendingIdle.get(targetId);

                    if (!pendingSince) {
                        // 首次检测到空闲 → 进入等待确认
                        this.pendingIdle.set(targetId, now);
                        this.logger.debug(
                            `💤 可能空闲: ${info.title || targetId.substring(0, 8)} (等待确认...)`,
                        );
                    } else if (now - pendingSince >= IdleDetector.CONFIRM_DELAY_MS) {
                        // 双重确认通过 → 确认空闲
                        this.confirmedIdle.add(targetId);
                        this.pendingIdle.delete(targetId);

                        const session: SessionInfo = {
                            targetId,
                            targetTitle: info.title || 'unknown',
                            idleSince: pendingSince,
                        };

                        this.logger.info(
                            `😴 会话已空闲: ${session.targetTitle} (空闲 ${Math.round((now - pendingSince) / 1000)}s)`,
                        );

                        this.eventBus.emitIdle({
                            targetId,
                            targetTitle: session.targetTitle,
                            idleDurationMs: now - pendingSince,
                            timestamp: now,
                        });

                        this._onIdle.fire(session);
                    }
                    // else: 还在等待确认期，不做任何事
                } else {
                    // 不空闲 → 清除 pending
                    if (this.pendingIdle.has(targetId)) {
                        this.logger.debug(
                            `✅ 会话活跃: ${info.title || targetId.substring(0, 8)} (清除 pending)`,
                        );
                        this.pendingIdle.delete(targetId);
                    }
                }
            } catch (err: any) {
                this.logger.debug(`探测 ${targetId} 失败: ${err.message}`);
            }
        }
    }

    dispose(): void {
        this.stop();
        this._onIdle.dispose();
    }
}
