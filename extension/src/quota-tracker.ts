import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger';
import { Config } from './config';
import { EventBus } from './event-bus';

/**
 * 额度追踪器 — 追踪 Token 窗口使用情况
 *
 * 由于 Antigravity 不暴露原生额度 API，采用间接推断策略：
 *   - 通过 EventBus 的 click/retry/dispatch 事件计数估算使用量
 *   - 通过 Smart Retry 检测 HTTP 429/400 判定额度耗尽
 *   - 按 quotaWindowHours 切分窗口，持久化到 JSON 文件
 */

export interface WindowInfo {
    startTime: number;
    endTime: number;
    taskCount: number;
    clickCount: number;
    retryCount: number;
    dispatchCount: number;
    exhausted: boolean;
    exhaustedAt?: number;
}

export class QuotaTracker implements vscode.Disposable {
    private currentWindow: WindowInfo | null = null;
    private windowHistory: WindowInfo[] = [];

    /** 窗口持续时长 */
    private get windowDurationMs(): number {
        return (this.config.quotaWindowHours || 5) * 60 * 60 * 1000;
    }

    private _onQuotaExhausted = new vscode.EventEmitter<void>();
    readonly onQuotaExhausted = this._onQuotaExhausted.event;
    private _onQuotaRefreshed = new vscode.EventEmitter<void>();
    readonly onQuotaRefreshed = this._onQuotaRefreshed.event;

    private windowCheckTimer: NodeJS.Timeout | null = null;
    private readonly dataFilePath: string;

    constructor(
        private config: Config,
        private eventBus: EventBus,
        private logger: Logger,
        storagePath: string,
    ) {
        this.dataFilePath = path.join(storagePath, 'quota-history.json');

        // 监听事件累计使用量
        eventBus.onClick(() => this.recordUsage('click'));
        eventBus.onRetry((e) => {
            this.recordUsage('retry');
            // HTTP 429 = 明确速率限制
            if (e.errorCode === 429) {
                this.markExhausted();
            }
        });
        eventBus.onDispatch(() => this.recordUsage('dispatch'));
    }

    start(): void {
        this.loadHistory();
        this.ensureCurrentWindow();

        // 每分钟检查窗口边界
        this.windowCheckTimer = setInterval(() => {
            this.checkWindowBoundary();
        }, 60_000);

        this.logger.info('📊 额度追踪器已启动');
    }

    stop(): void {
        if (this.windowCheckTimer) {
            clearInterval(this.windowCheckTimer);
            this.windowCheckTimer = null;
        }
        this.saveHistory();
        this.logger.info('📊 额度追踪器已停止');
    }

    /** 记录使用事件 */
    private recordUsage(type: 'click' | 'retry' | 'dispatch'): void {
        this.ensureCurrentWindow();
        if (!this.currentWindow) return;

        switch (type) {
            case 'click': this.currentWindow.clickCount++; break;
            case 'retry': this.currentWindow.retryCount++; break;
            case 'dispatch': this.currentWindow.dispatchCount++; this.currentWindow.taskCount++; break;
        }
    }

    /** 标记当前窗口额度耗尽 */
    markExhausted(): void {
        this.ensureCurrentWindow();
        if (!this.currentWindow || this.currentWindow.exhausted) return;

        this.currentWindow.exhausted = true;
        this.currentWindow.exhaustedAt = Date.now();
        this.logger.info('⚠️ 额度追踪器: 当前窗口已标记为耗尽');
        this._onQuotaExhausted.fire();
        this.saveHistory();
    }

    /** 获取当前窗口信息 */
    getCurrentWindow(): WindowInfo | null {
        this.ensureCurrentWindow();
        return this.currentWindow;
    }

    /** 获取过去 24h 的窗口历史 */
    getRecentHistory(hours = 24): WindowInfo[] {
        const cutoff = Date.now() - hours * 60 * 60 * 1000;
        return [...this.windowHistory, ...(this.currentWindow ? [this.currentWindow] : [])]
            .filter(w => w.endTime > cutoff)
            .sort((a, b) => b.startTime - a.startTime);
    }

    /** 计算最近 24h 的综合利用率估算（有活动的窗口占比） */
    getUtilizationRate(hours = 24): number {
        const windows = this.getRecentHistory(hours);
        if (windows.length === 0) return 0;
        const active = windows.filter(w =>
            w.clickCount > 0 || w.dispatchCount > 0 || w.taskCount > 0,
        ).length;
        return Math.round((active / windows.length) * 100);
    }

    // ── 内部逻辑 ──

    private ensureCurrentWindow(): void {
        const now = Date.now();
        if (this.currentWindow && now < this.currentWindow.endTime) {
            return; // 当前窗口仍有效
        }

        // 归档旧窗口
        if (this.currentWindow) {
            this.windowHistory.push(this.currentWindow);
            // 只保留最近 48h 的历史
            const cutoff = now - 48 * 60 * 60 * 1000;
            this.windowHistory = this.windowHistory.filter(w => w.endTime > cutoff);
        }

        // 创建新窗口
        const windowMs = this.windowDurationMs;
        const windowStart = Math.floor(now / windowMs) * windowMs;
        this.currentWindow = {
            startTime: windowStart,
            endTime: windowStart + windowMs,
            taskCount: 0,
            clickCount: 0,
            retryCount: 0,
            dispatchCount: 0,
            exhausted: false,
        };

        this.logger.info(
            `📊 新窗口开始: ${new Date(windowStart).toLocaleTimeString('zh-CN', { hour12: false })} ~ ` +
            `${new Date(windowStart + windowMs).toLocaleTimeString('zh-CN', { hour12: false })}`,
        );
    }

    private checkWindowBoundary(): void {
        const now = Date.now();
        if (this.currentWindow && now >= this.currentWindow.endTime) {
            const wasExhausted = this.currentWindow.exhausted;
            this.ensureCurrentWindow();
            this.saveHistory();

            // 如果上个窗口额度耗尽，新窗口开始 → 额度刷新
            if (wasExhausted) {
                this.logger.info('🔋 额度追踪器: 新窗口开始，额度已刷新');
                this._onQuotaRefreshed.fire();
            }
        }
    }

    private loadHistory(): void {
        try {
            if (fs.existsSync(this.dataFilePath)) {
                const raw = fs.readFileSync(this.dataFilePath, 'utf-8');
                const data = JSON.parse(raw);
                this.windowHistory = data.history || [];
                // 不恢复 currentWindow — 每次启动创建新的
            }
        } catch (err: any) {
            this.logger.debug(`加载额度历史失败: ${err.message}`);
        }
    }

    private saveHistory(): void {
        try {
            const dir = path.dirname(this.dataFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = {
                history: this.windowHistory,
                currentWindow: this.currentWindow,
                savedAt: new Date().toISOString(),
            };
            fs.writeFileSync(this.dataFilePath, JSON.stringify(data, null, 2));
        } catch (err: any) {
            this.logger.debug(`保存额度历史失败: ${err.message}`);
        }
    }

    dispose(): void {
        this.stop();
        this._onQuotaExhausted.dispose();
        this._onQuotaRefreshed.dispose();
    }
}
