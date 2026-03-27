import * as vscode from 'vscode';
import { Config } from './config';
import { Logger } from './logger';
import { StatusBarManager } from './statusbar';
import { AutoAcceptor } from './auto-acceptor';
import { AgentUI } from './agent-ui';
import { EventBus } from './event-bus';
import { CDPRenamer } from './cdp-renamer';
import { McpManager } from './mcp-manager';
import { DashboardViewProvider } from './webview-provider';
import { NightPilot } from './night-pilot';
import { PipelineScheduler } from './pipeline-scheduler';

/**
 * Antigravity Auto-Accept Extension
 *
 * 方案 C：SDK 信号驱动 + CDP 短连接执行
 * - SDK Monitor 监听 Agent 活动，作为信号源
 * - CDP 短连接扫描 DOM 并点击按钮，作为执行引擎
 */

let acceptor: AutoAcceptor | undefined;
let mcpManager: McpManager | undefined;
let nightPilot: NightPilot | undefined;
let pipelineScheduler: PipelineScheduler | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Logger();
    const config = new Config();

    // 同步日志级别
    logger.logLevel = config.logLevel;

    logger.info('Auto Accept 插件加载中...');

    // ---- 初始化 antigravity-sdk（可选，作为信号源） ----
    let sdk: any;
    try {
        const { AntigravitySDK } = require('antigravity-sdk');
        sdk = new AntigravitySDK(context);
        await sdk.initialize();
        logger.info('✅ antigravity-sdk 初始化成功（信号源就绪）');
    } catch (err: any) {
        logger.info(`⚠️ antigravity-sdk 不可用: ${err.message}`);
        logger.info('📡 将仅依赖 CDP 保底扫描（无 SDK 信号加速）');
        sdk = createStubSdk();
    }

    // ---- 创建状态栏 ----
    const statusBar = new StatusBarManager(config);

    // ---- 创建 Agent View UI 集成 ----
    const agentUI = new AgentUI(sdk, logger);

    // ---- 创建事件总线 + 重命名器 ----
    const eventBus = new EventBus();
    const storagePath = context.globalStorageUri.fsPath;
    const renamer = new CDPRenamer(storagePath, logger);

    // ---- 创建自动接受器 ----
    acceptor = new AutoAcceptor(sdk, config, logger, statusBar, agentUI, eventBus, renamer);

    // ---- 注册 WebView Dashboard ----
    const dashboardProvider = new DashboardViewProvider(context.extensionUri, eventBus);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DashboardViewProvider.viewType,
            dashboardProvider,
        ),
    );

    // ---- MCP Server 管理（异步启动，失败不阻塞） ----
    mcpManager = new McpManager(context.extensionPath, logger);
    mcpManager.start().catch((e: any) => {
        logger.info(`[MCP] 启动失败（非致命）: ${e.message}`);
    });

    // ---- 夜间调度 ----
    nightPilot = new NightPilot(
        config, logger, eventBus,
        acceptor.cdpManager,
        context.extensionPath,
    );

    // 夜间模式状态同步到状态栏
    eventBus.onNightMode((e) => statusBar.setNightMode(e.mode));

    // ---- Pipeline 调度器 ----
    pipelineScheduler = new PipelineScheduler(
        config, logger, eventBus,
        acceptor.cdpManager,
        context.extensionPath,
    );

    // Pipeline 状态同步到状态栏
    eventBus.onPipelineState((e) => {
        statusBar.setPipelineStats(e.stats, e.mode);
    });

    // ---- 注册命令 ----
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAccept.toggle', () => {
            acceptor?.toggle();
        }),

        vscode.commands.registerCommand('autoAccept.showLog', () => {
            logger.show();
        }),

        vscode.commands.registerCommand('autoAccept.resetCount', () => {
            acceptor?.resetCount();
            vscode.window.showInformationMessage('🔁 Auto Accept 计数器已重置');
        }),

        vscode.commands.registerCommand('autoAccept.openDashboard', () => {
            vscode.commands.executeCommand('autoAccept.dashboard.focus');
        }),

        vscode.commands.registerCommand('autoAccept.exploreApi', () => {
            exploreApi(acceptor!, sdk, logger);
        }),

        vscode.commands.registerCommand('autoAccept.nightMode.toggle', () => {
            nightPilot?.toggle();
        }),

        vscode.commands.registerCommand('autoAccept.nightMode.report', () => {
            nightPilot?.showReport();
        }),

        vscode.commands.registerCommand('autoAccept.pipeline.toggle', () => {
            pipelineScheduler?.toggle();
        }),

        vscode.commands.registerCommand('autoAccept.pipeline.addTask', async (title?: string, workspace?: string) => {
            // 如果从 Dashboard 传入了 title，直接使用
            if (title) {
                await pipelineScheduler?.addTask(title, workspace);
                return;
            }
            // 否则弹出输入框
            const input = await vscode.window.showInputBox({
                prompt: '输入任务描述',
                placeHolder: '例如：重构登录模块',
            });
            if (input) {
                await pipelineScheduler?.addTask(input);
            }
        }),

        vscode.commands.registerCommand('autoAccept.pipeline.decompose', async (taskId?: string) => {
            if (!taskId) {
                const input = await vscode.window.showInputBox({
                    prompt: '输入要拆解的任务 ID',
                });
                if (!input) return;
                taskId = input;
            }
            await pipelineScheduler?.decomposeTask(taskId);
        }),

        vscode.commands.registerCommand('autoAccept.pipeline.addAndDecompose', async (title?: string, workspace?: string) => {
            if (!title) {
                title = await vscode.window.showInputBox({
                    prompt: '输入需求描述（AI 将自动拆解为子任务）',
                    placeHolder: '例如：重构用户认证模块，支持 OAuth2 和 JWT',
                }) || undefined;
            }
            if (title) {
                await pipelineScheduler?.addAndDecompose(title, workspace);
            }
        }),

        config,
        statusBar,
        acceptor,
        logger,
        nightPilot,
        pipelineScheduler,
        { dispose: () => mcpManager?.stop() },
    );

    // ---- 自动启动 ----
    if (config.enabled) {
        await acceptor.start();

        // 安装 Agent View 集成
        await agentUI.install({
            acceptCount: statusBar.acceptCount,
            retryCount: statusBar.retryCount,
            running: true,
        });
    }

    // ---- 夜间模式自动激活检查 ----
    if (config.nightModeEnabled) {
        nightPilot.checkAutoActivate();
    }

    // ---- Pipeline 自动启动检查 ----
    if (config.pipelineEnabled) {
        pipelineScheduler.start().catch((e: any) => {
            logger.info(`[Pipeline] 自动启动失败: ${e.message}`);
        });
    }

    logger.info('🚀 Auto Accept 插件已就绪');
}

export function deactivate() {
    acceptor?.stop();
    mcpManager?.stop();
    pipelineScheduler?.stop();
}

/**
 * API 探索 + CDP 诊断命令
 */
async function exploreApi(acceptor: AutoAcceptor, sdk: any, logger: Logger) {
    logger.show();
    logger.info('');
    logger.info('========================================');
    logger.info('  Auto Accept 诊断');
    logger.info('========================================');

    // CDP 状态
    logger.info('');
    logger.info('--- CDP 状态 ---');
    const cdpMgr = acceptor.cdpManager;
    logger.info(`  已连接: ${cdpMgr.connected ? '是' : '否'}`);
    logger.info(`  Target 数: ${cdpMgr.targetCount}`);

    // 手动触发一次扫描
    logger.info('');
    logger.info('--- 手动触发 CDP 扫描 ---');
    const clicked = await cdpMgr.scan('manual-diagnostic');
    logger.info(`  点击了 ${clicked} 个按钮`);

    // SDK 状态
    logger.info('');
    logger.info('--- SDK API 测试 ---');

    try {
        const sessions = await sdk.cascade.getSessions();
        logger.info(`  ✅ getSessions(): ${sessions?.length ?? 0} 个会话`);
    } catch (err: any) {
        logger.info(`  ❌ getSessions(): ${err.message}`);
    }

    // Monitor 可用性
    logger.info('');
    logger.info('--- Monitor 事件 ---');
    logger.info(`  onStepCountChanged: ${typeof sdk.monitor.onStepCountChanged}`);
    logger.info(`  onStateChanged: ${typeof sdk.monitor.onStateChanged}`);
    logger.info(`  onNewConversation: ${typeof sdk.monitor.onNewConversation}`);
    logger.info(`  onActiveSessionChanged: ${typeof sdk.monitor.onActiveSessionChanged}`);

    // VS Code 命令
    logger.info('');
    logger.info('--- 相关 VS Code 命令 ---');
    try {
        const allCommands = await vscode.commands.getCommands(true);
        const relevant = allCommands.filter((c: string) =>
            c.toLowerCase().includes('antigravity') ||
            c.toLowerCase().includes('agent'),
        );
        logger.info(`  共 ${relevant.length} 个相关命令`);
        for (const cmd of relevant.sort()) {
            logger.info(`   - ${cmd}`);
        }
    } catch (err: any) {
        logger.info(`  ❌ 获取命令列表失败: ${err.message}`);
    }

    logger.info('');
    logger.info('========================================');
    logger.info('  诊断完毕');
    logger.info('========================================');

    vscode.window.showInformationMessage(
        '诊断完毕，请查看 Output 面板 → "Auto Accept" 频道',
    );
}

/**
 * SDK Stub（当 antigravity-sdk 不可用时）
 */
function createStubSdk() {
    const noop = async () => {};
    const noopSync = () => {};

    return {
        cascade: {
            getSessions: noop,
            getPreferences: noop,
            getDiagnostics: noop,
            getBrowserPort: noop,
            acceptStep: noop,
            rejectStep: noop,
            acceptTerminalCommand: noop,
            rejectTerminalCommand: noop,
            runTerminalCommand: noop,
            acceptCommand: noop,
            focusSession: noop,
            sendPrompt: noop,
            createBackgroundSession: noop,
        },
        monitor: {
            onStepCountChanged: noopSync,
            onActiveSessionChanged: noopSync,
            onNewConversation: noopSync,
            onStateChanged: noopSync,
            start: noopSync,
            stop: noopSync,
        },
        ls: null,
        dispose: noopSync,
    };
}
