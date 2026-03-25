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

    get cdpPort(): number {
        return this.cfg.get<number>('cdpPort', 9222);
    }

    get buttonTexts(): string[] {
        return this.cfg.get<string[]>('buttonTexts', [
            'Run',
            'Allow This Conversation',
            'Always Allow',
            'Allow Once',
            'Accept all',
            'Accept',
        ]);
    }

    get retryButtonTexts(): string[] {
        return this.cfg.get<string[]>('autoRetry.retryButtonTexts', ['Retry']);
    }

    get monitorPollInterval(): number {
        return this.cfg.get<number>('monitorPollInterval', 3000);
    }

    get logLevel(): LogLevel {
        return this.cfg.get<LogLevel>('logLevel', 'info');
    }

    // ── 夜间模式配置 ──

    get nightModeEnabled(): boolean {
        return this.cfg.get<boolean>('nightMode.enabled', false);
    }

    get autoActivateHour(): number {
        return this.cfg.get<number>('nightMode.autoActivateHour', 23);
    }

    get autoDeactivateHour(): number {
        return this.cfg.get<number>('nightMode.autoDeactivateHour', 9);
    }

    get maxTaskDurationMinutes(): number {
        return this.cfg.get<number>('nightMode.maxTaskDurationMinutes', 120);
    }

    get nightSafeOnly(): boolean {
        return this.cfg.get<boolean>('nightMode.nightSafeOnly', true);
    }

    get idleThresholdSeconds(): number {
        return this.cfg.get<number>('nightMode.idleThresholdSeconds', 60);
    }

    get quotaWindowHours(): number {
        return this.cfg.get<number>('nightMode.quotaWindowHours', 5);
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
