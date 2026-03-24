import { Config } from './config';
import { Logger } from './logger';
import { StatusBarManager } from './statusbar';
import { CDPSmartRetry } from './cdp-smart-retry';
import { CDPTargetManager } from './cdp-target-manager';

/**
 * 自动重试 — 委托给 CDPSmartRetry
 *
 * 方案 C 中，所有 Retry 逻辑通过 CDP 短连接直接操作 DOM 完成。
 * 本类保留作为 AutoAcceptor 和 CDPSmartRetry 之间的桥梁。
 */
export class AutoRetry {
    private config: Config;
    private logger: Logger;
    private cdpSmartRetry: CDPSmartRetry;

    constructor(
        config: Config,
        logger: Logger,
        statusBar: StatusBarManager,
        targetManager: CDPTargetManager,
    ) {
        this.config = config;
        this.logger = logger;
        this.cdpSmartRetry = new CDPSmartRetry(config, logger, statusBar, targetManager);
    }

    /**
     * 尝试自动重试
     */
    async tryRetry(): Promise<boolean> {
        if (!this.config.autoRetryEnabled) {
            return false;
        }

        return this.cdpSmartRetry.handleSmartRetry();
    }

    /** 重置重试计数器 */
    resetCount(): void {
        this.cdpSmartRetry.resetCounters();
    }
}
