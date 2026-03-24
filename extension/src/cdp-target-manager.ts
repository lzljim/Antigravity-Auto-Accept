import { Logger } from './logger';
import { Config } from './config';
import { StatusBarManager } from './statusbar';
import { buildDetectionScript, buildObserverScript } from './cdp-scripts';
import { CDPRenamer } from './cdp-renamer';
import { EventBus } from './event-bus';

// CDP 库和结果类型（运行时动态加载）
type CDPClient = any;
type CDPTarget = { id: string; type?: string; title?: string; url?: string };
type EvalResult = { result?: { value?: any } };

/**
 * CDP 目标管理器 — 持久连接 + MutationObserver 混合模式
 *
 * 工作模式：
 *   1. 持久连接：对每个 target 建立长连接，注入 MutationObserver 实时监听
 *   2. 短连接兆底：SDK 信号或保底定时器触发一次性扫描
 *   3. Observer 回调：通过 console.log('[AUTO-ACCEPT-CLICKED]...') 回报点击结果
 */
export class CDPTargetManager {
    private logger: Logger;
    private config: Config;
    private statusBar: StatusBarManager;
    private CDP: any = null;  // chrome-remote-interface
    private running = false;
    private fallbackTimer: NodeJS.Timeout | null = null;
    private lastScanTime = 0;
    private scanning = false;  // 防止并发扫描
    private _targetCount = 0;
    private _connected = false;
    private consecutiveErrors = 0;
    private renamer: CDPRenamer | null = null;
    private eventBus: EventBus | null = null;

    /** 持久连接池 (targetId → { client, info, ready, renamerInjected }) */
    private connections = new Map<string, { client: any; info: any; ready: boolean; renamerInjected: boolean }>();

    /** 两次扫描之间的最小间隔（防抖），避免 SDK 信号密集时频繁扫描 */
    private static readonly MIN_SCAN_INTERVAL_MS = 800;

    constructor(config: Config, logger: Logger, statusBar: StatusBarManager, renamer?: CDPRenamer, eventBus?: EventBus) {
        this.config = config;
        this.logger = logger;
        this.statusBar = statusBar;
        this.renamer = renamer || null;
        this.eventBus = eventBus || null;
    }

    get targetCount(): number {
        return this._targetCount;
    }

    get connected(): boolean {
        return this._connected;
    }

    /**
     * 初始化 CDP 客户端库
     */
    async initialize(): Promise<boolean> {
        try {
            this.CDP = require('chrome-remote-interface');
            this.logger.info('✅ chrome-remote-interface 加载成功');
            return true;
        } catch (err: any) {
            this.logger.error(`chrome-remote-interface 加载失败: ${err.message}`);
            this.logger.info('💡 请运行: cd extension && npm install');
            return false;
        }
    }

    /**
     * 启动保底定时扫描
     */
    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;

        // 保底扫描：每 15s 执行一次（远低于旧方案的 500ms 轮询）
        const fallbackInterval = 15000;
        this.fallbackTimer = setInterval(async () => {
            if (!this.running) {
                return;
            }
            this.logger.debug('⏰ 保底定时扫描');
            await this.scan('fallback');
        }, fallbackInterval);

        // 立即执行一次初始扫描
        this.scan('init').catch(() => {});

        this.logger.info(`🔄 CDP 保底扫描已启动 (间隔: ${fallbackInterval / 1000}s)`);
    }

    /**
     * 停止定时扫描
     */
    stop(): void {
        this.running = false;
        if (this.fallbackTimer) {
            clearInterval(this.fallbackTimer);
            this.fallbackTimer = null;
        }
        // 清理持久连接
        for (const [id, conn] of this.connections) {
            try { conn.client.close(); } catch (_) { /* ignore */ }
        }
        this.connections.clear();
        this._connected = false;
        this._targetCount = 0;
        this.logger.info('⏹ CDP 扫描已停止');
    }

    /**
     * 执行一次完整扫描（短连接模式）
     *
     * 由 SDK 信号触发，或保底定时器触发。
     *
     * @param trigger - 触发来源标识（用于日志）
     * @returns 点击的按钮数量
     */
    async scan(trigger: string = 'signal'): Promise<number> {
        if (!this.CDP) {
            return 0;
        }

        // 防抖：避免 SDK 信号密集时频繁扫描
        const now = Date.now();
        if (now - this.lastScanTime < CDPTargetManager.MIN_SCAN_INTERVAL_MS) {
            this.logger.debug(`  防抖跳过 (距上次 ${now - this.lastScanTime}ms)`);
            return 0;
        }

        // 防止并发扫描
        if (this.scanning) {
            this.logger.debug('  已有扫描正在执行，跳过');
            return 0;
        }

        this.scanning = true;
        this.lastScanTime = now;

        try {
            // 获取所有 target
            const targets: CDPTarget[] = await withTimeout(
                this.CDP.List({ port: this.config.cdpPort }),
                5000,
                'CDP.List',
            );

            this._targetCount = targets.length;

            if (!this._connected) {
                this._connected = true;
                this.consecutiveErrors = 0;
                this.logger.info(`🔗 CDP 已连接 (${targets.length} 个渲染进程, 触发: ${trigger})`);
                // 发送状态事件
                this.eventBus?.emitStatus({
                    connected: true,
                    targetCount: targets.length,
                    timestamp: Date.now(),
                });
            }

            // ===== 持久连接同步 =====
            await this.syncConnections(targets);

            // ===== 兆底短连接扫描（只扫描没有持久连接的 target）=====
            const detectionScript = buildDetectionScript(
                this.config.buttonTexts,
                this.config.retryButtonTexts,
            );

            let totalClicked = 0;
            const unconnectedTargets = targets.filter((t: any) => {
                // 跳过已有持久连接的
                if (this.connections.has(t.id)) return false;
                const url = t.url || '';
                if (url.startsWith('http://') || url.startsWith('https://')) return false;
                if (t.type === 'worker' || t.type === 'service_worker') return false;
                return true;
            });

            if (unconnectedTargets.length > 0) {
                const scanPromises = unconnectedTargets.map(async (t: any) => {
                    const clicked = await this.scanTarget(t, detectionScript);
                    totalClicked += clicked;
                });
                await Promise.allSettled(scanPromises);
            }

            // 持久连接的 target 也做一次 fallback 扫描
            for (const [id, conn] of this.connections) {
                if (!conn.ready) continue;
                try {
                    const result: EvalResult = await withTimeout(
                        conn.client.Runtime.evaluate({
                            expression: detectionScript,
                            returnByValue: true,
                            awaitPromise: false,
                        }),
                        3000,
                        `fallbackEval(${conn.info.title || id.substring(0, 8)})`,
                    );
                    if (result?.result?.value) {
                        const clicked: string[] = result.result.value;
                        for (const text of clicked) {
                            this.logger.info(
                                `✅ 自动点击了: [${text}]  (target: ${conn.info.title || conn.info.url || 'unknown'})`,
                            );
                            this.statusBar.incrementCount();
                            this.eventBus?.emitClick({
                                button: text,
                                target: conn.info.title || conn.info.url || 'unknown',
                                timestamp: Date.now(),
                            });
                        }
                        totalClicked += clicked.length;
                    }
                } catch (err: any) {
                    this.logger.debug(`Fallback 扫描失败 (${id}): ${err.message}`);
                    this.connections.delete(id);
                }
            }

            if (totalClicked > 0) {
                this.logger.info(`📊 本次扫描点击了 ${totalClicked} 个按钮 (触发: ${trigger})`);
            } else {
                this.logger.debug(`  扫描完成, 无按钮需点击 (触发: ${trigger})`);
            }

            this.consecutiveErrors = 0;
            return totalClicked;
        } catch (err: any) {
            this.consecutiveErrors++;

            if (this.consecutiveErrors === 1) {
                this.logger.debug(`CDP 连接失败: ${err.message}`);
                this.logger.info('⚠️ 未检测到 IDE 调试端口，将持续重试...');
            }

            this._connected = false;
            this._targetCount = 0;
            this.eventBus?.emitStatus({
                connected: false,
                targetCount: 0,
                timestamp: Date.now(),
            });
            return 0;
        } finally {
            this.scanning = false;
        }
    }

    /**
     * 同步持久连接：新增/清理连接、注入 Observer
     */
    private async syncConnections(targets: CDPTarget[]): Promise<void> {
        const currentIds = new Set(targets.map(t => t.id));

        // 清理已消失的 target
        for (const [id, conn] of this.connections) {
            if (!currentIds.has(id)) {
                this.logger.debug(`Target 已消失，清理连接: ${id}`);
                try { conn.client.close(); } catch (_) { /* ignore */ }
                this.connections.delete(id);
            }
        }

        // 对新 target 建立持久连接
        const newTargets = targets.filter(t => {
            if (this.connections.has(t.id)) return false;
            const url = t.url || '';
            if (url.startsWith('http://') || url.startsWith('https://')) return false;
            if (t.type === 'worker' || t.type === 'service_worker') return false;
            return true;
        });

        if (newTargets.length > 0) {
            this.logger.debug(`发现 ${newTargets.length} 个新 target，建立持久连接...`);
            const attachPromises = newTargets.map(t =>
                withTimeout(this.attachTarget(t), 10000, `attach(${t.title || t.id?.substring(0, 8)})`)
                    .catch(err => this.logger.debug(`attachTarget 失败: ${t.title || t.id} - ${err.message}`))
            );
            await Promise.allSettled(attachPromises);
        }

        // 补检：已连接但未注入 renamer 的 Manager target
        for (const t of targets) {
            if (t.title === 'Manager' && this.renamer) {
                const conn = this.connections.get(t.id);
                if (conn && conn.ready && !conn.renamerInjected) {
                    this.logger.debug('补检: Manager target 需要注入 renamer');
                    try {
                        await this.renamer.injectToManager(conn.client);
                        conn.renamerInjected = true;
                    } catch (e: any) {
                        this.logger.debug(`重命名注入失败: ${e.message}`);
                    }
                }
            }
        }
    }

    /**
     * 对单个 target 建立持久连接，注入 MutationObserver
     */
    private async attachTarget(targetInfo: CDPTarget): Promise<void> {
        let client: any;
        try {
            client = await withTimeout(
                this.CDP({
                    target: targetInfo,
                    port: this.config.cdpPort,
                    local: true,
                }),
                3000,
                `attachTarget(${targetInfo.id?.substring(0, 8) || 'unknown'})`,
            );

            const { Runtime } = client;
            await Runtime.enable();

            // 监听 console.log 消息，捕获 Observer 回调
            Runtime.consoleAPICalled(({ type, args }: any) => {
                if (type === 'log' && args.length > 0) {
                    const msg = args[0]?.value;
                    if (typeof msg === 'string' && msg.startsWith('[AUTO-ACCEPT-CLICKED]')) {
                        try {
                            const clicked = JSON.parse(msg.replace('[AUTO-ACCEPT-CLICKED]', ''));
                            for (const text of clicked) {
                                this.logger.info(
                                    `✅ 自动点击了: [${text}]  (target: ${targetInfo.title || targetInfo.url || 'unknown'})`,
                                );
                                this.statusBar.incrementCount();
                                this.eventBus?.emitClick({
                                    button: text,
                                    target: targetInfo.title || targetInfo.url || 'unknown',
                                    timestamp: Date.now(),
                                });
                            }
                        } catch (_) { /* ignore parse error */ }
                    }
                }
            });

            // Manager target: 注入 renamer
            let renamerInjected = false;
            const isManager = targetInfo.title === 'Manager';
            if (isManager && this.renamer) {
                try {
                    await this.renamer.injectToManager(client);
                    renamerInjected = true;
                } catch (e: any) {
                    this.logger.debug(`重命名注入失败: ${e.message}`);
                }
            }

            // 注入 MutationObserver
            const observerScript = buildObserverScript(
                this.config.buttonTexts,
                this.config.retryButtonTexts,
            );

            const injectObserver = async () => {
                try {
                    const result = await Runtime.evaluate({
                        expression: observerScript,
                        returnByValue: true,
                        awaitPromise: false,
                    });
                    const response = result?.result?.value;
                    if (response?.status === 'injected') {
                        this.logger.debug(`Observer 已注入: ${targetInfo.title || targetInfo.id}`);
                        if (response.initialClicked) {
                            for (const text of response.initialClicked) {
                                this.logger.info(
                                    `✅ 自动点击了: [${text}]  (target: ${targetInfo.title || targetInfo.url || 'unknown'})`,
                                );
                                this.statusBar.incrementCount();
                                this.eventBus?.emitClick({
                                    button: text,
                                    target: targetInfo.title || targetInfo.url || 'unknown',
                                    timestamp: Date.now(),
                                });
                            }
                        }
                    }
                } catch (err: any) {
                    this.logger.debug(`Observer 注入失败: ${err.message}`);
                }
            };

            await injectObserver();

            // 监听页面导航/刷新：重新注入 Observer
            try {
                const { Page } = client;
                await Page.enable();
                Page.frameNavigated(() => {
                    this.logger.debug(`页面导航，重新注入 Observer: ${targetInfo.title || targetInfo.id}`);
                    setTimeout(() => injectObserver(), 500);
                });
            } catch (_) { /* 部分 target 可能不支持 Page domain */ }

            // 监听执行上下文销毁：webview 内容刷新时重新注入
            Runtime.executionContextDestroyed(() => {
                this.logger.debug(`执行上下文销毁，重新注入 Observer: ${targetInfo.title || targetInfo.id}`);
                setTimeout(() => injectObserver(), 500);
            });

            // 监听连接断开事件
            client.on('disconnect', () => {
                this.logger.debug(`Target 连接断开: ${targetInfo.id}`);
                this.connections.delete(targetInfo.id);
            });

            this.connections.set(targetInfo.id, {
                client,
                info: targetInfo,
                ready: true,
                renamerInjected,
            });

        } catch (err: any) {
            this.logger.debug(`连接 target 失败 (${targetInfo.id || 'unknown'}): ${err.message}`);
            if (client) {
                try { client.close(); } catch (_) { /* ignore */ }
            }
        }
    }

    /**
     * 扫描单个 target（短连接：连接 → 执行 → 断开）
     */
    private async scanTarget(targetInfo: any, detectionScript: string): Promise<number> {
        let client: any;
        try {
            client = await withTimeout(
                this.CDP({
                    target: targetInfo,
                    port: this.config.cdpPort,
                    local: true,
                }),
                3000,
                `connect(${targetInfo.title || targetInfo.id?.substring(0, 8)})`,
            );

            const { Runtime } = client;
            await Runtime.enable();

            // Manager Target: 注入重命名脚本
            if (targetInfo.title === 'Manager' && this.renamer) {
                try {
                    await this.renamer.injectToManager(client);
                } catch (e: any) {
                    this.logger.debug(`重命名注入失败: ${e.message}`);
                }
            }

            const result: EvalResult = await withTimeout(
                Runtime.evaluate({
                    expression: detectionScript,
                    returnByValue: true,
                    awaitPromise: false,
                }),
                3000,
                `eval(${targetInfo.title || targetInfo.id?.substring(0, 8)})`,
            );

            if (result?.result?.value) {
                const clicked: string[] = result.result.value;
                for (const text of clicked) {
                    this.logger.info(
                        `✅ 自动点击了: [${text}]  (target: ${targetInfo.title || targetInfo.url || 'unknown'})`,
                    );
                    this.statusBar.incrementCount();
                    this.eventBus?.emitClick({
                        button: text,
                        target: targetInfo.title || targetInfo.url || 'unknown',
                        timestamp: Date.now(),
                    });
                }
                return clicked.length;
            }

            return 0;
        } catch (err: any) {
            this.logger.debug(
                `扫描 target 失败 (${targetInfo.id || 'unknown'}): ${err.message}`,
            );
            return 0;
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

    /**
     * 获取一个临时 CDP 连接到指定 target（供 SmartRetry 使用）
     *
     * 调用者负责在使用后调用 client.close()
     */
    async connectTarget(targetInfo: any): Promise<any> {
        if (!this.CDP) {
            throw new Error('CDP 未初始化');
        }
        return withTimeout(
            this.CDP({
                target: targetInfo,
                port: this.config.cdpPort,
                local: true,
            }),
            3000,
            `connect(${targetInfo.title || targetInfo.id?.substring(0, 8)})`,
        );
    }

    /**
     * 获取当前所有 target 列表
     */
    async listTargets(): Promise<any[]> {
        if (!this.CDP) {
            return [];
        }
        try {
            return await withTimeout(
                this.CDP.List({ port: this.config.cdpPort }),
                5000,
                'CDP.List',
            );
        } catch {
            return [];
        }
    }
}

// ============================================================
//  工具函数
// ============================================================

/**
 * 给 Promise 加超时保护
 */
function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string = 'operation',
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} 超时 (${ms}ms)`));
        }, ms);
        promise.then(
            (val) => {
                clearTimeout(timer);
                resolve(val);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}
