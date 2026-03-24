import * as vscode from 'vscode';
import { EventBus, ClickEvent, RetryEvent } from './event-bus';

/**
 * WebView Dashboard — 侧边栏面板
 *
 * 订阅 EventBus 的事件并通过 postMessage 推送到 WebView，
 * 同时接收 WebView 发来的命令消息。
 *
 * 消息协议：
 *   Ext→WV: click, retry, status, fullState
 *   WV→Ext: toggle, showLog, resetCount
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'autoAccept.dashboard';
    private view?: vscode.WebviewView;
    private history: Array<ClickEvent | RetryEvent> = [];

    constructor(
        private extensionUri: vscode.Uri,
        private eventBus: EventBus,
    ) {
        eventBus.onClick((e) => this.pushAndPost('click', e));
        eventBus.onRetry((e) => this.pushAndPost('retry', e));
        eventBus.onStatus((e) => this.post('status', e));
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.getHtml();

        view.webview.onDidReceiveMessage((msg) => {
            if (msg.command) {
                vscode.commands.executeCommand(`autoAccept.${msg.command}`);
            }
        });

        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.post('fullState', { history: this.history });
            }
        });
    }

    private pushAndPost(type: string, event: any): void {
        this.history.push(event);
        if (this.history.length > 100) { this.history.shift(); }
        this.post(type, event);
    }

    private post(type: string, data: any): void {
        this.view?.webview.postMessage({ type, data });
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        padding: 12px;
    }
    .section { margin-bottom: 16px; }
    .section-title {
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-sideBarSectionHeader-foreground, #ccc);
        margin-bottom: 8px;
    }
    .stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
    }
    .stat-card {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border, #333);
        border-radius: 6px;
        padding: 10px 12px;
        text-align: center;
    }
    .stat-value {
        font-size: 24px;
        font-weight: 700;
        line-height: 1.2;
    }
    .stat-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 2px;
    }
    .stat-accept .stat-value { color: #4ec9b0; }
    .stat-retry .stat-value { color: #dcdcaa; }
    .status-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border, #333);
        border-radius: 6px;
        font-size: 12px;
    }
    .status-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #666;
    }
    .status-dot.connected { background: #4ec9b0; }
    .status-dot.disconnected { background: #f44747; }
    .controls {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 12px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
        transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .log {
        max-height: 200px;
        overflow-y: auto;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        line-height: 1.5;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border, #333);
        border-radius: 6px;
        padding: 8px;
    }
    .log-entry { padding: 1px 0; }
    .log-entry .time { color: var(--vscode-descriptionForeground); }
    .log-entry.click .action { color: #4ec9b0; }
    .log-entry.retry .action { color: #dcdcaa; }
</style>
</head>
<body>
    <div class="section">
        <div class="section-title">📊 Statistics</div>
        <div class="stats-grid">
            <div class="stat-card stat-accept">
                <div class="stat-value" id="acceptCount">0</div>
                <div class="stat-label">Accepted</div>
            </div>
            <div class="stat-card stat-retry">
                <div class="stat-value" id="retryCount">0</div>
                <div class="stat-label">Retried</div>
            </div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">🔗 Connection</div>
        <div class="status-bar">
            <span class="status-dot" id="statusDot"></span>
            <span id="statusText">Disconnected</span>
            <span style="margin-left:auto" id="targetCount">0 targets</span>
        </div>
    </div>

    <div class="section">
        <div class="section-title">⚙️ Controls</div>
        <div class="controls">
            <button class="btn btn-primary" onclick="send('toggle')">⏯️ Toggle On/Off</button>
            <button class="btn btn-secondary" onclick="send('showLog')">📋 Show Log</button>
            <button class="btn btn-secondary" onclick="send('resetCount')">🔁 Reset Count</button>
        </div>
    </div>

    <div class="section">
        <div class="section-title">📜 Recent Events</div>
        <div class="log" id="logContainer">
            <div style="color:var(--vscode-descriptionForeground)">Waiting for events...</div>
        </div>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    let acceptCount = 0;
    let retryCount = 0;

    function send(command) { vscode.postMessage({ command }); }

    function formatTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString('zh-CN', { hour12: false });
    }

    function addLogEntry(type, text, timestamp) {
        const log = document.getElementById('logContainer');
        if (log.children.length === 1 && log.children[0].tagName !== 'DIV') {
            // keep
        } else if (log.children[0]?.style?.color) {
            log.innerHTML = '';
        }
        const div = document.createElement('div');
        div.className = 'log-entry ' + type;
        div.innerHTML = '<span class="time">[' + formatTime(timestamp) + ']</span> <span class="action">' + text + '</span>';
        log.insertBefore(div, log.firstChild);
        if (log.children.length > 50) log.removeChild(log.lastChild);
    }

    window.addEventListener('message', (event) => {
        const { type, data } = event.data;

        switch (type) {
            case 'click':
                acceptCount++;
                document.getElementById('acceptCount').textContent = acceptCount;
                addLogEntry('click', '✅ ' + data.button + ' (' + data.target + ')', data.timestamp);
                break;
            case 'retry':
                retryCount++;
                document.getElementById('retryCount').textContent = retryCount;
                addLogEntry('retry', '🔄 Retry ' + (data.success ? '✅' : '❌') + ' (HTTP ' + (data.errorCode || '?') + ')', data.timestamp);
                break;
            case 'status':
                const dot = document.getElementById('statusDot');
                const text = document.getElementById('statusText');
                const count = document.getElementById('targetCount');
                dot.className = 'status-dot ' + (data.connected ? 'connected' : 'disconnected');
                text.textContent = data.connected ? 'Connected' : 'Disconnected';
                count.textContent = data.targetCount + ' targets';
                break;
            case 'fullState':
                acceptCount = 0; retryCount = 0;
                if (data.history) {
                    for (const e of data.history) {
                        if ('button' in e) acceptCount++;
                        else retryCount++;
                    }
                }
                document.getElementById('acceptCount').textContent = acceptCount;
                document.getElementById('retryCount').textContent = retryCount;
                break;
        }
    });
</script>
</body>
</html>`;
    }
}
