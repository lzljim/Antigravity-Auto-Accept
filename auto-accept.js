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
const AUTO_RETRY = config.autoRetry ?? { enabled: false }; // 自动模型重试配置

// ============================================================
//  会话名称映射（持久化）
// ============================================================

const SESSION_NAMES_PATH = path.join(__dirname, 'session-names.json');

function loadSessionNames() {
    try {
        return JSON.parse(fs.readFileSync(SESSION_NAMES_PATH, 'utf-8'));
    } catch (_) {
        return {};
    }
}

function saveSessionName(uuid, name, original) {
    const names = loadSessionNames();
    if (name && name.trim()) {
        names[uuid] = { name: name.trim(), original: original || names[uuid]?.original || '' };
    } else {
        delete names[uuid];
    }
    fs.writeFileSync(SESSION_NAMES_PATH, JSON.stringify(names, null, 2), 'utf-8');
    log(`📝 会话名称已保存: ${uuid.substring(0, 8)}... → "${name}"`);
    return names;
}

// ============================================================
//  Workspace 名称映射（持久化）
// ============================================================

const WORKSPACE_NAMES_PATH = path.join(__dirname, 'workspace-names.json');

function loadWorkspaceNames() {
    try {
        return JSON.parse(fs.readFileSync(WORKSPACE_NAMES_PATH, 'utf-8'));
    } catch (_) {
        return {};
    }
}

function saveWorkspaceName(key, name, original) {
    const names = loadWorkspaceNames();
    if (name && name.trim()) {
        names[key] = { name: name.trim(), original: original || names[key]?.original || '' };
    } else {
        delete names[key];
    }
    fs.writeFileSync(WORKSPACE_NAMES_PATH, JSON.stringify(names, null, 2), 'utf-8');
    log(`📝 Workspace 名称已保存: "${key}" → "${name}"`);
    return names;
}

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

function buildObserverScript(buttonTexts, autoRetryConfig) {
    const textsJSON = JSON.stringify(buttonTexts.map(t => t.toLowerCase()));
    const autoRetryJSON = JSON.stringify(autoRetryConfig);

    return `
        (() => {
            // 重置重试计数器（脚本重新注入时归零）
            window.__retryCount = 0;

            // 如果已有旧 Observer，先断开再重新注入（确保代码变更后生效）
            if (window.__autoAcceptObserver) {
                window.__autoAcceptObserver.disconnect();
                window.__autoAcceptObserver = null;
            }

            const targetTexts = ${textsJSON};
            const autoRetry = ${autoRetryJSON};
            const MARKER = 'data-auto-accepted';

            function normalize(rawText) {
                return rawText.trim()
                    .replace(/\\s*(Alt|Ctrl|Shift|Cmd|Meta)[+\\-].*$/i, '')
                    .trim()
                    .toLowerCase();
            }

            // 直接重试（不切换模型）
            const MAX_RETRIES = autoRetry.maxRetries || 3;

            async function doAutoRetry(btn) {
                if (window.__isRetrying) return;

                // 检查重试上限
                window.__retryCount++;
                if (window.__retryCount > MAX_RETRIES) {
                    console.log('[AUTO-RETRY] \u2757 已达最大重试次数(' + MAX_RETRIES + ')，停止自动重试');
                    return;
                }

                window.__isRetrying = true;

                try {
                    console.log('[AUTO-RETRY] \u{1f504} 第 ' + window.__retryCount + '/' + MAX_RETRIES + ' 次重试...');
                    btn.setAttribute(MARKER, Date.now().toString());
                    btn.click();
                    console.log('[AUTO-RETRY] \u2705 已点击重试按钮');
                } catch (e) {
                    console.error('[AUTO-RETRY] 重试失败:', e);
                } finally {
                    window.__isRetrying = false;
                }
            }

            function scanAndClick(root) {
                // 收集所有可点击的按钮
                const buttons = (root || document).querySelectorAll('button, [role="button"]');
                const candidates = [];
                for (const btn of buttons) {
                    if (btn.disabled) continue;
                    if (btn.hasAttribute(MARKER)) continue;
                    const text = normalize((btn.textContent || '').trim());
                    
                    // 特殊处理 Retry 按钮
                    if (autoRetry?.enabled && autoRetry.retryButtonTexts?.length > 0) {
                        const isRetry = autoRetry.retryButtonTexts.some(rt => normalize(rt) === text);
                        if (isRetry) {
                            if (!window.__isRetrying && window.__retryCount < MAX_RETRIES) {
                                btn.setAttribute(MARKER, Date.now().toString());
                                doAutoRetry(btn);
                            }
                            // 超限后不跳过，让按钮留给用户手动操作
                            continue;
                        }
                    }
                    
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

            window.__autoAcceptObserver = observer;

            return {
                status: 'injected',
                initialClicked: initialClicked.length > 0 ? initialClicked : null
            };
        })()
    `;
}

// ============================================================
//  生成会话重命名脚本（注入到 Manager target）
// ============================================================

function buildRenamerScript(nameMap) {
    const nameMapJSON = JSON.stringify(nameMap);

    return `
        (() => {
            const nameMap = ${nameMapJSON};
            const RENAMER_MARKER = 'data-renamer-bound';

            // 应用名称映射：将 span 的 textContent 替换为自定义名称
            function applyNames() {
                const spans = document.querySelectorAll('[data-testid^="convo-pill-"]');
                for (const span of spans) {
                    const testId = span.getAttribute('data-testid');
                    const uuid = testId.replace('convo-pill-', '');
                    const entry = nameMap[uuid];
                    const customName = typeof entry === 'string' ? entry : entry?.name;
                    const displayName = customName ? '\u270f\ufe0f ' + customName : null;
                    if (displayName && span.textContent !== displayName) {
                        // 保存原始名称
                        if (!span.hasAttribute('data-original-name')) {
                            span.setAttribute('data-original-name', span.textContent);
                        }
                        span.textContent = '\u270f\ufe0f ' + customName;
                        // tooltip 显示原始名称
                        span.title = '原始: ' + span.getAttribute('data-original-name');
                    }
                }
            }

            // 为标题 span 绑定双击编辑事件
            function bindDblClick(span) {
                if (span.hasAttribute(RENAMER_MARKER)) return;
                span.setAttribute(RENAMER_MARKER, '1');

                span.addEventListener('dblclick', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();

                    const testId = span.getAttribute('data-testid');
                    const uuid = testId.replace('convo-pill-', '');
                    const currentText = span.textContent;
                    const originalName = span.getAttribute('data-original-name') || currentText;
                    // 去掉 emoji 前缀给用户编辑纯名称
                    const editValue = currentText.replace(/^\u270f\ufe0f\s*/, '');

                    // 创建 input 替换 span
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = editValue;
                    input.className = span.className;
                    input.style.cssText = 'background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-focusBorder,#007fd4);border-radius:3px;padding:1px 4px;outline:none;width:100%;font-size:inherit;';

                    const parent = span.parentElement;
                    parent.replaceChild(input, span);
                    input.focus();
                    input.select();

                    let committed = false;

                    function commit() {
                        if (committed) return;
                        committed = true;
                        const newName = input.value.trim();
                        if (newName && newName !== originalName) {
                            span.textContent = '\u270f\ufe0f ' + newName;
                            span.setAttribute('data-original-name', originalName);
                            span.title = '原始: ' + originalName;
                            nameMap[uuid] = { name: newName, original: originalName };
                            // 通过 binding 回调 Node.js 侧保存（带上原始名称）
                            try { window.__saveSessionName(JSON.stringify({ uuid, name: newName, original: originalName })); } catch(_) {}
                        } else if (!newName) {
                            // 空名称 = 恢复原始名称
                            span.textContent = originalName;
                            span.removeAttribute('data-original-name');
                            span.title = '';
                            delete nameMap[uuid];
                            try { window.__saveSessionName(JSON.stringify({ uuid, name: '' })); } catch(_) {}
                        } else {
                            span.textContent = currentText;
                        }
                        parent.replaceChild(span, input);
                    }

                    function cancel() {
                        if (committed) return;
                        committed = true;
                        span.textContent = currentText;
                        parent.replaceChild(span, input);
                    }

                    input.addEventListener('keydown', (ke) => {
                        if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
                        if (ke.key === 'Escape') { ke.preventDefault(); cancel(); }
                        ke.stopPropagation();
                    });
                    input.addEventListener('blur', () => commit());
                }, true);
            }

            // 绑定所有现有的会话标题
            function bindAll() {
                const spans = document.querySelectorAll('[data-testid^="convo-pill-"]');
                for (const span of spans) {
                    bindDblClick(span);
                }
            }

            let isUpdate = false;
            // 重新注入时：清除旧事件绑定，强制重新绑定（确保使用最新代码）
            if (window.__sessionRenamer) {
                isUpdate = true;
                window.__sessionRenamer.observer?.disconnect();
                // 清除旧的事件绑定标记，bindAll 会重新绑定
                document.querySelectorAll('[' + RENAMER_MARKER + ']').forEach(el => {
                    el.removeAttribute(RENAMER_MARKER);
                    // 克隆节点以移除旧事件监听器
                    const clone = el.cloneNode(true);
                    el.parentNode?.replaceChild(clone, el);
                });
            }

            // 初始扫描：从 DOM 捕获原始名称并回传 Node.js 保存
            function captureOriginals() {
                const spans = document.querySelectorAll('[data-testid^="convo-pill-"]');
                for (const span of spans) {
                    const testId = span.getAttribute('data-testid');
                    const uuid = testId.replace('convo-pill-', '');
                    const entry = nameMap[uuid];
                    const customName = typeof entry === 'string' ? entry : entry?.name;
                    const storedOriginal = typeof entry === 'string' ? null : entry?.original;
                    // 如果有自定义名称但没有存储原始名称，从 DOM 捕获
                    if (customName && (!storedOriginal) && span.textContent !== customName) {
                        const domOriginal = span.textContent;
                        try { window.__saveSessionName(JSON.stringify({ uuid, name: customName, original: domOriginal })); } catch(_) {}
                    }
                }
            }
            captureOriginals();

            // 应用名称 + 绑定事件
            applyNames();
            bindAll();

            // MutationObserver: 会话列表可能因虚拟滚动重新渲染
            const observer = new MutationObserver(() => {
                applyNames();
                bindAll();
            });

            const container = document.querySelector('[data-testid="conversation-view"]') || document.documentElement;
            observer.observe(container, { childList: true, subtree: true });

            window.__sessionRenamer = { observer, nameMap };

            return { status: isUpdate ? 'updated' : 'injected' };
        })()
    `;
}

// ============================================================
//  生成 Workspace 重命名脚本（注入到 Manager target）
// ============================================================

function buildWorkspaceRenamerScript(nameMap) {
    const nameMapJSON = JSON.stringify(nameMap);

    return `
        (() => {
            const nameMap = ${nameMapJSON};
            const RENAMER_MARKER = 'data-ws-renamer-bound';

            // 定位 Workspaces 区域
            function findWorkspaceSection() {
                const allDivs = document.querySelectorAll('div');
                for (const d of allDivs) {
                    if (d.textContent.trim() === 'Workspaces' && d.classList.contains('text-xs')) {
                        return d.closest('.flex.flex-col.gap-3');
                    }
                }
                return null;
            }

            // 找到 workspace 名称 span 列表
            function findWorkspaceSpans() {
                const section = findWorkspaceSection();
                if (!section) return [];
                const spans = section.querySelectorAll('span.text-sm.font-medium.truncate');
                return Array.from(spans).filter(s => {
                    const text = s.textContent.trim();
                    return text && text !== 'add';
                });
            }

            // 应用名称映射：将 span 的 textContent 替换为自定义名称
            function applyNames() {
                const spans = findWorkspaceSpans();
                for (const span of spans) {
                    // 用原始名称作 key（存于 data-original-name 或当前 textContent）
                    const originalName = span.getAttribute('data-original-name') || span.textContent.trim().replace(/^\u270f\ufe0f\s*/, '');
                    const entry = nameMap[originalName];
                    const customName = typeof entry === 'string' ? entry : entry?.name;
                    const displayName = customName ? '\u270f\ufe0f ' + customName : null;
                    if (displayName && span.textContent !== displayName) {
                        if (!span.hasAttribute('data-original-name')) {
                            span.setAttribute('data-original-name', span.textContent.trim());
                        }
                        span.textContent = '\u270f\ufe0f ' + customName;
                        span.title = '原始: ' + span.getAttribute('data-original-name');
                    }
                }
            }

            // 为 workspace span 绑定双击编辑事件
            function bindDblClick(span) {
                if (span.hasAttribute(RENAMER_MARKER)) return;
                span.setAttribute(RENAMER_MARKER, '1');

                span.addEventListener('dblclick', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();

                    const currentText = span.textContent.trim();
                    const originalName = span.getAttribute('data-original-name') || currentText;
                    const editValue = currentText.replace(/^\u270f\ufe0f\s*/, '');

                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = editValue;
                    input.className = span.className;
                    input.style.cssText = 'background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-focusBorder,#007fd4);border-radius:3px;padding:1px 4px;outline:none;width:100%;font-size:inherit;';

                    const parent = span.parentElement;
                    parent.replaceChild(input, span);
                    input.focus();
                    input.select();

                    let committed = false;

                    function commit() {
                        if (committed) return;
                        committed = true;
                        const newName = input.value.trim();
                        if (newName && newName !== originalName) {
                            span.textContent = '\u270f\ufe0f ' + newName;
                            span.setAttribute('data-original-name', originalName);
                            span.title = '原始: ' + originalName;
                            nameMap[originalName] = { name: newName, original: originalName };
                            try { window.__saveWorkspaceName(JSON.stringify({ key: originalName, name: newName, original: originalName })); } catch(_) {}
                        } else if (!newName) {
                            span.textContent = originalName;
                            span.removeAttribute('data-original-name');
                            span.title = '';
                            delete nameMap[originalName];
                            try { window.__saveWorkspaceName(JSON.stringify({ key: originalName, name: '' })); } catch(_) {}
                        } else {
                            span.textContent = currentText;
                        }
                        parent.replaceChild(span, input);
                    }

                    function cancel() {
                        if (committed) return;
                        committed = true;
                        span.textContent = currentText;
                        parent.replaceChild(span, input);
                    }

                    input.addEventListener('keydown', (ke) => {
                        if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
                        if (ke.key === 'Escape') { ke.preventDefault(); cancel(); }
                        ke.stopPropagation();
                    });
                    input.addEventListener('blur', () => commit());
                }, true);
            }

            // 绑定所有现有 workspace 标题
            function bindAll() {
                const spans = findWorkspaceSpans();
                for (const span of spans) {
                    bindDblClick(span);
                }
            }

            let isUpdate = false;
            if (window.__workspaceRenamer) {
                isUpdate = true;
                window.__workspaceRenamer.observer?.disconnect();
                const section = findWorkspaceSection();
                if (section) {
                    section.querySelectorAll('[' + RENAMER_MARKER + ']').forEach(el => {
                        el.removeAttribute(RENAMER_MARKER);
                        const clone = el.cloneNode(true);
                        el.parentNode?.replaceChild(clone, el);
                    });
                }
            }

            applyNames();
            bindAll();

            // MutationObserver: workspace 列表可能因切换/虚拟滚动重新渲染
            const section = findWorkspaceSection() || document.documentElement;
            const observer = new MutationObserver(() => {
                applyNames();
                bindAll();
            });

            observer.observe(section, { childList: true, subtree: true });

            window.__workspaceRenamer = { observer, nameMap };

            return { status: isUpdate ? 'updated' : 'injected' };
        })()
    `;
}

// ============================================================
//  持久连接管理器（TargetManager）
// ============================================================

let activeTargetManager = null;

class TargetManager {
    constructor() {
        /** @type {Map<string, { client: any, info: any, ready: boolean }>} */
        this.connections = new Map();
        this.detectionScript = buildDetectionScript(BUTTON_TEXTS);
        this.observerScript = buildObserverScript(BUTTON_TEXTS, AUTO_RETRY);
        activeTargetManager = this;
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

        // 对新 target 建立连接（跳过外部浏览器页面）
        const newTargets = targets.filter(t => {
            if (this.connections.has(t.id)) return false;
            // 跳过 AI 打开的外部网页（http/https），避免持久连接干扰关闭
            const url = t.url || '';
            if (url.startsWith('http://') || url.startsWith('https://')) {
                debug(`跳过外部网页: ${t.title || url}`);
                return false;
            }
            return true;
        });
        if (newTargets.length > 0) {
            debug(`发现 ${newTargets.length} 个新 target，正在建立连接...`);
            const attachPromises = newTargets.map(t => this.attachTarget(t));
            await Promise.allSettled(attachPromises);
        }

        // 补检：已连接但未注入 renamer 的 Manager target
        for (const t of targets) {
            if (t.title === 'Manager') {
                const conn = this.connections.get(t.id);
                if (conn && conn.ready && !conn.renamerInjected) {
                    await this.injectRenamer(conn.client, t.id);
                }
            }
        }

        return {
            total: targets.length,
            active: this.connections.size,
            newlyAdded: newTargets.length
        };
    }

    /**
     * 向 Manager target 注入会话重命名脚本
     */
    async injectRenamer(client, targetId) {
        try {
            const { Runtime } = client;

            // ---- 会话重命名 binding ----
            try {
                await Runtime.addBinding({ name: '__saveSessionName' });
            } catch (_) { /* binding 可能已存在 */ }

            // ---- Workspace 重命名 binding ----
            try {
                await Runtime.addBinding({ name: '__saveWorkspaceName' });
            } catch (_) { /* binding 可能已存在 */ }

            Runtime.bindingCalled(({ name, payload }) => {
                if (name === '__saveSessionName') {
                    try {
                        const { uuid, name: newName, original } = JSON.parse(payload);
                        saveSessionName(uuid, newName, original);
                    } catch (err) {
                        error(`保存会话名称失败: ${err.message}`);
                    }
                } else if (name === '__saveWorkspaceName') {
                    try {
                        const { key, name: newName, original } = JSON.parse(payload);
                        saveWorkspaceName(key, newName, original);
                    } catch (err) {
                        error(`保存 Workspace 名称失败: ${err.message}`);
                    }
                }
            });

            // ---- 注入会话重命名脚本 ----
            const sessionNames = loadSessionNames();
            const renamerScript = buildRenamerScript(sessionNames);
            const renamerResult = await Runtime.evaluate({
                expression: renamerScript,
                returnByValue: true,
                awaitPromise: false
            });

            const renamerStatus = renamerResult?.result?.value?.status;
            if (renamerStatus === 'injected') {
                log(`🏷️  会话重命名已注入 Manager (双击会话标题可编辑)`);
            } else if (renamerStatus === 'updated') {
                debug(`会话重命名映射已更新`);
            }

            // ---- 注入 Workspace 重命名脚本 ----
            const workspaceNames = loadWorkspaceNames();
            const wsRenamerScript = buildWorkspaceRenamerScript(workspaceNames);
            const wsResult = await Runtime.evaluate({
                expression: wsRenamerScript,
                returnByValue: true,
                awaitPromise: false
            });

            const wsStatus = wsResult?.result?.value?.status;
            if (wsStatus === 'injected') {
                log(`📂 Workspace 重命名已注入 Manager (双击 Workspace 名称可编辑)`);
            } else if (wsStatus === 'updated') {
                debug(`Workspace 重命名映射已更新`);
            }

            // 标记已注入
            const conn = this.connections.get(targetId);
            if (conn) conn.renamerInjected = true;

        } catch (err) {
            debug(`注入 renamer 失败: ${err.message}`);
        }
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
                    if (typeof msg === 'string') {
                        if (msg.startsWith('[AUTO-ACCEPT-CLICKED]')) {
                            try {
                                const clicked = JSON.parse(msg.replace('[AUTO-ACCEPT-CLICKED]', ''));
                                for (const text of clicked) {
                                    log(`✅ 自动点击了: [${text}]  (target: ${targetInfo.title || targetInfo.url || 'unknown'})`);
                                }
                            } catch (_) { /* ignore parse error */ }
                        } else if (msg.startsWith('[AUTO-RETRY]')) {
                            log(msg);
                        }
                    }
                }
            });

            // 判断是否为 Manager target（会话列表面板）
            const isManager = targetInfo.title === 'Manager';

            if (isManager) {
                await this.injectRenamer(client, targetInfo.id);
            }

            {
                // ---- 所有 target: 注入按钮自动点击 Observer（含 autoRetry）----
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
            }
            // 监听连接断开事件
            client.on('disconnect', () => {
                debug(`Target 连接断开: ${targetInfo.id}`);
                this.connections.delete(targetInfo.id);
            });

            this.connections.set(targetInfo.id, {
                client,
                info: targetInfo,
                ready: true,
                renamerInjected: isManager
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
