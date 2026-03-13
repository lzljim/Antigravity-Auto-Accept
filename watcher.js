#!/usr/bin/env node

/**
 * watcher.js - 自动重启守护进程
 *
 * 监听 auto-accept.js 和 config.json 的文件变化，
 * 检测到修改后自动重启子进程。无需安装任何依赖。
 *
 * 用法：node watcher.js  （或 npm run dev）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 要监听的文件列表
const WATCH_FILES = [
    path.join(__dirname, 'auto-accept.js'),
    path.join(__dirname, 'config.json'),
];

// 防抖延迟（ms）：编辑器保存时可能触发多次事件，合并为一次重启
const DEBOUNCE_MS = 300;

let child = null;
let restartTimer = null;
let isShuttingDown = false;

function timestamp() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function log(msg) {
    console.log(`[${timestamp()}] [watcher] ${msg}`);
}

function startChild() {
    if (isShuttingDown) return;

    log('▶  启动 auto-accept.js ...');

    child = spawn(process.execPath, [path.join(__dirname, 'auto-accept.js')], {
        stdio: 'inherit',   // 子进程的输出直接打印到当前终端
        env: process.env,
    });

    child.on('exit', (code, signal) => {
        if (isShuttingDown) return;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') return; // 我们主动杀掉的，不需要提示
        log(`⚠️  进程退出 (code=${code})，3 秒后自动重启...`);
        setTimeout(startChild, 3000);
    });

    child.on('error', (err) => {
        log(`❌ 启动失败: ${err.message}`);
    });
}

function scheduleRestart(filename) {
    if (restartTimer) clearTimeout(restartTimer);

    restartTimer = setTimeout(() => {
        log(`🔄 检测到文件变化: ${filename}，正在重启...`);
        killAndRestart();
    }, DEBOUNCE_MS);
}

function killAndRestart() {
    if (!child) {
        startChild();
        return;
    }

    const oldChild = child;
    child = null;

    // 先尝试优雅终止，超时后强制 kill
    oldChild.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
        try { oldChild.kill('SIGKILL'); } catch (_) {}
    }, 3000);

    oldChild.once('exit', () => {
        clearTimeout(forceKillTimer);
        startChild();
    });
}

// 注册文件监听
for (const filePath of WATCH_FILES) {
    if (!fs.existsSync(filePath)) {
        log(`⚠️  文件不存在，跳过监听: ${filePath}`);
        continue;
    }

    // fs.watch 在 Windows 上更可靠
    fs.watch(filePath, { persistent: true }, (eventType) => {
        if (eventType === 'change') {
            scheduleRestart(path.basename(filePath));
        }
    });

    log(`👀 监听文件: ${path.basename(filePath)}`);
}

// 优雅退出：Ctrl+C 时同时关闭子进程
process.on('SIGINT', () => {
    isShuttingDown = true;
    log('🛑 收到退出信号，正在停止...');
    if (child) {
        child.kill('SIGTERM');
        child.once('exit', () => process.exit(0));
        setTimeout(() => process.exit(0), 2000); // 兜底超时
    } else {
        process.exit(0);
    }
});

process.on('SIGTERM', () => {
    isShuttingDown = true;
    if (child) child.kill('SIGTERM');
    process.exit(0);
});

// 启动
log('🚀 Auto-restart watcher 已启动');
log(`📂 监听文件: ${WATCH_FILES.map(f => path.basename(f)).join(', ')}`);
log('💡 修改以上文件后将自动重启，按 Ctrl+C 退出\n');
startChild();
