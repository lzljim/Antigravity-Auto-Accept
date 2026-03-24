import { EventEmitter } from 'events';

// ── 事件类型定义 ──

export interface ClickEvent {
    button: string;
    target: string;
    timestamp: number;
}

export interface RetryEvent {
    errorCode: number | null;
    model: string;
    success: boolean;
    timestamp: number;
}

export interface StatusEvent {
    connected: boolean;
    targetCount: number;
    timestamp: number;
}

/**
 * 事件总线 — 解耦核心层与 UI 层
 *
 * 核心模块（CDPTargetManager / CDPSmartRetry）通过 emit 发布事件，
 * UI 模块（DashboardViewProvider / StatusBarManager）通过 on 订阅事件。
 */
export class EventBus extends EventEmitter {
    emitClick(e: ClickEvent): void { this.emit('click', e); }
    emitRetry(e: RetryEvent): void { this.emit('retry', e); }
    emitStatus(e: StatusEvent): void { this.emit('status', e); }

    onClick(fn: (e: ClickEvent) => void): void { this.on('click', fn); }
    onRetry(fn: (e: RetryEvent) => void): void { this.on('retry', fn); }
    onStatus(fn: (e: StatusEvent) => void): void { this.on('status', fn); }
}
