import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'silent';

/**
 * 日志管理器 — 封装 VS Code OutputChannel
 *
 * 支持 debug / info / error 三级日志，时间戳格式与原脚本一致。
 */
export class Logger implements vscode.Disposable {
    private channel: vscode.OutputChannel;
    private _logLevel: LogLevel = 'info';

    constructor() {
        this.channel = vscode.window.createOutputChannel('Auto Accept');
    }

    get logLevel(): LogLevel {
        return this._logLevel;
    }

    set logLevel(level: LogLevel) {
        this._logLevel = level;
    }

    private timestamp(): string {
        return new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }

    debug(msg: string): void {
        if (this._logLevel === 'debug') {
            this.channel.appendLine(`[${this.timestamp()}] [DEBUG] ${msg}`);
        }
    }

    info(msg: string): void {
        if (this._logLevel !== 'silent') {
            this.channel.appendLine(`[${this.timestamp()}] ${msg}`);
        }
    }

    error(msg: string): void {
        this.channel.appendLine(`[${this.timestamp()}] [ERROR] ${msg}`);
    }

    /** 显示 Output 面板并聚焦到此频道 */
    show(): void {
        this.channel.show(true);
    }

    dispose(): void {
        this.channel.dispose();
    }
}
