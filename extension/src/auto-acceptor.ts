import * as vscode from 'vscode';
import { Config } from './config';
import { Logger } from './logger';
import { StatusBarManager } from './statusbar';
import { AgentUI } from './agent-ui';
import { AutoRetry } from './auto-retry';

// antigravity-sdk 类型（运行时动态导入以兼容 SDK 不存在的情况）
type AntigravitySDKType = any;

/**
 * 自动接受器 — 核心逻辑
 *
 * 使用 antigravity-sdk 的原生 API 监听 Agent 活动，
 * 并根据配置自动接受代码编辑、终端命令等操作。
 */
export class AutoAcceptor implements vscode.Disposable {
    private sdk: AntigravitySDKType;
    private config: Config;
    private logger: Logger;
    private statusBar: StatusBarManager;
    private agentUI: AgentUI;
    private autoRetry: AutoRetry;
    private running = false;
    private disposables: vscode.Disposable[] = [];

    constructor(
        sdk: AntigravitySDKType,
        config: Config,
        logger: Logger,
        statusBar: StatusBarManager,
        agentUI: AgentUI,
    ) {
        this.sdk = sdk;
        this.config = config;
        this.logger = logger;
        this.statusBar = statusBar;
        this.agentUI = agentUI;
        this.autoRetry = new AutoRetry(sdk, config, logger, statusBar);

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
        this.logger.info('  Auto Accept 已启动（原生 API 模式）');
        this.logger.info('==========================================');
        this.logger.info(`  自动接受代码编辑 : ${this.config.acceptCodeEdits ? '是' : '否'}`);
        this.logger.info(`  自动接受终端命令 : ${this.config.acceptTerminalCommands ? '是' : '否'}`);
        this.logger.info(`  自动接受其他操作 : ${this.config.acceptOtherActions ? '是' : '否'}`);
        this.logger.info(`  自动重试         : ${this.config.autoRetryEnabled ? '是' : '否'}`);
        this.logger.info(`  监听间隔         : ${this.config.monitorPollInterval}ms`);
        this.logger.info('==========================================');
        this.logger.info('');
        this.logger.info('👀 正在监听 Agent 操作...');

        try {
            this.setupMonitor();
        } catch (err: any) {
            this.logger.error(`启动监听失败: ${err.message}`);
            this.running = false;
            this.statusBar.setError(err.message);
        }
    }

    /** 停止监听 */
    stop(): void {
        if (!this.running) {
            return;
        }

        this.running = false;
        this.statusBar.setConnected(false);
        this.logger.info('⏸ Auto Accept 已暂停');

        try {
            this.sdk.monitor?.stop?.();
        } catch (_) {
            // ignore
        }
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
        this.autoRetry.resetCount();
        this.logger.info('🔁 计数器已重置');
    }

    /**
     * 设置 SDK 事件监听器
     */
    private setupMonitor(): void {
        const pollInterval = this.config.monitorPollInterval;

        // Agent 步骤数变化 → 可能有新的待确认操作
        try {
            this.sdk.monitor.onStepCountChanged(async (e: any) => {
                if (!this.running) { return; }
                this.logger.info(`📨 步骤变化: ${e.title} (${e.previousCount}→${e.newCount})`);
                await this.tryAcceptAll();
            });
        } catch (err: any) {
            this.logger.debug(`注册 onStepCountChanged 失败: ${err.message}`);
        }

        // 状态变化事件 → 可能出现"Run command?"弹窗
        try {
            this.sdk.monitor.onStateChanged(async (e: any) => {
                if (!this.running) { return; }
                this.logger.debug(`状态变化: ${e.key} (${e.previousSize}→${e.newSize} bytes)`);
                await this.tryAcceptAll();
            });
        } catch (err: any) {
            this.logger.debug(`注册 onStateChanged 失败: ${err.message}`);
        }

        // 新会话创建事件
        try {
            this.sdk.monitor.onNewConversation(() => {
                this.logger.info('📝 检测到新会话');
                this.autoRetry.resetCount();
            });
        } catch (err: any) {
            this.logger.debug(`注册 onNewConversation 失败: ${err.message}`);
        }

        // 启动监听
        try {
            this.sdk.monitor.start(pollInterval, pollInterval);
            this.logger.info(`🔄 事件监听已启动 (轮询间隔: ${pollInterval}ms)`);
        } catch (err: any) {
            this.logger.error(`启动事件监听失败: ${err.message}`);
            this.startFallbackPolling();
        }
    }

    /**
     * 退回轮询模式（当 SDK 事件监听不可用时）
     */
    private startFallbackPolling(): void {
        this.logger.info('📡 切换到轮询模式...');

        const interval = setInterval(async () => {
            if (!this.running) {
                clearInterval(interval);
                return;
            }

            await this.tryAcceptAll();
        }, this.config.monitorPollInterval);

        this.disposables.push({ dispose: () => clearInterval(interval) });
    }

    /**
     * 尝试接受所有类型的待确认操作
     *
     * 使用 vscode.commands.executeCommand 调用真实注册的命令。
     * 注意：executeCommand 在"无操作"时不抛错，无法区分成功与无操作。
     */
    private async tryAcceptAll(): Promise<void> {

        if (this.config.acceptCodeEdits) {
            await this.execCommand('antigravity.prioritized.agentAcceptFocusedHunk', '接受聚焦代码块');
            await this.execCommand('antigravity.prioritized.agentAcceptAllInFile', '接受文件所有改动');
        }

        if (this.config.acceptTerminalCommands) {
            await this.execCommand('antigravity.prioritized.supercompleteAccept', '接受终端/补全');
        }

        if (this.config.acceptOtherActions) {
            // 暂无通用 accept 命令，后续根据日志补充
        }
    }

    /**
     * 执行一个 VS Code 命令并记录日志
     *
     * - 成功：debug 级别（因为 executeCommand 无法区分"接受了"和"无操作"）
     * - 失败：info 级别（说明命令根本不存在，需要关注）
     */
    private async execCommand(commandId: string, label: string): Promise<void> {
        try {
            await vscode.commands.executeCommand(commandId);
            this.logger.debug(`  ✓ ${label}`);
        } catch (err: any) {
            this.logger.info(`  ✗ ${label}: ${err.message || err}`);
        }
    }

    /**
     * 安全地尝试执行一次接受操作，日志记录详细结果
     * 保留此方法用于 SDK 原生 API（当底层命令修复后可切回）
     */
    private async tryAccept(
        fn: () => Promise<any> | Thenable<any>,
        type: string,
        context: string,
    ): Promise<boolean> {
        this.logger.debug(`  → 尝试 ${type}  (${context})`);
        try {
            await fn();
            this.statusBar.incrementCount();
            this.logger.info(`✅ 自动接受了: [${type}]  ctx=${context}`);
            return true;
        } catch (err: any) {
            const msg = err.message || String(err);
            const isNoPending =
                msg.includes('no pending') ||
                msg.includes('not found') ||
                msg.includes('Nothing to accept') ||
                msg.includes('command not found') ||
                msg.includes('No active') ||
                msg.includes('nothing to');
            if (isNoPending) {
                this.logger.debug(`  ← 无待接受(${type}): ${msg}`);
            } else {
                this.logger.debug(`  ← 失败(${type}): ${msg}`);
            }
            return false;
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
