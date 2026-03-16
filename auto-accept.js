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
const AUTO_RETRY = config.autoRetry ?? { enabled: false }; // 自动重试配置
const RETRY_BUTTON_TEXTS = AUTO_RETRY.retryButtonTexts ?? ['Retry'];
const MODEL_FALLBACK = AUTO_RETRY.modelFallback ?? [];
const MAX_RETRIES = AUTO_RETRY.maxRetries ?? 3;
const CONTINUE_MESSAGE = AUTO_RETRY.continueMessage ?? '继续';
const RETURN_MODEL = AUTO_RETRY.returnModel ?? null; // 切回的目标模型

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

/**
 * 从 session-names.json 获取"原始名称 → 自定义名称"映射
 */
function getNameReplacements() {
    const names = loadSessionNames();
    const replacements = {};
    for (const [uuid, entry] of Object.entries(names)) {
        const customName = typeof entry === 'string' ? entry : entry.name;
        const originalName = typeof entry === 'string' ? null : entry.original;
        if (originalName && customName) {
            replacements[originalName] = customName;
        }
    }
    return replacements;
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

function buildDetectionScript(buttonTexts, retryButtonTexts) {
    const textsJSON = JSON.stringify(buttonTexts.map(t => t.toLowerCase()));
    const retryTextsJSON = JSON.stringify((retryButtonTexts || []).map(t => t.toLowerCase()));

    // buttonTexts 的顺序即优先级（靠前 = 优先级高）
    return `
        (() => {
            const targetTexts = ${textsJSON};
            const retryTexts = ${retryTextsJSON};
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
            const now = Date.now();
            for (const btn of allButtons) {
                if (btn.disabled) continue;
                const markerTs = btn.getAttribute(MARKER);
                if (markerTs && (now - parseInt(markerTs, 10)) < 5000) continue;
                const text = normalize((btn.textContent || '').trim());
                // 跳过 Retry 按钮（由 handleSmartRetry 专门处理）
                if (retryTexts.includes(text)) continue;
                candidates.push({ btn, text });
            }

            // 按配置优先级遍历：找到最高优先级的匹配按钮就只点它
            for (const target of targetTexts) {
                const match = candidates.find(c => c.text === target);
                if (match) {
                    // 只标记被点击的按钮
                    match.btn.setAttribute(MARKER, Date.now().toString());
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

function buildObserverScript(buttonTexts, retryButtonTexts) {
    const textsJSON = JSON.stringify(buttonTexts.map(t => t.toLowerCase()));
    const retryTextsJSON = JSON.stringify((retryButtonTexts || []).map(t => t.toLowerCase()));

    return `
        (() => {
            const targetTexts = ${textsJSON};
            const retryTexts = ${retryTextsJSON};

            // 如果已有旧 Observer，断开并重新注入（确保 buttonTexts 更新生效）
            if (window.__autoAcceptObserver) {
                window.__autoAcceptObserver.disconnect();
                window.__autoAcceptObserver = null;
            }
            const MARKER = 'data-auto-accepted';

            function normalize(rawText) {
                return rawText.trim()
                    .replace(/\\\\s*(Alt|Ctrl|Shift|Cmd|Meta)[+\\\\-].*$/i, '')
                    .trim()
                    .toLowerCase();
            }

            function scanAndClick(root) {
                const buttons = (root || document).querySelectorAll('button, [role="button"]');
                const candidates = [];
                const now = Date.now();
                for (const btn of buttons) {
                    if (btn.disabled) continue;
                    const markerTs = btn.getAttribute(MARKER);
                    if (markerTs && (now - parseInt(markerTs, 10)) < 5000) continue;
                    const text = normalize((btn.textContent || '').trim());
                    if (retryTexts.includes(text)) continue;
                    candidates.push({ btn, text });
                }

                for (const target of targetTexts) {
                    const match = candidates.find(c => c.text === target);
                    if (match) {
                        match.btn.setAttribute(MARKER, Date.now().toString());
                        match.btn.click();
                        return [match.text];
                    }
                }
                return [];
            }

            const initialClicked = scanAndClick(document);

            const observer = new MutationObserver((mutations) => {
                let needScan = false;
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        needScan = true;
                        break;
                    }
                    if (mutation.type === 'attributes') {
                        const attr = mutation.attributeName;
                        if (attr === 'disabled' || attr === 'class') {
                            const t = mutation.target;
                            if (t.tagName === 'BUTTON' || t.getAttribute?.('role') === 'button') {
                                needScan = true;
                                break;
                            }
                        }
                    }
                }
                if (needScan) {
                    const clicked = scanAndClick(document);
                    if (clicked.length > 0) {
                        console.log('[AUTO-ACCEPT-CLICKED]' + JSON.stringify(clicked));
                    }
                }
            });

            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['disabled', 'class']
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
//  生成全局名称替换脚本（注入到所有 target）
// ============================================================

function buildNameReplacerScript(replacements) {
    if (Object.keys(replacements).length === 0) return null;

    const replacementsJSON = JSON.stringify(replacements);

    return `
        (() => {
            const replacements = ${replacementsJSON};
            const REPLACER_MARKER = 'data-name-replaced';
            const originals = Object.keys(replacements);
            if (originals.length === 0) return { status: 'empty' };

            function replaceNames() {
                const walker = document.createTreeWalker(
                    document.body || document.documentElement,
                    NodeFilter.SHOW_TEXT,
                    null
                );

                let node;
                while (node = walker.nextNode()) {
                    const parent = node.parentElement;
                    if (!parent) continue;
                    const tag = parent.tagName;
                    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') continue;

                    const text = node.nodeValue;
                    if (!text || text.trim().length === 0) continue;

                    for (const original of originals) {
                        if (text.includes(original)) {
                            node.nodeValue = text.replace(original, replacements[original]);
                            if (parent && !parent.hasAttribute(REPLACER_MARKER)) {
                                parent.setAttribute(REPLACER_MARKER, '1');
                            }
                        }
                    }
                }
            }

            if (window.__nameReplacer) {
                Object.assign(window.__nameReplacer.replacements, replacements);
                replaceNames();
                return { status: 'updated' };
            }

            replaceNames();

            const observer = new MutationObserver((mutations) => {
                let needReplace = false;
                for (const m of mutations) {
                    if (m.addedNodes.length > 0) { needReplace = true; break; }
                }
                if (needReplace) replaceNames();
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });

            window.__nameReplacer = { observer, replacements };
            return { status: 'injected' };
        })()
    `;
}

// ============================================================
//  智能 Retry 脚本
// ============================================================

/** 轻量检测：仅检查 Retry 按钮是否存在 */
function buildRetryDetectionScript() {
    return `(() => {
        const btns = document.querySelectorAll('button');
        let hasRetry = false, hasDebugInfo = false;
        for (const btn of btns) {
            const t = (btn.textContent || '').trim();
            if (t === 'Retry' && !btn.disabled) hasRetry = true;
            if ((t === 'Copy debug info' || t === 'Copied!') && !btn.disabled) hasDebugInfo = true;
        }
        return hasRetry ? { hasRetry, hasDebugInfo } : null;
    })()`;
}

/** 读取 debug info */
function buildReadDebugInfoScript() {
    return `(async () => {
        const btns = document.querySelectorAll('button');
        let debugBtn = null;
        for (const btn of btns) {
            const t = (btn.textContent || '').trim();
            if ((t === 'Copy debug info' || t === 'Copied!') && !btn.disabled) debugBtn = btn;
        }
        if (!debugBtn) return { errorCode: null, raw: 'no debug info button' };
        let captured = null;
        const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text) => { captured = text; return orig(text); };
        debugBtn.click();
        await new Promise(r => setTimeout(r, 300));
        navigator.clipboard.writeText = orig;
        if (!captured) return { errorCode: null, raw: 'clipboard capture failed' };
        let errorCode = null, errorReason = null, errorMessage = null, modelName = null;
        try {
            const lines = captured.split('\\n');
            let jsonStr = '';
            let depth = 0;
            let capturing = false;
            for (const line of lines) {
                if (!capturing && line.includes('"error"') && line.includes('{')) {
                    capturing = true;
                }
                if (capturing) {
                    jsonStr += line;
                    for (const ch of line) {
                        if (ch === '{') depth++;
                        if (ch === '}') depth--;
                    }
                    if (depth <= 0) break;
                }
            }
            if (jsonStr) {
                const start = jsonStr.indexOf('{');
                const obj = JSON.parse(jsonStr.substring(start));
                errorCode = obj.error?.code;
                errorMessage = obj.error?.message;
                const d = obj.error?.details;
                if (d && d.length > 0) { errorReason = d[0]?.reason; modelName = d[0]?.metadata?.model; }
            }
        } catch (_) {}
        if (!errorCode) { const h = captured.match(/HTTP\\s+(\\d{3})/); if (h) errorCode = parseInt(h[1], 10); }
        return { errorCode, errorReason, errorMessage, modelName, raw: captured.substring(0, 500) };
    })()`;
}

/** 点击 Retry 按钮 */
function buildClickRetryScript() {
    return `(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
            if (btn.textContent.trim() === 'Retry' && !btn.disabled) { btn.click(); return true; }
        }
        return false;
    })()`;
}

/** 切换模型 */
function buildSwitchModelScript(targetModelName) {
    const lower = targetModelName.toLowerCase();
    return `(async () => {
        let trigger = null;
        const candidates = document.querySelectorAll('div[tabindex="0"].cursor-pointer');
        for (const el of candidates) {
            const nameSpan = el.querySelector('span.select-none.overflow-hidden');
            if (nameSpan) {
                const t = nameSpan.textContent.trim();
                if (['Gemini', 'Claude', 'GPT', 'Opus', 'Sonnet', 'Flash'].some(m => t.includes(m))) {
                    trigger = el;
                    break;
                }
            }
        }
        if (!trigger) return { success: false, error: 'model trigger not found' };
        
        trigger.click();
        await new Promise(r => setTimeout(r, 500));
        
        const items = document.querySelectorAll('div.px-2.py-1.cursor-pointer');
        for (const item of items) {
            const nameSpan = item.querySelector('span.text-xs.font-medium span');
            if (!nameSpan) continue;
            if (nameSpan.textContent.trim().toLowerCase().includes('${lower}')) {
                item.click();
                await new Promise(r => setTimeout(r, 300));
                return { success: true, model: nameSpan.textContent.trim() };
            }
        }
        
        trigger.click();
        return { success: false, error: 'target model not found in dropdown' };
    })()`;
}

/**
 * 通过 Runtime.evaluate + Input.insertText + Enter 发送消息
 */
async function sendMessageViaCDP(client, message) {
    const { Runtime, Input } = client;

    const focusResult = await Runtime.evaluate({
        expression: `(() => {
            const el = document.querySelector('#antigravity\\\\\\\\.agentSidePanelInputBox [contenteditable="true"]');
            if (!el) return { found: false };
            el.focus();
            return { found: true, tag: el.tagName };
        })()`,
        returnByValue: true, awaitPromise: false
    });
    if (!focusResult?.result?.value?.found) {
        return { success: false, error: 'contenteditable div not found in agentSidePanelInputBox' };
    }

    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', code: 'Backspace' });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', code: 'Backspace' });

    await Input.insertText({ text: message });

    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter' });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });

    return { success: true, method: 'cdp-runtime-input' };
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

            // 找到 workspace 名称 span 列表，并为每个 span 计算唯一 key
            // key 规则：对同名 workspace 追加 #index（如 "bi4.0.code-workspace#1"），唯一名称不加后缀
            function findWorkspaceSpansWithKeys() {
                const section = findWorkspaceSection();
                if (!section) return [];
                const spans = section.querySelectorAll('span.text-sm.font-medium.truncate');
                const filtered = Array.from(spans).filter(s => {
                    const text = s.textContent.trim();
                    return text && text !== 'add';
                });

                // 统计原始名称出现次数
                const nameCount = {};
                const nameIndex = {};
                for (const span of filtered) {
                    const rawName = span.getAttribute('data-original-name')
                        || span.textContent.trim().replace(/^\ud83d\udcc2\s*/, '');
                    nameCount[rawName] = (nameCount[rawName] || 0) + 1;
                }

                // 为每个 span 生成唯一 key
                const result = [];
                for (const span of filtered) {
                    const rawName = span.getAttribute('data-original-name')
                        || span.textContent.trim().replace(/^\ud83d\udcc2\s*/, '');
                    let key;
                    if (nameCount[rawName] > 1) {
                        // 同名多个：用 name#index 区分
                        nameIndex[rawName] = (nameIndex[rawName] || 0);
                        key = rawName + '#' + nameIndex[rawName];
                        nameIndex[rawName]++;
                    } else {
                        key = rawName;
                    }
                    // 将 key 存到 DOM 上，以便双击编辑时读取
                    span.setAttribute('data-ws-key', key);
                    result.push({ span, key, rawName });
                }
                return result;
            }

            // 应用名称映射
            function applyNames() {
                const items = findWorkspaceSpansWithKeys();
                for (const { span, key, rawName } of items) {
                    const entry = nameMap[key];
                    const customName = typeof entry === 'string' ? entry : entry?.name;
                    const displayName = customName ? '\ud83d\udcc2 ' + customName : null;
                    if (displayName && span.textContent !== displayName) {
                        if (!span.hasAttribute('data-original-name')) {
                            span.setAttribute('data-original-name', rawName);
                        }
                        span.textContent = '\ud83d\udcc2 ' + customName;
                        span.title = '原始: ' + rawName;
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

                    const wsKey = span.getAttribute('data-ws-key');
                    const currentText = span.textContent.trim();
                    const originalName = span.getAttribute('data-original-name') || currentText;
                    const editValue = currentText.replace(/^\ud83d\udcc2\s*/, '');

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
                            span.textContent = '\ud83d\udcc2 ' + newName;
                            span.setAttribute('data-original-name', originalName);
                            span.title = '原始: ' + originalName;
                            nameMap[wsKey] = { name: newName, original: originalName };
                            try { window.__saveWorkspaceName(JSON.stringify({ key: wsKey, name: newName, original: originalName })); } catch(_) {}
                        } else if (!newName) {
                            span.textContent = originalName;
                            span.removeAttribute('data-original-name');
                            span.title = '';
                            delete nameMap[wsKey];
                            try { window.__saveWorkspaceName(JSON.stringify({ key: wsKey, name: '' })); } catch(_) {}
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
                const items = findWorkspaceSpansWithKeys();
                for (const { span } of items) {
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

class TargetManager {
    constructor() {
        /** @type {Map<string, { client: any, info: any, ready: boolean }>} */
        this.connections = new Map();
        this.detectionScript = buildDetectionScript(BUTTON_TEXTS, RETRY_BUTTON_TEXTS);
        this.observerScript = buildObserverScript(BUTTON_TEXTS, RETRY_BUTTON_TEXTS);
        this.retryDetectionScript = buildRetryDetectionScript();
        /** @type {any} browser-level CDP 连接 */
        this.browserClient = null;
        /** @type {Map<string, number>} 每个 target 的重试计数器 */
        this.retryCounters = new Map();
    }

    /**
     * 获取所有 target（合并 CDP.List 和 browser-level Target.getTargets）
     */
    async getAllTargets() {
        const targetsById = new Map();

        try {
            const listTargets = await withTimeout(CDP.List({ port: PORT }), 5000, 'CDP.List');
            for (const t of listTargets) {
                targetsById.set(t.id, t);
            }
        } catch (_) { }

        try {
            if (!this.browserClient) {
                const version = await withTimeout(CDP.Version({ port: PORT }), 5000, 'CDP.Version');
                if (version.webSocketDebuggerUrl) {
                    this.browserClient = await withTimeout(
                        CDP({ target: version.webSocketDebuggerUrl }),
                        5000, 'browser CDP connect'
                    );
                    this.browserClient.on('disconnect', () => {
                        debug('Browser-level 连接已断开，将在下次轮询时重建');
                        this.browserClient = null;
                    });
                }
            }

            if (this.browserClient) {
                const { Target } = this.browserClient;
                await withTimeout(Target.setDiscoverTargets({ discover: true }), 5000, 'setDiscoverTargets');
                const { targetInfos } = await withTimeout(Target.getTargets(), 5000, 'getTargets');

                for (const t of targetInfos) {
                    if (!targetsById.has(t.targetId)) {
                        targetsById.set(t.targetId, {
                            id: t.targetId,
                            type: t.type,
                            title: t.title,
                            url: t.url,
                            webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/${t.targetId}`
                        });
                        debug(`[browser-level] 发现额外 target: [${t.type}] ${t.title} (${t.url?.substring(0, 60)})`);
                    }
                }
            }
        } catch (err) {
            debug(`Browser-level target 发现失败: ${err.message}`);
            if (this.browserClient) {
                try { await this.browserClient.close(); } catch (_) { }
                this.browserClient = null;
            }
        }

        if (targetsById.size === 0 && this.browserClient) {
            debug('未发现任何 target，重置 browser-level 连接');
            try { await this.browserClient.close(); } catch (_) { }
            this.browserClient = null;
        }

        return Array.from(targetsById.values());
    }

    /**
     * 同步 target 列表：新增连接、清理过期连接
     */
    async syncTargets() {
        let targets;
        try {
            targets = await withTimeout(CDP.List({ port: PORT }), 5000, 'CDP.List');
        } catch (err) {
            throw new Error(`无法获取 target 列表: ${err.message}`);
        }

        if (targets.length === 0) {
            throw new Error('未发现任何 target');
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

        // 对新 target 建立连接（跳过外部网页）
        const newTargets = targets.filter(t => {
            if (this.connections.has(t.id)) return false;
            const url = t.url || '';
            if (url.startsWith('http://') || url.startsWith('https://')) {
                debug(`跳过外部网页: ${t.title || url}`);
                return false;
            }
            return true;
        });
        if (newTargets.length > 0) {
            debug(`发现 ${newTargets.length} 个新 target，正在建立连接...`);
            const attachPromises = newTargets.map(t =>
                withTimeout(this.attachTarget(t), 10000, `attach(${t.title || t.id?.substring(0, 8)})`)
                    .catch(err => debug(`attachTarget 超时: ${t.title || t.id} - ${err.message}`))
            );
            await Promise.allSettled(attachPromises);
        }

        // 补检：已连接但未注入 renamer 的 Manager target
        for (const t of targets) {
            if (t.title === 'Manager') {
                const conn = this.connections.get(t.id);
                if (conn && conn.ready && !conn.renamerInjected) {
                    debug('补检: Manager target 需要注入 renamer');
                    await this.injectRenamer(conn, t);
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
     * 对单个 target 建立持久连接，注入 MutationObserver
     */
    async attachTarget(targetInfo) {
        let client;
        try {
            client = await withTimeout(
                CDP({
                    target: targetInfo,
                    port: PORT,
                    local: true
                }),
                3000,
                `attachTarget(${targetInfo.id?.substring(0, 8) || 'unknown'})`
            );

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

            // 判断 target 类型
            const targetUrl = targetInfo.url || '';
            const targetType = targetInfo.type || 'page';
            const isManager = targetInfo.title === 'Manager';
            const isWorker = targetType === 'worker' || targetType === 'service_worker';

            // 跳过 worker（没有 DOM）
            if (isWorker) {
                debug(`跳过 worker target: ${targetInfo.id}`);
                try { await client.close(); } catch (_) { }
                return;
            }

            // Manager target: 注入 renamer
            let renamerInjected = false;
            if (isManager) {
                renamerInjected = await this.injectRenamer({ client, info: targetInfo }, targetInfo);

                // Manager 也注入按钮自动点击 Observer
                try {
                    await Runtime.evaluate({
                        expression: this.observerScript,
                        returnByValue: true,
                        awaitPromise: false
                    });
                    debug('Observer 也已注入 Manager');
                } catch (_) {}
            } else {
                // 普通 target: 注入按钮自动点击 Observer
                const injectObserver = async () => {
                    try {
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
                        }
                    } catch (err) {
                        debug(`Observer 注入失败: ${err.message}`);
                    }
                };

                await injectObserver();

                // 监听页面导航/刷新：页面内容变化会导致注入的 Observer 丢失
                try {
                    const { Page } = client;
                    await Page.enable();
                    Page.frameNavigated(() => {
                        debug(`页面导航，重新注入 Observer: ${targetInfo.title || targetInfo.id}`);
                        setTimeout(() => injectObserver(), 500);
                    });
                } catch (_) { /* 部分 target 可能不支持 Page domain */ }

                // 监听执行上下文销毁：webview 内容刷新时会销毁旧的上下文
                Runtime.executionContextDestroyed(() => {
                    debug(`执行上下文销毁，重新注入 Observer: ${targetInfo.title || targetInfo.id}`);
                    setTimeout(() => injectObserver(), 500);
                });
            }

            // 所有 target 都注入全局名称替换脚本
            const replacements = getNameReplacements();
            const replacerScript = buildNameReplacerScript(replacements);
            if (replacerScript) {
                try {
                    await Runtime.evaluate({
                        expression: replacerScript,
                        returnByValue: true,
                        awaitPromise: false
                    });
                } catch (_) { /* 忽略替换失败 */ }
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
                renamerInjected
            });

        } catch (err) {
            debug(`连接 target 失败 (${targetInfo.id || 'unknown'}): ${err.message}`);
            if (client) {
                try { await client.close(); } catch (_) { /* ignore */ }
            }
        }
    }

    /**
     * 向 Manager target 注入会话重命名脚本
     * @returns {boolean} 是否注入成功
     */
    async injectRenamer(conn, targetInfo) {
        try {
            const { Runtime } = conn.client;

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
                log('🏷️  会话重命名已注入 Manager (双击会话标题可编辑)');
            } else if (renamerStatus === 'updated') {
                debug('会话重命名映射已更新');
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
            const stored = this.connections.get(targetInfo.id);
            if (stored) stored.renamerInjected = true;

            return true;
        } catch (err) {
            debug(`注入 renamer 失败: ${err.message}`);
            return false;
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
     * 智能 Retry：检测错误卡片，根据错误类型执行不同策略
     */
    async handleSmartRetry() {
        for (const [id, conn] of this.connections) {
            if (!conn.ready) continue;
            const retryCount = this.retryCounters.get(id) || 0;
            if (retryCount >= MAX_RETRIES) continue;
            const title = conn.info.title || conn.info.id || '';
            try {
                debug(`  Smart retry 检查: ${title || id.substring(0, 8)}`);
                const detect = await withTimeout(
                    conn.client.Runtime.evaluate({
                        expression: this.retryDetectionScript,
                        returnByValue: true, awaitPromise: false
                    }), 1500, `retryDetect(${id.substring(0, 8)})`);

                const info = detect?.result?.value;
                if (!info || !info.hasRetry) {
                    if (retryCount > 0) {
                        this.retryCounters.delete(id);
                        debug(`  重试计数器已清零: ${title}`);
                    }
                    continue;
                }

                const newCount = retryCount + 1;
                this.retryCounters.set(id, newCount);
                log(`🔍 检测到 Retry 按钮 (target: ${title}, 第 ${newCount}/${MAX_RETRIES} 次)`);

                if (newCount >= MAX_RETRIES) {
                    log(`  ⚠️ 已达最大重试次数 (${MAX_RETRIES})，停止自动重试`);
                    continue;
                }

                // 读取 debug info
                let errorCode = null;
                if (info.hasDebugInfo) {
                    try {
                        const debugResult = await withTimeout(
                            conn.client.Runtime.evaluate({
                                expression: buildReadDebugInfoScript(),
                                returnByValue: true, awaitPromise: true
                            }), 8000, `readDebugInfo(${id.substring(0, 8)})`);
                        const errInfo = debugResult?.result?.value;
                        if (errInfo) {
                            errorCode = errInfo.errorCode;
                            log(`  📋 错误详情: HTTP ${errorCode} - ${errInfo.errorReason || errInfo.errorMessage || 'unknown'}`);
                        }
                    } catch (debugErr) {
                        debug(`  读取 debug info 失败: ${debugErr.message}`);
                    }
                }

                // 根据错误码执行策略
                if (errorCode === 400 && MODEL_FALLBACK.length > 0) {
                    const curModel = await conn.client.Runtime.evaluate({
                        expression: `(() => { const b = document.querySelector('[role="button"][aria-haspopup="dialog"]'); return b ? b.textContent.trim() : null; })()`,
                        returnByValue: true, awaitPromise: false
                    });
                    const originalModel = curModel?.result?.value;

                    let targetModel = MODEL_FALLBACK[0];
                    if (originalModel) {
                        const lowerOriginal = originalModel.toLowerCase();
                        let currentIdx = -1;
                        for (let i = 0; i < MODEL_FALLBACK.length; i++) {
                            if (lowerOriginal.includes(MODEL_FALLBACK[i].toLowerCase())) {
                                currentIdx = i;
                                break;
                            }
                        }
                        targetModel = MODEL_FALLBACK[(currentIdx + 1) % MODEL_FALLBACK.length];
                    }

                    log(`  ⚠️ 400 错误: 切到 ${targetModel} → Retry → 切回 → 发送"${CONTINUE_MESSAGE}"`);

                    const sw = await withTimeout(conn.client.Runtime.evaluate({
                        expression: buildSwitchModelScript(targetModel),
                        returnByValue: true, awaitPromise: true
                    }), 5000, 'switchModel');
                    if (!sw?.result?.value?.success) {
                        log(`  ❌ 切换模型失败，直接 Retry`);
                        await conn.client.Runtime.evaluate({ expression: buildClickRetryScript(), returnByValue: true, awaitPromise: false });
                        continue;
                    }
                    log(`  ✅ 已切换到: ${sw.result.value.model}`);
                    await sleep(500);

                    await conn.client.Runtime.evaluate({ expression: buildClickRetryScript(), returnByValue: true, awaitPromise: false });
                    log(`  ✅ 已点击 Retry`);
                    await sleep(1000);

                    const returnTo = RETURN_MODEL || originalModel;
                    if (returnTo) {
                        try {
                            const swBack = await withTimeout(conn.client.Runtime.evaluate({
                                expression: buildSwitchModelScript(returnTo),
                                returnByValue: true, awaitPromise: true
                            }), 5000, 'switchBack');
                            if (swBack?.result?.value?.success) log(`  ✅ 已切回: ${swBack.result.value.model}`);
                            else log(`  ⚠️ 切回失败: ${swBack?.result?.value?.error}`);
                        } catch (swErr) {
                            log(`  ⚠️ 切回异常: ${swErr.message}`);
                        }
                    }
                    await sleep(500);

                    try {
                        const send = await withTimeout(
                            sendMessageViaCDP(conn.client, CONTINUE_MESSAGE),
                            10000, 'sendMsg'
                        );
                        if (send?.success) log(`  ✅ 已发送"${CONTINUE_MESSAGE}"`);
                        else log(`  ⚠️ 发送失败: ${send?.error}`);
                    } catch (sendErr) {
                        log(`  ⚠️ 发送异常: ${sendErr.message}`);
                    }

                    log(`  🎉 400 错误恢复完成 (target: ${title})`);
                } else {
                    log(`  🔄 HTTP ${errorCode || '未知'} 错误，直接 Retry...`);
                    await conn.client.Runtime.evaluate({ expression: buildClickRetryScript(), returnByValue: true, awaitPromise: false });
                    log(`  ✅ 已自动 Retry (target: ${title})`);
                }
            } catch (err) {
                debug(`Smart retry 失败 (${id}): ${err.message}`);
            }
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
                const result = await withTimeout(
                    conn.client.Runtime.evaluate({
                        expression: this.detectionScript,
                        returnByValue: true,
                        awaitPromise: false
                    }),
                    5000,
                    `fallbackScan(${id.substring(0, 8)})`
                );

                if (result?.result?.value) {
                    const clicked = result.result.value;
                    totalClicked += clicked.length;
                    for (const text of clicked) {
                        log(`✅ 自动点击了: [${text}]  (target: ${conn.info.title || conn.info.url || 'unknown'})`);
                    }
                }
            } catch (err) {
                debug(`Fallback 扫描失败 (${id}): ${err.message}`);
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
        if (this.browserClient) {
            try { await this.browserClient.close(); } catch (_) { }
            this.browserClient = null;
        }
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
    const detectionScript = buildDetectionScript(BUTTON_TEXTS, RETRY_BUTTON_TEXTS);
    let consecutiveErrors = 0;
    let connected = false;
    let pollCount = 0;
    const HEARTBEAT_POLLS = Math.round(30000 / POLL_INTERVAL);

    // 持久模式下的 fallback 轮询间隔（MutationObserver 是主力，fallback 仅兜底）
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
    log(`  请确保 IDE 已添加 --remote-debugging-port=${PORT} 启动参数`);
    log('');

    async function poll() {
        // 1. syncTargets（可能超时，但不应阻止后续的 smartRetry）
        try {
            await withTimeout((async () => {
                let targetCount;

                if (USE_PERSISTENT_MODE) {
                    const stats = await targetManager.syncTargets();
                    targetCount = stats.total;
                } else {
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
            })(), 60000, 'poll');
        } catch (err) {
            consecutiveErrors++;

            if (USE_PERSISTENT_MODE) {
                const isTimeout = err.message && err.message.includes('超时');
                if (!isTimeout) {
                    connected = false;
                    await targetManager.closeAll();
                } else {
                    debug('poll 超时但不清理连接（连接可能仍然有效）');
                }
            } else {
                connected = false;
            }

            if (consecutiveErrors === 1) {
                debug(`连接失败: ${err.message}`);
                log('⚠️  未检测到 IDE 调试端口，将持续重试...');
            }

            if (!AUTO_RECONNECT) {
                error('自动重连已禁用，脚本退出。');
                process.exit(1);
            }
        }

        // 2. 智能 Retry（独立执行，不受 syncTargets 超时影响）
        if (USE_PERSISTENT_MODE && targetManager.connections.size > 0) {
            try {
                await withTimeout(targetManager.handleSmartRetry(), 15000, 'smartRetry');
            } catch (e) {
                debug(`Smart retry 超时或异常: ${e.message}`);
            }

            if (pollCount > 0 && pollCount % FALLBACK_INTERVAL === 0) {
                try {
                    await targetManager.fallbackScan();
                } catch (_) { }
            }
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

/**
 * 给 Promise 加超时保护，防止 CDP 操作永久挂起
 */
function withTimeout(promise, ms, label = 'operation') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} 超时 (${ms}ms)`));
        }, ms);
        promise.then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
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
