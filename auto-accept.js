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
//  生成注入到 target 中的 JS 检测脚本
// ============================================================

function buildDetectionScript(buttonTexts) {
    const textsJSON = JSON.stringify(buttonTexts.map(t => t.toLowerCase()));

    // 注意：这里是模板字符串，内部的 JS 代码会被注入到浏览器中执行
    // 正则中的 \ 需要额外转义一次（模板字符串 → 注入的代码）
    return `
        (() => {
            const targetTexts = ${textsJSON};
            const MARKER = 'data-auto-accepted';

            // 规范化按钮文本：去掉尾部快捷键提示
            // "RunAlt+⏎" → "run", "Allow This Conversation" → "allow this conversation"
            function normalize(rawText) {
                return rawText.trim()
                    .replace(/\\s*(Alt|Ctrl|Shift|Cmd|Meta)[+\\-].*$/i, '')
                    .trim()
                    .toLowerCase();
            }

            function isMatch(rawText) {
                return targetTexts.some(t => normalize(rawText) === t);
            }

            const clicked = [];

            const allButtons = document.querySelectorAll('button, [role="button"]');
            for (const btn of allButtons) {
                // 跳过禁用的按钮
                if (btn.disabled) continue;
                // 跳过不可见的按钮
                if (btn.offsetParent === null) continue;
                // 跳过已经被本脚本点击过的按钮（防重复）
                if (btn.hasAttribute(MARKER)) continue;

                const text = (btn.textContent || '').trim();
                if (!isMatch(text)) continue;

                // 标记为已点击，防止下轮轮询重复点击同一按钮
                btn.setAttribute(MARKER, Date.now().toString());
                btn.click();
                clicked.push(normalize(text));
            }

            return clicked.length > 0 ? clicked : null;
        })()
    `;
}

// ============================================================
//  核心：扫描单个 target
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
        // target 可能已经关闭或不可访问，静默跳过
        debug(`扫描 target 失败 (${targetInfo.id || 'unknown'}): ${err.message}`);
    } finally {
        if (client) {
            try { await client.close(); } catch (_) { /* ignore */ }
        }
    }
}

// ============================================================
//  核心：扫描所有 targets
// ============================================================

async function scanAllTargets(detectionScript) {
    let targets;
    try {
        targets = await CDP.List({ port: PORT });
    } catch (err) {
        // 连接失败 —— IDE 可能还没启动或端口未开放
        throw new Error(`无法获取 target 列表: ${err.message}`);
    }

    debug(`发现 ${targets.length} 个 target`);

    // 并行扫描所有 target（包括 OOPIF 子进程）
    const scanPromises = targets.map(t => scanTarget(t, detectionScript));
    await Promise.allSettled(scanPromises);

    // 返回 target 数量供主循环统计
    return targets.length;
}

// ============================================================
//  主循环
// ============================================================

async function mainLoop() {
    const detectionScript = buildDetectionScript(BUTTON_TEXTS);
    let consecutiveErrors = 0;
    let connected = false;       // 是否已成功连接过
    let pollCount = 0;           // 轮询次数计数
    const HEARTBEAT_POLLS = Math.round(30000 / POLL_INTERVAL); // 每30秒心跳一次

    log('==========================================');
    log('  Antigravity Auto-Accept 已启动');
    log('==========================================');
    log(`  调试端口 : ${PORT}`);
    log(`  轮询间隔 : ${POLL_INTERVAL}ms`);
    log(`  按钮白名单: ${BUTTON_TEXTS.join(', ')}`);
    log(`  自动重连 : ${AUTO_RECONNECT ? '是' : '否'}`);
    log(`  日志级别 : ${LOG_LEVEL}`);
    log('==========================================');
    log('');
    log('⏳ 等待连接 Antigravity IDE...');
    log('  请确保 IDE 已添加 --remote-debugging-port=9222 启动参数');
    log('');

    async function poll() {
        try {
            const targetCount = await scanAllTargets(detectionScript);

            // 首次连接成功时打印确认
            if (!connected) {
                connected = true;
                log(`🔗 已连接到 Antigravity IDE，检测到 ${targetCount} 个渲染进程`);
                log('👀 正在监听确认按钮，有操作时会自动点击...');
                log('');
            } else if (consecutiveErrors > 0) {
                log(`🔗 已重新连接到 Antigravity IDE（检测到 ${targetCount} 个进程）`);
            }

            consecutiveErrors = 0;
            pollCount++;

            // 每 30 秒打印一次心跳，证明脚本在正常运行
            if (pollCount % HEARTBEAT_POLLS === 0) {
                log(`💓 运行中... 已扫描 ${pollCount} 次，检测到 ${targetCount} 个渲染进程`);
            }
        } catch (err) {
            consecutiveErrors++;
            connected = false;
            if (consecutiveErrors === 1) {
                // 首次失败时输出提示
                debug(`连接失败: ${err.message}`);
                log('⚠️  未检测到 IDE 调试端口，将持续重试...');
            }

            if (!AUTO_RECONNECT) {
                error('自动重连已禁用，脚本退出。');
                process.exit(1);
            }

            // 连接失败时使用更长的间隔
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
