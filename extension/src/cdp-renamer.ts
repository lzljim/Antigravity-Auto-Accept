import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';

interface NameEntry {
    name: string;
    original: string;
}

/**
 * CDP 重命名管理器 — 会话 + Workspace 重命名
 *
 * 从 auto-accept.js L278-779 完整移植：
 *   - 在 Manager Target 中注入 Runtime.addBinding 回调
 *   - 注入会话重命名脚本（data-testid 查询 + 双击编辑 + MutationObserver）
 *   - 注入 Workspace 重命名脚本（同上逻辑，针对 span.text-sm.font-medium.truncate）
 *   - JSON 持久化到 globalStorageUri
 */
export class CDPRenamer {
    private sessionNames: Record<string, NameEntry> = {};
    private workspaceNames: Record<string, NameEntry> = {};
    private storagePath: string;
    private logger: Logger;

    constructor(storagePath: string, logger: Logger) {
        this.storagePath = storagePath;
        this.logger = logger;
        this.loadAll();
    }

    // ── 持久化 ──

    private get sessionNamesPath(): string { return join(this.storagePath, 'session-names.json'); }
    private get workspaceNamesPath(): string { return join(this.storagePath, 'workspace-names.json'); }

    private loadAll(): void {
        this.sessionNames = this.loadJson(this.sessionNamesPath);
        this.workspaceNames = this.loadJson(this.workspaceNamesPath);
    }

    private loadJson(path: string): Record<string, NameEntry> {
        try {
            return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
        } catch {
            return {};
        }
    }

    /** 获取所有会话名称（供外部查询） */
    getSessionNames(): Record<string, NameEntry> {
        return { ...this.sessionNames };
    }

    /** 获取所有 Workspace 名称（供外部查询） */
    getWorkspaceNames(): Record<string, NameEntry> {
        return { ...this.workspaceNames };
    }

    saveSessionName(uuid: string, name: string, original?: string): void {
        if (name?.trim()) {
            this.sessionNames[uuid] = { name: name.trim(), original: original || '' };
        } else {
            delete this.sessionNames[uuid];
        }
        writeFileSync(this.sessionNamesPath, JSON.stringify(this.sessionNames, null, 2));
        this.logger.info(`📝 会话名称已保存: ${uuid.substring(0, 8)}... → "${name}"`);
    }

    saveWorkspaceName(key: string, name: string, original?: string): void {
        if (name?.trim()) {
            this.workspaceNames[key] = { name: name.trim(), original: original || '' };
        } else {
            delete this.workspaceNames[key];
        }
        writeFileSync(this.workspaceNamesPath, JSON.stringify(this.workspaceNames, null, 2));
        this.logger.info(`📝 Workspace 名称已保存: "${key}" → "${name}"`);
    }

    // ── 注入到 Manager Target ──

    /**
     * 在 CDPTargetManager.scanTarget() 中，当 target.title === 'Manager' 时调用。
     * 注册 binding 回调 + 注入会话重命名 + Workspace 重命名脚本。
     */
    async injectToManager(client: any): Promise<boolean> {
        const { Runtime } = client;

        // 1. 注册 binding 回调
        try { await Runtime.addBinding({ name: '__saveSessionName' }); } catch { /* 已存在则忽略 */ }
        try { await Runtime.addBinding({ name: '__saveWorkspaceName' }); } catch { /* 已存在则忽略 */ }

        Runtime.bindingCalled(({ name, payload }: { name: string; payload: string }) => {
            try {
                const data = JSON.parse(payload);
                if (name === '__saveSessionName') {
                    this.saveSessionName(data.uuid, data.name, data.original);
                } else if (name === '__saveWorkspaceName') {
                    this.saveWorkspaceName(data.key, data.name, data.original);
                }
            } catch (e) {
                this.logger.error(`保存名称失败: ${e}`);
            }
        });

        // 2. 注入会话重命名脚本
        await Runtime.evaluate({
            expression: this.buildSessionRenamerScript(),
            returnByValue: true,
            awaitPromise: false,
        });

        // 3. 注入 Workspace 重命名脚本
        await Runtime.evaluate({
            expression: this.buildWorkspaceRenamerScript(),
            returnByValue: true,
            awaitPromise: false,
        });

        this.logger.info('🏷️  重命名脚本已注入 Manager');
        return true;
    }

    /**
     * 生成会话重命名注入脚本
     * 完整移植自 auto-accept.js buildRenamerScript() L282-439
     */
    private buildSessionRenamerScript(): string {
        const nameMapJSON = JSON.stringify(this.sessionNames);

        return `
        (() => {
            const nameMap = ${nameMapJSON};
            const RENAMER_MARKER = 'data-renamer-bound';

            function applyNames() {
                const spans = document.querySelectorAll('[data-testid^="convo-pill-"]');
                for (const span of spans) {
                    const testId = span.getAttribute('data-testid');
                    const uuid = testId.replace('convo-pill-', '');
                    const entry = nameMap[uuid];
                    const customName = typeof entry === 'string' ? entry : entry?.name;
                    const displayName = customName ? '\\u270f\\ufe0f ' + customName : null;
                    if (displayName && span.textContent !== displayName) {
                        if (!span.hasAttribute('data-original-name')) {
                            span.setAttribute('data-original-name', span.textContent);
                        }
                        span.textContent = '\\u270f\\ufe0f ' + customName;
                        span.title = '原始: ' + span.getAttribute('data-original-name');
                    }
                }
            }

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
                    const editValue = currentText.replace(/^\\u270f\\ufe0f\\s*/, '');

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
                            span.textContent = '\\u270f\\ufe0f ' + newName;
                            span.setAttribute('data-original-name', originalName);
                            span.title = '原始: ' + originalName;
                            nameMap[uuid] = { name: newName, original: originalName };
                            try { window.__saveSessionName(JSON.stringify({ uuid, name: newName, original: originalName })); } catch(_) {}
                        } else if (!newName) {
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

            function bindAll() {
                const spans = document.querySelectorAll('[data-testid^="convo-pill-"]');
                for (const span of spans) { bindDblClick(span); }
            }

            let isUpdate = false;
            if (window.__sessionRenamer) {
                isUpdate = true;
                window.__sessionRenamer.observer?.disconnect();
                document.querySelectorAll('[' + RENAMER_MARKER + ']').forEach(el => {
                    el.removeAttribute(RENAMER_MARKER);
                    const clone = el.cloneNode(true);
                    el.parentNode?.replaceChild(clone, el);
                });
            }

            function captureOriginals() {
                const spans = document.querySelectorAll('[data-testid^="convo-pill-"]');
                for (const span of spans) {
                    const testId = span.getAttribute('data-testid');
                    const uuid = testId.replace('convo-pill-', '');
                    const entry = nameMap[uuid];
                    const customName = typeof entry === 'string' ? entry : entry?.name;
                    const storedOriginal = typeof entry === 'string' ? null : entry?.original;
                    if (customName && (!storedOriginal) && span.textContent !== customName) {
                        const domOriginal = span.textContent;
                        try { window.__saveSessionName(JSON.stringify({ uuid, name: customName, original: domOriginal })); } catch(_) {}
                    }
                }
            }
            captureOriginals();

            applyNames();
            bindAll();

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

    /**
     * 生成 Workspace 重命名注入脚本
     * 完整移植自 auto-accept.js buildWorkspaceRenamerScript() L597-778
     */
    private buildWorkspaceRenamerScript(): string {
        const nameMapJSON = JSON.stringify(this.workspaceNames);

        return `
        (() => {
            const nameMap = ${nameMapJSON};
            const RENAMER_MARKER = 'data-ws-renamer-bound';

            function findWorkspaceSection() {
                const allDivs = document.querySelectorAll('div');
                for (const d of allDivs) {
                    if (d.textContent.trim() === 'Workspaces' && d.classList.contains('text-xs')) {
                        return d.closest('.flex.flex-col.gap-3');
                    }
                }
                return null;
            }

            function findWorkspaceSpansWithKeys() {
                const section = findWorkspaceSection();
                if (!section) return [];
                const spans = section.querySelectorAll('span.text-sm.font-medium.truncate');
                const filtered = Array.from(spans).filter(s => {
                    const text = s.textContent.trim();
                    return text && text !== 'add';
                });

                const nameCount = {};
                const nameIndex = {};
                for (const span of filtered) {
                    const rawName = span.getAttribute('data-original-name')
                        || span.textContent.trim().replace(/^\\ud83d\\udcc2\\s*/, '');
                    nameCount[rawName] = (nameCount[rawName] || 0) + 1;
                }

                const result = [];
                for (const span of filtered) {
                    const rawName = span.getAttribute('data-original-name')
                        || span.textContent.trim().replace(/^\\ud83d\\udcc2\\s*/, '');
                    let key;
                    if (nameCount[rawName] > 1) {
                        nameIndex[rawName] = (nameIndex[rawName] || 0);
                        key = rawName + '#' + nameIndex[rawName];
                        nameIndex[rawName]++;
                    } else {
                        key = rawName;
                    }
                    span.setAttribute('data-ws-key', key);
                    result.push({ span, key, rawName });
                }
                return result;
            }

            function applyNames() {
                const items = findWorkspaceSpansWithKeys();
                for (const { span, key, rawName } of items) {
                    const entry = nameMap[key];
                    const customName = typeof entry === 'string' ? entry : entry?.name;
                    const displayName = customName ? '\\ud83d\\udcc2 ' + customName : null;
                    if (displayName && span.textContent !== displayName) {
                        if (!span.hasAttribute('data-original-name')) {
                            span.setAttribute('data-original-name', rawName);
                        }
                        span.textContent = '\\ud83d\\udcc2 ' + customName;
                        span.title = '原始: ' + rawName;
                    }
                }
            }

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
                    const editValue = currentText.replace(/^\\ud83d\\udcc2\\s*/, '');

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
                            span.textContent = '\\ud83d\\udcc2 ' + newName;
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

            function bindAll() {
                const items = findWorkspaceSpansWithKeys();
                for (const { span } of items) { bindDblClick(span); }
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
}
