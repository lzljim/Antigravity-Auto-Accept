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
    private config: Config;

    constructor(config: Config) {
        this.config = config;
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        this.item.command = 'autoAccept.toggle';
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

    resetCounts(): void {
        this._acceptCount = 0;
        this._retryCount = 0;
        this.update();
    }

    private update(): void {
        const enabled = this.config.enabled;

        if (!enabled) {
            this.item.text = '$(circle-slash) Auto Accept: OFF';
            this.item.tooltip = '点击开启自动接受（Ctrl+Shift+A）';
            this.item.backgroundColor = undefined;
        } else if (this._error) {
            this.item.text = '$(error) Auto Accept: ERR';
            this.item.tooltip = `❌ 错误: ${this._error}\n\n点击切换开关`;
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (!this._connected) {
            this.item.text = '$(loading~spin) Auto Accept';
            this.item.tooltip = '正在连接 Antigravity SDK...';
            this.item.backgroundColor = undefined;
        } else {
            this.item.text = `$(check) Auto Accept: ${this._acceptCount}`;
            this.item.tooltip = [
                `✅ 已接受: ${this._acceptCount}`,
                `🔄 已重试: ${this._retryCount}`,
                '',
                '点击切换开关（Ctrl+Shift+A）',
            ].join('\n');
            this.item.backgroundColor = undefined;
        }
    }

    dispose(): void {
        this.item.dispose();
    }
}
