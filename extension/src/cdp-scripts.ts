/**
 * CDP 注入脚本生成器
 *
 * 生成要通过 Runtime.evaluate 注入到页面中执行的 JavaScript 代码片段。
 * 从 auto-accept.js 移植，仅保留按钮检测和重试相关脚本。
 */

// ============================================================
//  按钮检测脚本（一次性扫描 + 点击）
// ============================================================

/**
 * 构建按钮检测脚本：扫描 DOM 中的按钮，按优先级点击第一个匹配项
 */
export function buildDetectionScript(
    buttonTexts: string[],
    retryButtonTexts: string[],
): string {
    const textsJSON = JSON.stringify(buttonTexts.map((t) => t.toLowerCase()));
    const retryTextsJSON = JSON.stringify(
        retryButtonTexts.map((t) => t.toLowerCase()),
    );

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

            const allButtons = document.querySelectorAll('button, [role="button"]');
            const candidates = [];
            const now = Date.now();
            for (const btn of allButtons) {
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

            return null;
        })()
    `;
}

// ============================================================
//  MutationObserver 注入脚本（常驻 target，实时监听 DOM 变化）
// ============================================================

/**
 * 构建 MutationObserver 注入脚本：
 *   - 持久注入到 target 中，监听 DOM 添加/属性变化
 *   - 按钮出现时立即点击，通过 console.log 回报结果
 *   - 解决短连接模式下 Run 等按钮瞬间出现又消失的问题
 */
export function buildObserverScript(
    buttonTexts: string[],
    retryButtonTexts: string[],
): string {
    const textsJSON = JSON.stringify(buttonTexts.map((t) => t.toLowerCase()));
    const retryTextsJSON = JSON.stringify(
        retryButtonTexts.map((t) => t.toLowerCase()),
    );

    return `
        (() => {
            const targetTexts = ${textsJSON};
            const retryTexts = ${retryTextsJSON};

            // 断开旧 Observer（确保 buttonTexts 更新生效）
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
//  Retry 检测脚本
// ============================================================

/**
 * 轻量检测：仅检查 Retry 按钮是否存在
 */
export function buildRetryDetectionScript(): string {
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

/**
 * 读取 debug info（点击 "Copy debug info" 按钮，拦截剪贴板）
 */
export function buildReadDebugInfoScript(): string {
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

/**
 * 点击 Retry 按钮
 */
export function buildClickRetryScript(): string {
    return `(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
            if (btn.textContent.trim() === 'Retry' && !btn.disabled) { btn.click(); return true; }
        }
        return false;
    })()`;
}

/**
 * 切换模型
 */
export function buildSwitchModelScript(targetModelName: string): string {
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
