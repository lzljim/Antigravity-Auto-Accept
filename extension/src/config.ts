import * as vscode from 'vscode';
import type { LogLevel } from './logger';

/**
 * 配置管理 — 读取 VS Code Settings（autoAccept.*）
 *
 * 自动监听配置变化并实时更新。
 */
export class Config implements vscode.Disposable {
    private disposable: vscode.Disposable;
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor() {
        this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('autoAccept')) {
                this._onDidChange.fire();
            }
        });
    }

    private get cfg(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('autoAccept');
    }

    get enabled(): boolean {
        return this.cfg.get<boolean>('enabled', true);
    }

    get acceptCodeEdits(): boolean {
        return this.cfg.get<boolean>('acceptCodeEdits', true);
    }

    get acceptTerminalCommands(): boolean {
        return this.cfg.get<boolean>('acceptTerminalCommands', true);
    }

    get acceptOtherActions(): boolean {
        return this.cfg.get<boolean>('acceptOtherActions', true);
    }

    get autoRetryEnabled(): boolean {
        return this.cfg.get<boolean>('autoRetry.enabled', false);
    }

    get modelFallback(): string[] {
        return this.cfg.get<string[]>('autoRetry.modelFallback', [
            'Claude Opus 4.6 (Thinking)',
            'Claude Sonnet 4.6 (Thinking)',
            'Gemini 3.1 Pro (High)',
        ]);
    }

    get maxRetries(): number {
        return this.cfg.get<number>('autoRetry.maxRetries', 3);
    }

    get monitorPollInterval(): number {
        return this.cfg.get<number>('monitorPollInterval', 3000);
    }

    get logLevel(): LogLevel {
        return this.cfg.get<LogLevel>('logLevel', 'info');
    }

    /** 切换 enabled 状态 */
    async toggle(): Promise<boolean> {
        const newValue = !this.enabled;
        await this.cfg.update('enabled', newValue, vscode.ConfigurationTarget.Global);
        return newValue;
    }

    dispose(): void {
        this._onDidChange.dispose();
        this.disposable.dispose();
    }
}
