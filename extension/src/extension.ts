import * as vscode from 'vscode';
import { Config } from './config';
import { Logger } from './logger';
import { StatusBarManager } from './statusbar';
import { AutoAcceptor } from './auto-acceptor';
import { AgentUI } from './agent-ui';

/**
 * Antigravity Auto-Accept Extension
 *
 * 通过 antigravity-sdk 原生 API 自动接受 Agent 操作，
 * 替代原 CDP 外部脚本方案。
 */

let acceptor: AutoAcceptor | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Logger();
    const config = new Config();

    // 同步日志级别
    logger.logLevel = config.logLevel;

    logger.info('Auto Accept 插件加载中...');

    // ---- 初始化 antigravity-sdk ----
    let sdk: any;
    try {
        const { AntigravitySDK } = require('antigravity-sdk');
        sdk = new AntigravitySDK(context);
        await sdk.initialize();
        logger.info('✅ antigravity-sdk 初始化成功');
    } catch (err: any) {
        logger.error(`antigravity-sdk 初始化失败: ${err.message}`);
        logger.info('💡 请确认已安装 antigravity-sdk: npm install antigravity-sdk');
        logger.info('💡 将以有限功能模式运行（仅 UI，不能自动接受）');

        // 创建一个 stub SDK 以便 UI 功能照常工作
        sdk = createStubSdk(logger);
    }

    // ---- 创建状态栏 ----
    const statusBar = new StatusBarManager(config);

    // ---- 创建 Agent View UI 集成 ----
    const agentUI = new AgentUI(sdk, logger);

    // ---- 创建自动接受器（内含 AutoRetry） ----
    acceptor = new AutoAcceptor(sdk, config, logger, statusBar, agentUI);

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

        vscode.commands.registerCommand('autoAccept.exploreApi', () => {
            exploreAntigravityApi(sdk, logger);
        }),

        config,
        statusBar,
        acceptor,
        logger,
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

    logger.info('🚀 Auto Accept 插件已就绪');
}

export function deactivate() {
    acceptor?.stop();
}

/**
 * API 探索命令 — 列出 Antigravity 提供的所有可用 API
 *
 * 通过 "Auto Accept: Explore Antigravity API (Debug)" 命令触发。
 */
async function exploreAntigravityApi(sdk: any, logger: Logger) {
    logger.show();
    logger.info('');
    logger.info('========================================');
    logger.info('  Antigravity API 探索');
    logger.info('========================================');

    // 1. 列出所有 VS Code 命令
    try {
        const allCommands = await vscode.commands.getCommands(true);
        const relevantCommands = allCommands.filter((c: string) =>
            c.toLowerCase().includes('antigravity') ||
            c.toLowerCase().includes('cascade') ||
            c.toLowerCase().includes('agent') ||
            c.toLowerCase().includes('windsurf') ||
            c.toLowerCase().includes('codeium') ||
            c.toLowerCase().includes('copilot'),
        );

        logger.info('');
        logger.info(`📋 IDE 全部命令数量: ${allCommands.length}`);
        logger.info(`📋 相关命令 (${relevantCommands.length} 个):`);
        for (const cmd of relevantCommands.sort()) {
            logger.info(`   - ${cmd}`);
        }
    } catch (err: any) {
        logger.error(`列出命令失败: ${err.message}`);
    }

    // 2. 测试 SDK 核心 API
    logger.info('');
    logger.info('--- SDK API 测试 ---');

    // 2a. 获取会话列表
    try {
        const sessions = await sdk.cascade.getSessions();
        logger.info(`✅ sdk.cascade.getSessions(): 返回 ${sessions?.length ?? 0} 个会话`);
        if (sessions?.length > 0) {
            for (const s of sessions.slice(0, 5)) {
                logger.info(`   📝 ${s.title || s.id} (steps: ${s.stepCount ?? '?'})`);
            }
            if (sessions.length > 5) {
                logger.info(`   ... 还有 ${sessions.length - 5} 个会话`);
            }
        }
    } catch (err: any) {
        logger.error(`❌ sdk.cascade.getSessions() 失败: ${err.message}`);
    }

    // 2b. 获取偏好设置
    try {
        const prefs = await sdk.cascade.getPreferences();
        logger.info(`✅ sdk.cascade.getPreferences():`);
        if (prefs) {
            const keys = Object.keys(prefs);
            for (const key of keys) {
                logger.info(`   ${key}: ${JSON.stringify(prefs[key])}`);
            }
        }
    } catch (err: any) {
        logger.error(`❌ sdk.cascade.getPreferences() 失败: ${err.message}`);
    }

    // 2c. 测试诊断信息
    try {
        const diag = await sdk.cascade.getDiagnostics();
        logger.info(`✅ sdk.cascade.getDiagnostics():`);
        if (diag?.systemInfo) {
            logger.info(`   OS: ${diag.systemInfo.operatingSystem}`);
            logger.info(`   User: ${diag.systemInfo.userName}`);
        }
    } catch (err: any) {
        logger.error(`❌ sdk.cascade.getDiagnostics() 失败: ${err.message}`);
    }

    // 2d. 测试 LSBridge
    try {
        const port = await sdk.cascade.getBrowserPort();
        logger.info(`✅ sdk.cascade.getBrowserPort(): ${port}`);
    } catch (err: any) {
        logger.error(`❌ sdk.cascade.getBrowserPort() 失败: ${err.message}`);
    }

    // 2e. 列出 LSBridge 可用方法
    if (sdk.ls) {
        try {
            const cascades = await sdk.ls.listCascades();
            logger.info(`✅ sdk.ls.listCascades(): 返回 ${cascades?.length ?? 0} 个`);
        } catch (err: any) {
            logger.error(`❌ sdk.ls.listCascades() 失败: ${err.message}`);
        }

        try {
            const status = await sdk.ls.getUserStatus();
            logger.info(`✅ sdk.ls.getUserStatus(): ${JSON.stringify(status)}`);
        } catch (err: any) {
            logger.error(`❌ sdk.ls.getUserStatus() 失败: ${err.message}`);
        }
    } else {
        logger.info('⚠️ sdk.ls (LSBridge) 不可用');
    }

    // 2f. 测试 monitor 是否可用
    try {
        logger.info('');
        logger.info('--- Monitor 事件注册测试 ---');
        logger.info('✅ sdk.monitor.onStepCountChanged: ' + (typeof sdk.monitor.onStepCountChanged));
        logger.info('✅ sdk.monitor.onActiveSessionChanged: ' + (typeof sdk.monitor.onActiveSessionChanged));
        logger.info('✅ sdk.monitor.onNewConversation: ' + (typeof sdk.monitor.onNewConversation));
        logger.info('✅ sdk.monitor.onStateChanged: ' + (typeof sdk.monitor.onStateChanged));
        logger.info('✅ sdk.monitor.start: ' + (typeof sdk.monitor.start));
    } catch (err: any) {
        logger.error(`Monitor 检查失败: ${err.message}`);
    }

    // 2g. 测试 step control
    logger.info('');
    logger.info('--- Step Control API 可用性 ---');
    const stepMethods = [
        'acceptStep', 'rejectStep',
        'acceptTerminalCommand', 'rejectTerminalCommand',
        'runTerminalCommand', 'acceptCommand',
    ];
    for (const method of stepMethods) {
        const available = typeof sdk.cascade[method] === 'function';
        logger.info(`${available ? '✅' : '❌'} sdk.cascade.${method}: ${available ? 'function' : 'not found'}`);
    }

    logger.info('');
    logger.info('========================================');
    logger.info('  探索完毕');
    logger.info('========================================');

    vscode.window.showInformationMessage(
        'API 探索完毕，请查看 Output 面板 → "Auto Accept" 频道',
    );
}

/**
 * 当 antigravity-sdk 不可用时的 Stub SDK
 */
function createStubSdk(logger: Logger) {
    const noop = async () => {
        logger.debug('Stub SDK: 操作跳过（SDK 未初始化）');
    };

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
