#!/usr/bin/env node

/**
 * Antigravity Auto-Accept Script
 *
 * 通过 Chrome DevTools Protocol (CDP) 自动检测并点击
 * Antigravity IDE 中 Agent 面板里的确认按钮。
 *
 * 原理：连接 IDE 内置 Chromium 的调试端口，遍历所有渲染进程
 * （包括 OOPIF 隔离沙盒），在 DOM 中查找匹配的按钮并触发 click()。
 *
 * 增强模式（持久连接 + MutationObserver）：
 * - 对每个 target 保持持久 CDP 连接
 * - 注入 MutationObserver 实时监听 DOM 变化
 * - 后台 webview 中的按钮也能被自动点击（多会话支持）
 *
 * 用法：node auto-accept.js
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

// ============================================================
//  配置加载
// ============================================================

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config;

try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
    console.error(`[ERROR] 无法读取配置文件 ${CONFIG_PATH}: ${err.message}`);
    console.error('[INFO]  将使用默认配置运行');
    config = {};
}

const PORT = config.port ?? 9222;
const POLL_INTERVAL = config.pollIntervalMs ?? 500;
const BUTTON_TEXTS = config.buttonTexts ?? ['Accept', 'Run', 'Always allow', 'Yes', 'Confirm', 'Allow'];
const AUTO_RECONNECT = config.autoReconnect ?? true;
const RECONNECT_INTERVAL = config.reconnectIntervalMs ?? 3000;
const LOG_LEVEL = config.logLevel ?? 'info'; // 'debug' | 'info' | 'silent'
const USE_PERSISTENT_MODE = config.usePersistentMode ?? true; // 持久连接模式

// ============================================================
//  日志工具
// ============================================================

function timestamp() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function log(msg) {
    if (LOG_LEVEL !== 'silent') {
        console.log(`[${timestamp()}] ${msg}`);
    }
}

function debug(msg) {
    if (LOG_LEVEL === 'debug') {
        console.log(`[${timestamp()}] [DEBUG] ${msg}`);
    }
}

function error(msg) {
    console.error(`[${timestamp()}] [ERROR] ${msg}`);
}

// ============================================================
//  生成按钮检测脚本（注入到 target 中执行）
// ============================================================

function buildDetectionScript(buttonTexts) {
    const textsJSON = JSON.stringify(buttonTexts.map(t => t.toLowerCase()));

    // buttonTexts 的顺序即优先级（靠前 = 优先级高）
    return `
        (() => {
            const targetTexts = ${textsJSON};
            const MARKER = 'data-auto-accepted';

            function normalize(rawText) {
                return rawText.trim()
                    .replace(/\\s*(Alt|Ctrl|Shift|Cmd|Meta)[+\\-].*$/i, '')
                    .trim()
                    .toLowerCase();
            }

            // 收集所有可点击的按钮及其归一化文本
            const allButtons = document.querySelectorAll('button, [role="button"]');
            const candidates = [];
            for (const btn of allButtons) {
                if (btn.disabled) continue;
                if (btn.hasAttribute(MARKER)) continue;
                const text = normalize((btn.textContent || '').trim());
                candidates.push({ btn, text });
            }

            // 按配置优先级遍历：找到最高优先级的匹配按钮就只点它
            for (const target of targetTexts) {
                const match = candidates.find(c => c.text === target);
                if (match) {
                    // 标记所有匹配的按钮（包括低优先级的），防止后续触发再点击
                    const ts = Date.now().toString();
                    for (const c of candidates) {
                        if (targetTexts.includes(c.text)) {
                            c.btn.setAttribute(MARKER, ts);
                        }
                    }
                    match.btn.click();
                    return [match.text];
                }
            }

            return null;
        })()
    `;
}

// ============================================================
//  生成 MutationObserver 注入脚本（常驻 target 中）
// ============================================================

function buildObserverScript(buttonTexts) {
    const textsJSON = JSON.stringify(buttonTexts.map(t => t.toLowerCase()));

    return `
        (() => {
            // 防止重复注入
            if (window.__autoAcceptObserver) {
                return { status: 'already_injected' };
            }

            const targetTexts = ${textsJSON};
            const MARKER = 'data-auto-accepted';

            function normalize(rawText) {
                return rawText.trim()
                    .replace(/\\s*(Alt|Ctrl|Shift|Cmd|Meta)[+\\-].*$/i, '')
                    .trim()
                    .toLowerCase();
            }


            function scanAndClick(root) {
                // 收集所有可点击的按钮
                const buttons = (root || document).querySelectorAll('button, [role="button"]');
                const candidates = [];
                for (const btn of buttons) {
                    if (btn.disabled) continue;
                    if (btn.hasAttribute(MARKER)) continue;
                    const text = normalize((btn.textContent || '').trim());
                    candidates.push({ btn, text });
                }

                // 按配置优先级遍历：找到最高优先级的匹配按钮就只点它
                for (const target of targetTexts) {
                    const match = candidates.find(c => c.text === target);
                    if (match) {
                        // 标记所有匹配的按钮（包括低优先级的），防止 Observer 再次触发时点击
                        const ts = Date.now().toString();
                        for (const c of candidates) {
                            if (targetTexts.includes(c.text)) {
                                c.btn.setAttribute(MARKER, ts);
                            }
                        }
                        match.btn.click();
                        return [match.text];
                    }
                }
                return [];
            }

            // 先扫描一遍现有 DOM（处理已经存在但未被点击的按钮）
            const initialClicked = scanAndClick(document);

            // 创建 MutationObserver 监听 DOM 变化
            const observer = new MutationObserver((mutations) => {
                let needScan = false;

                for (const mutation of mutations) {
                    // 有新节点被添加时需要扫描
                    if (mutation.addedNodes.length > 0) {
                        needScan = true;
                        break;
                    }
                    // 属性变化也可能意味着按钮从 disabled 变为 enabled
                    if (mutation.type === 'attributes') {
                        const target = mutation.target;
                        if (target.tagName === 'BUTTON' || target.getAttribute?.('role') === 'button') {
                            needScan = true;
                            break;
                        }
                    }
                }

                if (needScan) {
                    const clicked = scanAndClick(document);
                    if (clicked.length > 0) {
                        // 通过 console.log 输出，以便 CDP 的 Runtime.consoleAPICalled 事件捕获
                        console.log('[AUTO-ACCEPT-CLICKED]' + JSON.stringify(clicked));
                    }
                }
            });

            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['disabled', 'class', 'style']
            });

            // ---- 自动滚底：触发虚拟滚动渲染未显示的按钮 ----
            function scrollToBottom() {
                // 尝试多种选择器匹配 VS Code 系 Agent 面板的可滚动容器
                const selectors = [
                    '.monaco-scrollable-element',
                    '[class*="chat"] [class*="scroll"]',
                    '[class*="agent"] [class*="scroll"]',
                    '[class*="conversation"] [class*="scroll"]',
                    '[role="list"]',
                    '[role="log"]'
                ];
                const scrolled = new Set();
                for (const sel of selectors) {
                    for (const el of document.querySelectorAll(sel)) {
                        if (scrolled.has(el)) continue;
                        // 只处理确实有滚动空间的容器
                        if (el.scrollHeight > el.clientHeight + 10) {
                            el.scrollTop = el.scrollHeight;
                            scrolled.add(el);
                        }
                    }
                }
            }

            // 每秒滚一次底部，触发懒加载渲染
            window.__autoAcceptScrollTimer = setInterval(scrollToBottom, 1000);
            // 初始也滚一次
            scrollToBottom();

            window.__autoAcceptObserver = observer;

            return {
                status: 'injected',
                initialClicked: initialClicked.length > 0 ? initialClicked : null
            };
        })()
    `;
}

// ============================================================
//  持久连接管理器（TargetManager）
// ============================================================

class TargetManager {
    constructor() {
        /** @type {Map<string, { client: any, info: any, ready: boolean }>} */
        this.connections = new Map();
        this.detectionScript = buildDetectionScript(BUTTON_TEXTS);
        this.observerScript = buildObserverScript(BUTTON_TEXTS);
    }

    /**
     * 同步 target 列表：新增连接、清理过期连接
     */
    async syncTargets() {
        let targets;
        try {
            targets = await CDP.List({ port: PORT });
        } catch (err) {
            throw new Error(`无法获取 target 列表: ${err.message}`);
        }

        debug(`发现 ${targets.length} 个 target`);

        const currentIds = new Set(targets.map(t => t.id));

        // 清理已消失的 target
        for (const [id, conn] of this.connections) {
            if (!currentIds.has(id)) {
                debug(`Target 已消失，清理连接: ${id}`);
                await this.detachTarget(id);
            }
        }

        // 对新 target 建立连接
        const newTargets = targets.filter(t => !this.connections.has(t.id));
        if (newTargets.length > 0) {
            debug(`发现 ${newTargets.length} 个新 target，正在建立连接...`);
            const attachPromises = newTargets.map(t => this.attachTarget(t));
            await Promise.allSettled(attachPromises);
        }

        return {
            total: targets.length,
            active: this.connections.size,
            newlyAdded: newTargets.length
        };
    }

    /**
     * 对单个 target 建立持久连接，注入 MutationObserver
     */
    async attachTarget(targetInfo) {
        let client;
        try {
            client = await CDP({
                target: targetInfo,
                port: PORT,
                local: true
            });

            const { Runtime } = client;
            await Runtime.enable();

            // 监听 console.log 消息，捕获 Observer 回调
            Runtime.consoleAPICalled(({ type, args }) => {
                if (type === 'log' && args.length > 0) {
                    const msg = args[0]?.value;
                    if (typeof msg === 'string' && msg.startsWith('[AUTO-ACCEPT-CLICKED]')) {
                        try {
                            const clicked = JSON.parse(msg.replace('[AUTO-ACCEPT-CLICKED]', ''));
                            for (const text of clicked) {
                                log(`✅ 自动点击了: [${text}]  (target: ${targetInfo.title || targetInfo.url || 'unknown'})`);
                            }
                        } catch (_) { /* ignore parse error */ }
                    }
                }
            });

            // 注入 MutationObserver 脚本
            const result = await Runtime.evaluate({
                expression: this.observerScript,
                returnByValue: true,
                awaitPromise: false
            });

            const response = result?.result?.value;
            if (response?.status === 'injected') {
                debug(`Observer 已注入: ${targetInfo.title || targetInfo.id}`);
                if (response.initialClicked) {
                    for (const text of response.initialClicked) {
                        log(`✅ 自动点击了: [${text}]  (target: ${targetInfo.title || targetInfo.url || 'unknown'})`);
                    }
                }
            } else if (response?.status === 'already_injected') {
                debug(`Observer 已存在，跳过: ${targetInfo.title || targetInfo.id}`);
            }

            // 监听连接断开事件
            client.on('disconnect', () => {
                debug(`Target 连接断开: ${targetInfo.id}`);
                this.connections.delete(targetInfo.id);
            });

            this.connections.set(targetInfo.id, {
                client,
                info: targetInfo,
                ready: true
            });

        } catch (err) {
            debug(`连接 target 失败 (${targetInfo.id || 'unknown'}): ${err.message}`);
            if (client) {
                try { await client.close(); } catch (_) { /* ignore */ }
            }
        }
    }

    /**
     * 断开单个 target 的连接
     */
    async detachTarget(targetId) {
        const conn = this.connections.get(targetId);
        if (conn) {
            try { await conn.client.close(); } catch (_) { /* ignore */ }
            this.connections.delete(targetId);
        }
    }

    /**
     * 对所有活跃连接执行一次 fallback 扫描（兜底轮询）
     */
    async fallbackScan() {
        let totalClicked = 0;
        for (const [id, conn] of this.connections) {
            if (!conn.ready) continue;
            try {
                const result = await conn.client.Runtime.evaluate({
                    expression: this.detectionScript,
                    returnByValue: true,
                    awaitPromise: false
                });

                if (result?.result?.value) {
                    const clicked = result.result.value;
                    totalClicked += clicked.length;
                    for (const text of clicked) {
                        log(`✅ 自动点击了: [${text}]  (target: ${conn.info.title || conn.info.url || 'unknown'})`);
                    }
                }
            } catch (err) {
                debug(`Fallback 扫描失败 (${id}): ${err.message}`);
                // 连接可能已失效，标记为待清理
                this.connections.delete(id);
            }
        }
        return totalClicked;
    }

    /**
     * 关闭所有连接
     */
    async closeAll() {
        for (const [id, conn] of this.connections) {
            try { await conn.client.close(); } catch (_) { /* ignore */ }
        }
        this.connections.clear();
    }
}

// ============================================================
//  传统模式：扫描单个 target（短连接）
// ============================================================

async function scanTarget(targetInfo, detectionScript) {
    let client;
    try {
        client = await CDP({
            target: targetInfo,
            port: PORT,
            local: true
        });

        const { Runtime } = client;
        await Runtime.enable();

        const result = await Runtime.evaluate({
            expression: detectionScript,
            returnByValue: true,
            awaitPromise: false
        });

        if (result?.result?.value) {
            const clicked = result.result.value;
            for (const text of clicked) {
                log(`✅ 自动点击了: [${text}]  (target: ${targetInfo.title || targetInfo.url || 'unknown'})`);
            }
        }
    } catch (err) {
        debug(`扫描 target 失败 (${targetInfo.id || 'unknown'}): ${err.message}`);
    } finally {
        if (client) {
            try { await client.close(); } catch (_) { /* ignore */ }
        }
    }
}

// ============================================================
//  传统模式：扫描所有 targets（短连接）
// ============================================================

async function scanAllTargets(detectionScript) {
    let targets;
    try {
        targets = await CDP.List({ port: PORT });
    } catch (err) {
        throw new Error(`无法获取 target 列表: ${err.message}`);
    }

    debug(`发现 ${targets.length} 个 target`);

    const scanPromises = targets.map(t => scanTarget(t, detectionScript));
    await Promise.allSettled(scanPromises);

    return targets.length;
}

// ============================================================
//  主循环
// ============================================================

async function mainLoop() {
    const detectionScript = buildDetectionScript(BUTTON_TEXTS);
    let consecutiveErrors = 0;
    let connected = false;
    let pollCount = 0;
    const HEARTBEAT_POLLS = Math.round(30000 / POLL_INTERVAL);

    // 持久模式下的 fallback 轮询间隔（每 N 次 sync 做一次 fallback）
    const FALLBACK_INTERVAL = Math.max(1, Math.round(5000 / POLL_INTERVAL));

    const targetManager = USE_PERSISTENT_MODE ? new TargetManager() : null;

    log('==========================================');
    log('  Antigravity Auto-Accept 已启动');
    log('==========================================');
    log(`  调试端口 : ${PORT}`);
    log(`  轮询间隔 : ${POLL_INTERVAL}ms`);
    log(`  按钮白名单: ${BUTTON_TEXTS.join(', ')}`);
    log(`  运行模式 : ${USE_PERSISTENT_MODE ? '持久连接 + MutationObserver' : '传统轮询'}`);
    log(`  自动重连 : ${AUTO_RECONNECT ? '是' : '否'}`);
    log(`  日志级别 : ${LOG_LEVEL}`);
    log('==========================================');
    log('');
    log('⏳ 等待连接 Antigravity IDE...');
    log('  请确保 IDE 已添加 --remote-debugging-port=9222 启动参数');
    log('');

    async function poll() {
        try {
            let targetCount;

            if (USE_PERSISTENT_MODE) {
                // 持久模式：同步 target 列表 + 定期 fallback 扫描
                const stats = await targetManager.syncTargets();
                targetCount = stats.total;

                // 每隔一段时间做一次 fallback 扫描（兜底）
                if (pollCount > 0 && pollCount % FALLBACK_INTERVAL === 0) {
                    await targetManager.fallbackScan();
                }
            } else {
                // 传统模式：每次轮询注入检测脚本
                targetCount = await scanAllTargets(detectionScript);
            }

            // 首次连接成功时打印确认
            if (!connected) {
                connected = true;
                log(`🔗 已连接到 Antigravity IDE，检测到 ${targetCount} 个渲染进程`);
                if (USE_PERSISTENT_MODE) {
                    log('🔄 已启用持久连接模式，MutationObserver 实时监听中...');
                }
                log('👀 正在监听确认按钮，有操作时会自动点击...');
                log('');
            } else if (consecutiveErrors > 0) {
                log(`🔗 已重新连接到 Antigravity IDE（检测到 ${targetCount} 个进程）`);
                if (USE_PERSISTENT_MODE) {
                    log('🔄 持久连接已恢复');
                }
            }

            consecutiveErrors = 0;
            pollCount++;

            // 心跳日志
            if (pollCount % HEARTBEAT_POLLS === 0) {
                const connInfo = USE_PERSISTENT_MODE
                    ? `，持久连接 ${targetManager.connections.size} 个`
                    : '';
                log(`💓 运行中... 检测到 ${targetCount} 个渲染进程${connInfo}`);
            }
        } catch (err) {
            consecutiveErrors++;
            connected = false;

            if (USE_PERSISTENT_MODE) {
                // 连接失败时清理所有持久连接
                await targetManager.closeAll();
            }

            if (consecutiveErrors === 1) {
                debug(`连接失败: ${err.message}`);
                log('⚠️  未检测到 IDE 调试端口，将持续重试...');
            }

            if (!AUTO_RECONNECT) {
                error('自动重连已禁用，脚本退出。');
                process.exit(1);
            }

            await sleep(RECONNECT_INTERVAL);
            return;
        }

        await sleep(POLL_INTERVAL);
    }

    // 持续轮询
    while (true) {
        await poll();
    }
}

// ============================================================
//  工具函数
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
//  优雅退出
// ============================================================

function setupGracefulShutdown() {
    const shutdown = (signal) => {
        log('');
        log(`📴 收到 ${signal} 信号，正在退出...`);
        log('👋 Antigravity Auto-Accept 已停止');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Windows 特殊处理：Ctrl+C
    if (process.platform === 'win32') {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('SIGINT', () => shutdown('SIGINT'));
    }
}

// ============================================================
//  入口
// ============================================================

setupGracefulShutdown();
mainLoop().catch(err => {
    error(`致命错误: ${err.message}`);
    process.exit(1);
});
