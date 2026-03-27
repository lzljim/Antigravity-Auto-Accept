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

// ── 夜间模式事件类型 ──

export type NightMode = 'off' | 'standby' | 'active' | 'paused';

export interface IdleEvent {
    targetId: string;
    targetTitle: string;
    idleDurationMs: number;
    timestamp: number;
}

export interface DispatchEvent {
    targetId: string;
    taskId: string;
    taskTitle: string;
    promptLength: number;
    timestamp: number;
}

export interface TaskCompleteEvent {
    targetId: string;
    taskId: string;
    taskTitle: string;
    durationMs: number;
    success: boolean;
    timestamp: number;
}

export interface NightModeEvent {
    mode: NightMode;
    reason: string;
    timestamp: number;
}

export interface QuotaEvent {
    type: 'exhausted' | 'refreshed' | 'warning';
    windowStart: number;
    estimatedUsage: number;
    timestamp: number;
}

// ── Pipeline 事件类型 ──

export type PipelineMode = 'off' | 'running' | 'paused';

export interface WorkspaceSessionState {
    targetId: string;
    targetTitle: string;
    workspace: string;
    taskId?: string;
    taskTitle?: string;
    model?: string;
    status: 'idle' | 'busy' | 'error';
}

export interface PipelineStateEvent {
    mode: PipelineMode;
    workspaces: Array<{
        name: string;
        branch: string;
        sessions: WorkspaceSessionState[];
        queueCount: number;
    }>;
    stats: { queued: number; running: number; done: number; blocked: number };
    timestamp: number;
}

export interface TaskNotifyEvent {
    type: 'completed' | 'failed' | 'blocked' | 'dispatched';
    taskId: string;
    taskTitle: string;
    workspace: string;
    durationMs?: number;
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

    // ── 夜间模式事件 ──
    emitIdle(e: IdleEvent): void { this.emit('idle', e); }
    emitDispatch(e: DispatchEvent): void { this.emit('dispatch', e); }
    emitTaskComplete(e: TaskCompleteEvent): void { this.emit('taskComplete', e); }
    emitNightMode(e: NightModeEvent): void { this.emit('nightMode', e); }
    emitQuota(e: QuotaEvent): void { this.emit('quota', e); }

    onIdle(fn: (e: IdleEvent) => void): void { this.on('idle', fn); }
    onDispatch(fn: (e: DispatchEvent) => void): void { this.on('dispatch', fn); }
    onTaskComplete(fn: (e: TaskCompleteEvent) => void): void { this.on('taskComplete', fn); }
    onNightMode(fn: (e: NightModeEvent) => void): void { this.on('nightMode', fn); }
    onQuota(fn: (e: QuotaEvent) => void): void { this.on('quota', fn); }

    // ── Pipeline 事件 ──
    emitPipelineState(e: PipelineStateEvent): void { this.emit('pipelineState', e); }
    emitTaskNotify(e: TaskNotifyEvent): void { this.emit('taskNotify', e); }

    onPipelineState(fn: (e: PipelineStateEvent) => void): void { this.on('pipelineState', fn); }
    onTaskNotify(fn: (e: TaskNotifyEvent) => void): void { this.on('taskNotify', fn); }
}
