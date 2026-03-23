import * as vscode from 'vscode';
import { Config } from './config';
import { Logger } from './logger';
import { StatusBarManager } from './statusbar';

// antigravity-sdk 类型
type AntigravitySDKType = any;

/**
 * 自动重试 — 出错时重新发送请求
 *
 * LSBridge（sdk.ls）在当前环境下无法初始化，已去除该依赖路径。
 * 降级方案：
 *   路径 1（主）  → sdk.cascade.acceptStep() 重触发当前步骤
 *   路径 2（降级）→ vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel') 发送重试提示
 */
export class AutoRetry {
    private sdk: AntigravitySDKType;
    private config: Config;
    private logger: Logger;
    private statusBar: StatusBarManager;
    private retryCount = 0;
    private isRetrying = false;

    constructor(
        sdk: AntigravitySDKType,
        config: Config,
        logger: Logger,
        statusBar: StatusBarManager,
    ) {
        this.sdk = sdk;
        this.config = config;
        this.logger = logger;
        this.statusBar = statusBar;
    }

    /**
     * 尝试自动重试
     *
     * @returns 是否成功触发重试
     */
    async tryRetry(): Promise<boolean> {
        if (!this.config.autoRetryEnabled) {
            return false;
        }

        if (this.isRetrying) {
            this.logger.debug('正在重试中，跳过');
            return false;
        }

        if (this.retryCount >= this.config.maxRetries) {
            this.logger.info(`⚠️ 已达最大重试次数 (${this.config.maxRetries})，停止自动重试`);
            return false;
        }

        this.isRetrying = true;
        this.retryCount++;

        try {
            this.logger.info(`🔄 第 ${this.retryCount}/${this.config.maxRetries} 次重试...`);

            // 路径 1：重触发当前步骤
            try {
                await this.sdk.cascade.acceptStep();
                this.logger.info('✅ 已通过 acceptStep() 触发重试');
                this.statusBar.incrementRetry();
                return true;
            } catch (err: any) {
                this.logger.debug(`acceptStep 重试失败: ${err.message}`);
            }

            // 路径 2：发送重试提示到 Agent 面板
            try {
                await vscode.commands.executeCommand(
                    'antigravity.sendPromptToAgentPanel',
                    { text: '请重试上一步操作' },
                );
                this.logger.info('✅ 已通过 sendPromptToAgentPanel 触发重试');
                this.statusBar.incrementRetry();
                return true;
            } catch (err: any) {
                this.logger.debug(`sendPromptToAgentPanel 重试失败: ${err.message}`);
            }

            this.logger.info('⚠️ 所有重试路径均失败');
            return false;
        } catch (err: any) {
            this.logger.error(`自动重试异常: ${err.message}`);
            return false;
        } finally {
            this.isRetrying = false;
        }
    }

    /** 重置重试计数器 */
    resetCount(): void {
        this.retryCount = 0;
    }
}
