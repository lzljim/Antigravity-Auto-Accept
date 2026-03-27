import * as vscode from 'vscode';
import { Config } from './config';

/**
 * 状态栏管理器
 *
 * 在 IDE 底部状态栏显示 Auto Accept 的运行状态和统计信息。
 */
export class StatusBarManager implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private _acceptCount = 0;
    private _retryCount = 0;
    private _connected = false;
    private _error: string | undefined = undefined;
    private _nightMode: string = 'off';
    private _pipelineStats: { queued: number; running: number; done: number } = { queued: 0, running: 0, done: 0 };
    private _pipelineMode: string = 'off';
    private config: Config;

    constructor(config: Config) {
        this.config = config;
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        this.item.command = 'autoAccept.openDashboard';
        this.update();
        this.item.show();
    }

    get acceptCount(): number {
        return this._acceptCount;
    }

    get retryCount(): number {
        return this._retryCount;
    }

    incrementCount(): void {
        this._acceptCount++;
        this.update();
    }

    incrementRetry(): void {
        this._retryCount++;
        this.update();
    }

    setConnected(connected: boolean): void {
        this._connected = connected;
        this._error = undefined;
        this.update();
    }

    setError(msg?: string): void {
        this._error = msg ?? '未知错误';
        this._connected = false;
        this.update();
    }

    setNightMode(mode: string): void {
        this._nightMode = mode;
        this.update();
    }

    setPipelineStats(stats: { queued: number; running: number; done: number }, mode: string): void {
        this._pipelineStats = stats;
        this._pipelineMode = mode;
        this.update();
    }

    resetCounts(): void {
        this._acceptCount = 0;
        this._retryCount = 0;
        this.update();
    }

    private update(): void {
        const enabled = this.config.enabled;
        const nightSuffix = this._nightMode !== 'off' ? ' 🌙' : '';
        const pipelineActive = this._pipelineMode !== 'off';

        if (!enabled) {
            this.item.text = '$(circle-slash) Auto Accept: OFF';
            this.item.tooltip = '点击打开 Dashboard\n切换开关: Ctrl+Shift+A';
            this.item.backgroundColor = undefined;
        } else if (this._error) {
            this.item.text = '$(error) Auto Accept: ERR';
            this.item.tooltip = `❌ 错误: ${this._error}\n\n点击打开 Dashboard`;
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (!this._connected) {
            this.item.text = '$(loading~spin) Auto Accept';
            this.item.tooltip = '正在连接 Antigravity SDK...';
            this.item.backgroundColor = undefined;
        } else if (pipelineActive) {
            const { queued, running, done } = this._pipelineStats;
            const pIcon = this._pipelineMode === 'paused' ? '$(debug-pause)' : '$(play)';
            this.item.text = `${pIcon} Pipeline: Q${queued} R${running} D${done}`;
            this.item.tooltip = [
                `🏭 Pipeline: ${this._pipelineMode}`,
                `📋 排队: ${queued}`,
                `🔄 进行: ${running}`,
                `✅ 完成: ${done}`,
                '',
                `✅ Auto Accept: ${this._acceptCount}`,
                `🔄 Retried: ${this._retryCount}`,
                this._nightMode !== 'off' ? `🌙 夜间模式: ${this._nightMode}` : '',
                '',
                '点击打开 Dashboard',
            ].filter(Boolean).join('\n');
            this.item.backgroundColor = undefined;
        } else {
            this.item.text = `$(check) Auto Accept: ${this._acceptCount}${nightSuffix}`;
            this.item.tooltip = [
                `✅ 已接受: ${this._acceptCount}`,
                `🔄 已重试: ${this._retryCount}`,
                `📡 模式: SDK信号 + CDP执行`,
                this._nightMode !== 'off' ? `🌙 夜间模式: ${this._nightMode}` : '',
                '',
                '点击打开 Dashboard | 切换开关: Ctrl+Shift+A',
            ].filter(Boolean).join('\n');
            this.item.backgroundColor = undefined;
        }
    }

    dispose(): void {
        this.item.dispose();
    }
}
