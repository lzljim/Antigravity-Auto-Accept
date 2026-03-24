import * as vscode from 'vscode';
import { Config } from './config';
import { Logger } from './logger';
import { StatusBarManager } from './statusbar';
import { AgentUI } from './agent-ui';
import { CDPTargetManager } from './cdp-target-manager';
import { CDPSmartRetry } from './cdp-smart-retry';
import { EventBus } from './event-bus';
import { CDPRenamer } from './cdp-renamer';

// antigravity-sdk 类型（运行时动态导入以兼容 SDK 不存在的情况）
type AntigravitySDKType = any;

/**
 * 自动接受器 — 核心逻辑（方案 C：SDK 信号驱动 + CDP 短连接执行）
 *
 * 架构：
 *   - SDK Monitor (信号层): 监听 Agent 步骤变化、状态变化等事件
 *   - CDP TargetManager (执行层): 收到信号后短连接扫描 DOM → 点击按钮
 *   - 保底定时扫描 (安全网): 15s 间隔兜底，防止信号遗漏
 *
 * 信号流：
 *   SDK.onStepCountChanged → targetManager.scan('stepChanged')
 *   SDK.onStateChanged     → targetManager.scan('stateChanged')
 *   定时器 (15s)           → targetManager.scan('fallback')
 */
export class AutoAcceptor implements vscode.Disposable {
    private sdk: AntigravitySDKType;
    private config: Config;
    private logger: Logger;
    private statusBar: StatusBarManager;
    private agentUI: AgentUI;

    private targetManager: CDPTargetManager;
    private smartRetry: CDPSmartRetry;

    private running = false;
    private disposables: vscode.Disposable[] = [];

    constructor(
        sdk: AntigravitySDKType,
        config: Config,
        logger: Logger,
        statusBar: StatusBarManager,
        agentUI: AgentUI,
        eventBus?: EventBus,
        renamer?: CDPRenamer,
    ) {
        this.sdk = sdk;
        this.config = config;
        this.logger = logger;
        this.statusBar = statusBar;
        this.agentUI = agentUI;

        // 创建 CDP 模块（注入 EventBus 和 Renamer）
        this.targetManager = new CDPTargetManager(config, logger, statusBar, renamer, eventBus);
        this.smartRetry = new CDPSmartRetry(config, logger, statusBar, this.targetManager, eventBus);

        // 监听配置变化
        this.disposables.push(
            this.config.onDidChange(() => this.onConfigChanged()),
        );
    }

    /** 启动监听 */
    async start(): Promise<void> {
        if (this.running) {
            this.logger.debug('AutoAcceptor 已在运行中，跳过');
            return;
        }

        this.running = true;
        this.statusBar.setConnected(true);
        this.logger.info('==========================================');
        this.logger.info('  Auto Accept 已启动（方案C: SDK信号 + CDP执行）');
        this.logger.info('==========================================');
        this.logger.info(`  CDP 调试端口    : ${this.config.cdpPort}`);
        this.logger.info(`  按钮白名单      : ${this.config.buttonTexts.join(', ')}`);
        this.logger.info(`  自动重试        : ${this.config.autoRetryEnabled ? '是' : '否'}`);
        this.logger.info(`  SDK 监听间隔    : ${this.config.monitorPollInterval}ms`);
        this.logger.info('==========================================');
        this.logger.info('');

        // 初始化 CDP
        const cdpReady = await this.targetManager.initialize();
        if (!cdpReady) {
            this.logger.error('CDP 初始化失败，自动接受功能不可用');
            this.statusBar.setError('CDP 未就绪');
            return;
        }

        // 启动 CDP 保底扫描
        this.targetManager.start();

        // 设置 SDK Monitor（信号层）
        this.setupMonitor();

        this.logger.info('👀 正在监听 Agent 操作...');
    }

    /** 停止监听 */
    stop(): void {
        if (!this.running) {
            return;
        }

        this.running = false;
        this.statusBar.setConnected(false);

        // 停止 CDP
        this.targetManager.stop();

        // 停止 SDK Monitor
        try {
            this.sdk.monitor?.stop?.();
        } catch (_) {
            // ignore
        }

        this.logger.info('⏸ Auto Accept 已暂停');
    }

    /** 切换开关 */
    async toggle(): Promise<void> {
        const newEnabled = await this.config.toggle();

        if (newEnabled) {
            await this.start();
            vscode.window.showInformationMessage('✅ Auto Accept 已开启');
        } else {
            this.stop();
            vscode.window.showInformationMessage('⏸ Auto Accept 已关闭');
        }
    }

    /** 重置计数器 */
    resetCount(): void {
        this.statusBar.resetCounts();
        this.smartRetry.resetCounters();
        this.logger.info('🔁 计数器已重置');
    }

    /** 获取 CDP 目标管理器（供外部查询状态） */
    get cdpManager(): CDPTargetManager {
        return this.targetManager;
    }

    /**
     * 设置 SDK 事件监听器（信号层）
     *
     * SDK 事件作为信号触发 CDP 扫描：
     *   - onStepCountChanged → 新步骤，可能有待确认按钮
     *   - onStateChanged → 内部状态变化，可能有新弹窗
     *   - onNewConversation → 新会话，重置重试计数器
     */
    private setupMonitor(): void {
        const pollInterval = this.config.monitorPollInterval;

        // 步骤变化 → 触发 CDP 扫描
        try {
            this.sdk.monitor.onStepCountChanged(async (e: any) => {
                if (!this.running) { return; }
                this.logger.info(`📨 步骤变化: ${e.title} (${e.previousCount}→${e.newCount})`);
                await this.targetManager.scan('stepChanged');

                // 步骤变化后也检查是否需要 Smart Retry
                if (this.config.autoRetryEnabled) {
                    await this.smartRetry.handleSmartRetry();
                }
            });
        } catch (err: any) {
            this.logger.debug(`注册 onStepCountChanged 失败: ${err.message}`);
        }

        // 状态变化 → 触发 CDP 扫描
        try {
            this.sdk.monitor.onStateChanged(async (e: any) => {
                if (!this.running) { return; }
                this.logger.debug(`状态变化: ${e.key} (${e.previousSize}→${e.newSize} bytes)`);
                await this.targetManager.scan('stateChanged');
            });
        } catch (err: any) {
            this.logger.debug(`注册 onStateChanged 失败: ${err.message}`);
        }

        // 新会话 → 重置重试计数器
        try {
            this.sdk.monitor.onNewConversation(() => {
                this.logger.info('📝 检测到新会话');
                this.smartRetry.resetCounters();
            });
        } catch (err: any) {
            this.logger.debug(`注册 onNewConversation 失败: ${err.message}`);
        }

        // 启动 SDK Monitor
        try {
            this.sdk.monitor.start(pollInterval, pollInterval);
            this.logger.info(`🔄 SDK 事件监听已启动 (间隔: ${pollInterval}ms)`);
        } catch (err: any) {
            this.logger.info(`⚠️ SDK 事件监听启动失败: ${err.message}`);
            this.logger.info('📡 将仅依赖 CDP 保底扫描...');
        }
    }

    /**
     * 配置变更回调
     */
    private onConfigChanged(): void {
        this.logger.logLevel = this.config.logLevel;

        if (this.config.enabled && !this.running) {
            this.start();
        } else if (!this.config.enabled && this.running) {
            this.stop();
        }

        this.logger.info('⚙️ 配置已更新');
    }

    dispose(): void {
        this.stop();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
