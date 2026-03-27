import * as vscode from 'vscode';
import {
    EventBus,
    type ClickEvent,
    type RetryEvent,
    type PipelineStateEvent,
    type TaskNotifyEvent,
} from './event-bus';

/**
 * WebView Dashboard — 侧边栏面板
 *
 * 全新 Pipeline 视图：
 *   - 快速输入框
 *   - Pipeline 统计总览
 *   - 按 Workspace 分组的会话/任务状态
 *   - 事件日志
 *   - 控制面板
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
        eventBus.onNightMode((e) => this.post('nightMode', e));
        eventBus.onDispatch((e) => this.post('dispatch', e));
        eventBus.onQuota((e) => this.post('quota', e));
        eventBus.onPipelineState((e) => this.post('pipelineState', e));
        eventBus.onTaskNotify((e) => this.post('taskNotify', e));
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.getHtml();

        view.webview.onDidReceiveMessage((msg) => {
            if (msg.command) {
                if (msg.command === 'pipeline.addTask') {
                    vscode.commands.executeCommand('autoAccept.pipeline.addTask', msg.title, msg.workspace);
                } else if (msg.command === 'pipeline.addAndDecompose') {
                    vscode.commands.executeCommand('autoAccept.pipeline.addAndDecompose', msg.title, msg.workspace);
                } else {
                    vscode.commands.executeCommand(`autoAccept.${msg.command}`);
                }
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
        display: flex;
        align-items: center;
        gap: 6px;
    }

    /* Quick Input */
    .quick-input-wrap {
        margin-bottom: 12px;
    }
    .quick-input-row {
        display: flex;
        gap: 6px;
        margin-bottom: 4px;
    }
    .quick-input-row input {
        flex: 1;
        padding: 6px 10px;
        border: 1px solid var(--vscode-input-border, #3c3c3c);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: 4px;
        font-size: 12px;
        font-family: inherit;
        outline: none;
    }
    .quick-input-row input:focus {
        border-color: var(--vscode-focusBorder);
    }
    .quick-input-row input::placeholder {
        color: var(--vscode-input-placeholderForeground);
    }
    .quick-input-meta {
        display: flex;
        gap: 6px;
        align-items: center;
    }
    .quick-input-meta select {
        flex: 1;
        padding: 3px 6px;
        border: 1px solid var(--vscode-input-border, #3c3c3c);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: 4px;
        font-size: 11px;
        font-family: inherit;
        outline: none;
    }
    .quick-input-meta select:focus {
        border-color: var(--vscode-focusBorder);
    }
    .quick-input-hint {
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
    }

    /* Stats Grid */
    .stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 6px;
    }
    .stat-card {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border, #333);
        border-radius: 6px;
        padding: 8px 6px;
        text-align: center;
    }
    .stat-value {
        font-size: 20px;
        font-weight: 700;
        line-height: 1.2;
    }
    .stat-label {
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        margin-top: 2px;
    }
    .stat-queued .stat-value { color: #569cd6; }
    .stat-running .stat-value { color: #dcdcaa; }
    .stat-done .stat-value { color: #4ec9b0; }
    .stat-blocked .stat-value { color: #f44747; }

    /* Workspace Group */
    .ws-group {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border, #333);
        border-radius: 6px;
        margin-bottom: 8px;
        overflow: hidden;
    }
    .ws-header {
        padding: 8px 10px;
        font-size: 12px;
        font-weight: 600;
        background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.04));
        border-bottom: 1px solid var(--vscode-panel-border, #333);
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .ws-header .branch {
        font-weight: 400;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .ws-header .queue-badge {
        margin-left: auto;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 8px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
    }
    .ws-sessions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        padding: 8px;
    }
    .session-card {
        border: 1px solid var(--vscode-panel-border, #333);
        border-radius: 4px;
        padding: 8px;
        font-size: 11px;
    }
    .session-status {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 4px;
    }
    .session-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
    }
    .session-dot.idle { background: #4ec9b0; }
    .session-dot.busy { background: #dcdcaa; }
    .session-dot.error { background: #f44747; }
    .session-task {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .model-badge {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 6px;
        font-weight: 600;
        margin-left: auto;
        white-space: nowrap;
    }
    .model-badge.opus { background: #c586c0; color: #fff; }
    .model-badge.sonnet { background: #569cd6; color: #fff; }
    .model-badge.gemini { background: #4ec9b0; color: #000; }
    .model-badge.unknown { background: #666; color: #fff; }

    /* Connection + controls */
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
        display: flex; align-items: center; justify-content: center;
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
    .btn-row {
        display: flex;
        gap: 6px;
    }
    .btn-row .btn { flex: 1; }

    /* Log */
    .log {
        max-height: 180px;
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
    .log-entry.dispatch .action { color: #569cd6; }
    .log-entry.notify .action { color: #ce9178; }

    .empty-hint {
        text-align: center;
        padding: 16px 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
    }

    .pipeline-badge {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 8px;
        font-weight: 600;
    }
    .pipeline-badge.running { background: #4ec9b0; color: #000; }
    .pipeline-badge.paused { background: #dcdcaa; color: #000; }
    .pipeline-badge.off { background: #666; color: #fff; }
</style>
</head>
<body>
    <!-- Quick Input -->
    <div class="section">
        <div class="quick-input-wrap">
            <div class="quick-input-row">
                <input type="text" id="taskInput" placeholder="输入任务描述，Enter AI拆解" />
            </div>
            <div class="quick-input-meta">
                <select id="wsSelect">
                    <option value="">📂 无工作空间</option>
                </select>
                <span class="quick-input-hint">Enter=拆解 Shift=添加</span>
            </div>
        </div>
    </div>

    <!-- Pipeline Stats -->
    <div class="section">
        <div class="section-title">
            🏭 Pipeline
            <span class="pipeline-badge off" id="pipelineBadge">OFF</span>
        </div>
        <div class="stats-grid">
            <div class="stat-card stat-queued">
                <div class="stat-value" id="statQueued">0</div>
                <div class="stat-label">排队</div>
            </div>
            <div class="stat-card stat-running">
                <div class="stat-value" id="statRunning">0</div>
                <div class="stat-label">进行</div>
            </div>
            <div class="stat-card stat-done">
                <div class="stat-value" id="statDone">0</div>
                <div class="stat-label">完成</div>
            </div>
            <div class="stat-card stat-blocked">
                <div class="stat-value" id="statBlocked">0</div>
                <div class="stat-label">阻塞</div>
            </div>
        </div>
    </div>

    <!-- Workspaces -->
    <div class="section" id="workspacesSection">
        <div class="section-title">📂 Workspaces</div>
        <div id="workspacesContainer">
            <div class="empty-hint">未配置工作空间<br/>在 Settings 中设置 autoAccept.pipeline.workspaces</div>
        </div>
    </div>

    <!-- Connection -->
    <div class="section">
        <div class="section-title">🔗 Connection</div>
        <div class="status-bar">
            <span class="status-dot" id="statusDot"></span>
            <span id="statusText">Disconnected</span>
            <span style="margin-left:auto" id="targetCount">0 targets</span>
        </div>
    </div>

    <!-- Auto Accept Stats -->
    <div class="section">
        <div class="section-title">📊 Auto Accept</div>
        <div class="stats-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="stat-card">
                <div class="stat-value" style="color:#4ec9b0" id="acceptCount">0</div>
                <div class="stat-label">Accepted</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color:#dcdcaa" id="retryCount">0</div>
                <div class="stat-label">Retried</div>
            </div>
        </div>
    </div>

    <!-- Controls -->
    <div class="section">
        <div class="section-title">⚙️ Controls</div>
        <div class="controls">
            <div class="btn-row">
                <button class="btn btn-primary" onclick="send('pipeline.toggle')">🏭 Pipeline</button>
                <button class="btn btn-primary" onclick="send('toggle')">⏯️ Auto Accept</button>
            </div>
            <div class="btn-row">
                <button class="btn btn-secondary" onclick="send('showLog')">📋 Log</button>
                <button class="btn btn-secondary" onclick="send('resetCount')">🔁 Reset</button>
            </div>
        </div>
    </div>

    <!-- Events -->
    <div class="section">
        <div class="section-title">📜 Events</div>
        <div class="log" id="logContainer">
            <div style="color:var(--vscode-descriptionForeground)">Waiting for events...</div>
        </div>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    let acceptCount = 0;
    let retryCount = 0;

    function send(command, data) {
        vscode.postMessage({ command, ...data });
    }

    // Quick input
    document.getElementById('taskInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const input = e.target;
            const title = input.value.trim();
            if (!title) return;
            const ws = document.getElementById('wsSelect').value || undefined;

            if (e.shiftKey) {
                // Shift+Enter = simple add (no decompose)
                vscode.postMessage({
                    command: 'pipeline.addTask',
                    title: title,
                    workspace: ws,
                });
                input.value = '';
                addLogEntry('dispatch', '➕ 已添加: ' + title + (ws ? ' (' + ws + ')' : ''), Date.now());
            } else {
                // Enter = add & decompose
                vscode.postMessage({
                    command: 'pipeline.addAndDecompose',
                    title: title,
                    workspace: ws,
                });
                input.value = '';
                addLogEntry('dispatch', '🔬 拆解请求: ' + title + (ws ? ' (' + ws + ')' : ''), Date.now());
            }
        }
    });

    /** 根据 pipeline state 更新 workspace 下拉框 */
    function updateWsSelect(workspaces) {
        const select = document.getElementById('wsSelect');
        const currentVal = select.value;
        // 保留第一个“无工作空间”选项
        select.innerHTML = '<option value="">📂 无工作空间</option>';
        if (workspaces && workspaces.length > 0) {
            for (const ws of workspaces) {
                const opt = document.createElement('option');
                opt.value = ws.name;
                opt.textContent = '📂 ' + ws.name + (ws.branch ? ' (' + ws.branch + ')' : '');
                select.appendChild(opt);
            }
        }
        // 恢复之前的选中值
        if (currentVal) {
            select.value = currentVal;
        }
    }

    function formatTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString('zh-CN', { hour12: false });
    }

    function addLogEntry(type, text, timestamp) {
        const log = document.getElementById('logContainer');
        if (log.children[0]?.style?.color) {
            log.innerHTML = '';
        }
        const div = document.createElement('div');
        div.className = 'log-entry ' + type;
        div.innerHTML = '<span class="time">[' + formatTime(timestamp) + ']</span> <span class="action">' + text + '</span>';
        log.insertBefore(div, log.firstChild);
        if (log.children.length > 50) log.removeChild(log.lastChild);
    }

    function renderWorkspaces(workspaces) {
        const container = document.getElementById('workspacesContainer');
        if (!workspaces || workspaces.length === 0) {
            container.innerHTML = '<div class="empty-hint">未配置工作空间<br/>在 Settings 中设置 autoAccept.pipeline.workspaces</div>';
            return;
        }

        container.innerHTML = workspaces.map(ws => {
            const sessionsHtml = ws.sessions.length > 0
                ? ws.sessions.map(s => {
                    const dotClass = s.status || 'idle';
                    const taskText = s.taskTitle
                        ? s.taskTitle
                        : (s.status === 'idle' ? 'Idle' : s.status);
                    const modelClass = s.model
                        ? (s.model.toLowerCase().includes('opus') ? 'opus'
                            : s.model.toLowerCase().includes('sonnet') ? 'sonnet'
                            : s.model.toLowerCase().includes('gemini') ? 'gemini' : 'unknown')
                        : '';
                    const modelBadge = s.model
                        ? '<span class="model-badge ' + modelClass + '">' + s.model + '</span>'
                        : '';
                    return '<div class="session-card">' +
                        '<div class="session-status">' +
                        '<span class="session-dot ' + dotClass + '"></span>' +
                        '<span>Session</span>' +
                        modelBadge +
                        '</div>' +
                        '<div class="session-task">' + taskText + '</div>' +
                        '</div>';
                }).join('')
                : '<div class="empty-hint" style="padding:8px">等待 CDP 连接...</div>';

            return '<div class="ws-group">' +
                '<div class="ws-header">' +
                '📂 ' + ws.name +
                (ws.branch ? ' <span class="branch">(' + ws.branch + ')</span>' : '') +
                '<span class="queue-badge">' + (ws.queueCount || 0) + ' queued</span>' +
                '</div>' +
                '<div class="ws-sessions">' + sessionsHtml + '</div>' +
                '</div>';
        }).join('');
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

            case 'status': {
                const dot = document.getElementById('statusDot');
                const txt = document.getElementById('statusText');
                const cnt = document.getElementById('targetCount');
                dot.className = 'status-dot ' + (data.connected ? 'connected' : 'disconnected');
                txt.textContent = data.connected ? 'Connected' : 'Disconnected';
                cnt.textContent = data.targetCount + ' targets';
                break;
            }

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

            case 'pipelineState': {
                // Update badge
                const badge = document.getElementById('pipelineBadge');
                const modeLabels = { off: 'OFF', running: 'RUNNING', paused: 'PAUSED' };
                badge.textContent = modeLabels[data.mode] || data.mode;
                badge.className = 'pipeline-badge ' + (data.mode || 'off');

                // Update stats
                if (data.stats) {
                    document.getElementById('statQueued').textContent = data.stats.queued || 0;
                    document.getElementById('statRunning').textContent = data.stats.running || 0;
                    document.getElementById('statDone').textContent = data.stats.done || 0;
                    document.getElementById('statBlocked').textContent = data.stats.blocked || 0;
                }

                // Update workspaces
                if (data.workspaces) {
                    renderWorkspaces(data.workspaces);
                    updateWsSelect(data.workspaces);
                }
                break;
            }

            case 'taskNotify': {
                const icons = { completed: '✅', failed: '❌', blocked: '⏰', dispatched: '🚀' };
                const icon = icons[data.type] || '📋';
                const suffix = data.workspace ? ' (' + data.workspace + ')' : '';
                addLogEntry('notify', icon + ' ' + data.taskTitle + suffix, data.timestamp);
                break;
            }

            case 'dispatch':
                addLogEntry('dispatch', '🚀 ' + data.taskTitle, data.timestamp);
                break;

            case 'quota': {
                if (data.type === 'exhausted') {
                    addLogEntry('retry', '⚠️ Quota exhausted', data.timestamp);
                } else if (data.type === 'refreshed') {
                    addLogEntry('click', '🔋 Quota refreshed', data.timestamp);
                }
                break;
            }

            case 'nightMode': // backward compat
                break;
        }
    });
</script>
</body>
</html>`;
    }
}
