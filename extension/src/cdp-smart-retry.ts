import { Logger } from './logger';
import { Config } from './config';
import { StatusBarManager } from './statusbar';
import { CDPTargetManager } from './cdp-target-manager';
import { EventBus } from './event-bus';
import {
    buildRetryDetectionScript,
    buildReadDebugInfoScript,
    buildClickRetryScript,
    buildSwitchModelScript,
} from './cdp-scripts';

/**
 * CDP Smart Retry — 通过 CDP 短连接检测并处理 Retry
 *
 * 工作流：
 *   1. 遍历所有 target，检测 Retry 按钮
 *   2. 读取 debug info 分析错误码
 *   3. HTTP 400 → 切换模型 → Retry → 切回
 *   4. 其他错误 → 直接 Retry
 */
export class CDPSmartRetry {
    private logger: Logger;
    private config: Config;
    private statusBar: StatusBarManager;
    private targetManager: CDPTargetManager;
    private eventBus: EventBus | null = null;

    /** 每个 target 的重试计数器 (targetId → count) */
    private retryCounters = new Map<string, number>();
    private isRetrying = false;

    constructor(
        config: Config,
        logger: Logger,
        statusBar: StatusBarManager,
        targetManager: CDPTargetManager,
        eventBus?: EventBus,
    ) {
        this.config = config;
        this.logger = logger;
        this.statusBar = statusBar;
        this.targetManager = targetManager;
        this.eventBus = eventBus || null;
    }

    /**
     * 扫描所有 target 执行 Smart Retry
     */
    async handleSmartRetry(): Promise<boolean> {
        if (!this.config.autoRetryEnabled) {
            return false;
        }
        if (this.isRetrying) {
            this.logger.debug('Smart Retry 正在执行中，跳过');
            return false;
        }

        this.isRetrying = true;
        let anyRetried = false;

        try {
            const targets = await this.targetManager.listTargets();

            for (const t of targets) {
                // 跳过 worker 和外部网页
                if (t.type === 'worker' || t.type === 'service_worker') {
                    continue;
                }
                const url = t.url || '';
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    continue;
                }

                const retryCount = this.retryCounters.get(t.id) || 0;
                if (retryCount >= this.config.maxRetries) {
                    continue;
                }

                let client: any;
                try {
                    client = await this.targetManager.connectTarget(t);
                    const { Runtime } = client;
                    await Runtime.enable();

                    // 检测 Retry 按钮
                    const detect = await Runtime.evaluate({
                        expression: buildRetryDetectionScript(),
                        returnByValue: true,
                        awaitPromise: false,
                    });

                    const info = detect?.result?.value;
                    if (!info || !info.hasRetry) {
                        // 没有 Retry 按钮 → 清零计数器
                        if (retryCount > 0) {
                            this.retryCounters.delete(t.id);
                        }
                        continue;
                    }

                    const newCount = retryCount + 1;
                    this.retryCounters.set(t.id, newCount);
                    const title = t.title || t.id?.substring(0, 8) || 'unknown';
                    this.logger.info(
                        `🔍 检测到 Retry 按钮 (target: ${title}, 第 ${newCount}/${this.config.maxRetries} 次)`,
                    );

                    if (newCount >= this.config.maxRetries) {
                        this.logger.info(
                            `  ⚠️ 已达最大重试次数 (${this.config.maxRetries})，停止自动重试`,
                        );
                        continue;
                    }

                    // 读取 debug info
                    let errorCode: number | null = null;
                    if (info.hasDebugInfo) {
                        try {
                            const debugResult = await Runtime.evaluate({
                                expression: buildReadDebugInfoScript(),
                                returnByValue: true,
                                awaitPromise: true,
                            });
                            const errInfo = debugResult?.result?.value;
                            if (errInfo) {
                                errorCode = errInfo.errorCode;
                                this.logger.info(
                                    `  📋 错误详情: HTTP ${errorCode} - ${errInfo.errorReason || errInfo.errorMessage || 'unknown'}`,
                                );
                            }
                        } catch (debugErr: any) {
                            this.logger.debug(`  读取 debug info 失败: ${debugErr.message}`);
                        }
                    }

                    // 根据错误码执行策略
                    if (errorCode === 400 && this.config.modelFallback.length > 0) {
                        await this.handleModelFallbackRetry(client, Runtime, title);
                    } else {
                        // 直接 Retry
                        this.logger.info(`  🔄 HTTP ${errorCode || '未知'} 错误，直接 Retry...`);
                        await Runtime.evaluate({
                            expression: buildClickRetryScript(),
                            returnByValue: true,
                            awaitPromise: false,
                        });
                        this.logger.info(`  ✅ 已自动 Retry (target: ${title})`);
                    }

                    this.statusBar.incrementRetry();
                    this.eventBus?.emitRetry({
                        errorCode: errorCode,
                        model: '',
                        success: true,
                        timestamp: Date.now(),
                    });
                    anyRetried = true;
                } catch (err: any) {
                    this.logger.debug(`Smart retry 失败 (${t.id}): ${err.message}`);
                } finally {
                    if (client) {
                        try {
                            await client.close();
                        } catch (_) {
                            /* ignore */
                        }
                    }
                }
            }
        } catch (err: any) {
            this.logger.error(`Smart Retry 异常: ${err.message}`);
        } finally {
            this.isRetrying = false;
        }

        return anyRetried;
    }

    /**
     * HTTP 400 模型切换重试策略
     */
    private async handleModelFallbackRetry(
        client: any,
        Runtime: any,
        title: string,
    ): Promise<void> {
        const modelFallback = this.config.modelFallback;

        // 读取当前模型
        const curModel = await Runtime.evaluate({
            expression: `(() => {
                const b = document.querySelector('[role="button"][aria-haspopup="dialog"]');
                return b ? b.textContent.trim() : null;
            })()`,
            returnByValue: true,
            awaitPromise: false,
        });
        const originalModel = curModel?.result?.value;

        // 选择 fallback 模型
        let targetModel = modelFallback[0];
        if (originalModel) {
            const lowerOriginal = originalModel.toLowerCase();
            let currentIdx = -1;
            for (let i = 0; i < modelFallback.length; i++) {
                if (lowerOriginal.includes(modelFallback[i].toLowerCase())) {
                    currentIdx = i;
                    break;
                }
            }
            targetModel = modelFallback[(currentIdx + 1) % modelFallback.length];
        }

        this.logger.info(`  ⚠️ 400 错误: 切到 ${targetModel} → Retry`);

        // 切换模型
        const sw = await Runtime.evaluate({
            expression: buildSwitchModelScript(targetModel),
            returnByValue: true,
            awaitPromise: true,
        });

        if (!sw?.result?.value?.success) {
            this.logger.info('  ❌ 切换模型失败，直接 Retry');
            await Runtime.evaluate({
                expression: buildClickRetryScript(),
                returnByValue: true,
                awaitPromise: false,
            });
            return;
        }

        this.logger.info(`  ✅ 已切换到: ${sw.result.value.model}`);
        await sleep(500);

        // 点击 Retry
        await Runtime.evaluate({
            expression: buildClickRetryScript(),
            returnByValue: true,
            awaitPromise: false,
        });
        this.logger.info('  ✅ 已点击 Retry');
        await sleep(1000);

        // 切回原模型
        const returnTo = originalModel;
        if (returnTo) {
            try {
                const swBack = await Runtime.evaluate({
                    expression: buildSwitchModelScript(returnTo),
                    returnByValue: true,
                    awaitPromise: true,
                });
                if (swBack?.result?.value?.success) {
                    this.logger.info(`  ✅ 已切回: ${swBack.result.value.model}`);
                } else {
                    this.logger.info(`  ⚠️ 切回失败: ${swBack?.result?.value?.error}`);
                }
            } catch (swErr: any) {
                this.logger.info(`  ⚠️ 切回异常: ${swErr.message}`);
            }
        }

        this.logger.info(`  🎉 400 错误恢复完成 (target: ${title})`);
    }

    /** 重置所有重试计数器 */
    resetCounters(): void {
        this.retryCounters.clear();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
