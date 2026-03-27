import { Logger } from './logger';
import { Config } from './config';
import { CDPTargetManager } from './cdp-target-manager';
import type { WorkspaceSessionState } from './event-bus';

/**
 * Workspace 配置
 */
export interface WorkspaceConfig {
    name: string;
    branch: string;
    pathPattern: string;
    sessions: number;
    preferredModels: string[];
}

/**
 * Workspace 会话池
 */
export interface WorkspacePool {
    config: WorkspaceConfig;
    /** targetId → session state */
    sessions: Map<string, WorkspaceSessionState>;
}

/**
 * 任务信息（用于 workspace 路由）
 */
interface TaskInfo {
    workspace?: string;
    [key: string]: any;
}

/**
 * WorkspaceRouter — 将 CDP target 映射到正确的 Workspace
 *
 * 通过 CDP target title（包含工作区文件夹路径）自动匹配 workspace。
 * 每个 workspace 维护独立的会话池，严格隔离时任务只能派发到匹配的池。
 *
 * 匹配策略（优先级从高到低）：
 *   1. pathPattern 匹配 target title
 *   2. workspace name 匹配 target title（子串匹配）
 *   3. branch name 匹配 target title
 */
export class WorkspaceRouter {
    private pools = new Map<string, WorkspacePool>();

    constructor(
        private config: Config,
        private cdpManager: CDPTargetManager,
        private logger: Logger,
    ) {
        this.rebuildPools();
    }

    /**
     * 重建 workspace 池（配置变更时调用）
     */
    rebuildPools(): void {
        const workspaces = this.config.pipelineWorkspaces;
        const defaultSessions = this.config.sessionsPerWorkspace;

        // 保留已有 session 映射
        const oldPools = new Map(this.pools);
        this.pools.clear();

        for (const ws of workspaces) {
            const wsCfg: WorkspaceConfig = {
                name: ws.name,
                branch: ws.branch || '',
                pathPattern: ws.pathPattern || '',
                sessions: ws.sessions || defaultSessions,
                preferredModels: ws.preferredModels || [],
            };

            const oldPool = oldPools.get(ws.name);
            this.pools.set(ws.name, {
                config: wsCfg,
                sessions: oldPool?.sessions || new Map(),
            });
        }

        this.logger.info(`🗂 WorkspaceRouter: 已配置 ${this.pools.size} 个工作空间`);
        for (const [name, pool] of this.pools) {
            this.logger.debug(`  - ${name} (branch: ${pool.config.branch}, sessions: ${pool.config.sessions})`);
        }
    }

    /**
     * 同步 CDP targets 到 workspace 池
     * 扫描当前已连接的 targets，根据 title 自动分配到 workspace
     */
    syncTargets(): void {
        const targets = this.cdpManager.getConnectedTargets();

        // 清除不再存在的 target
        for (const pool of this.pools.values()) {
            for (const targetId of pool.sessions.keys()) {
                if (!targets.find(t => t.targetId === targetId)) {
                    pool.sessions.delete(targetId);
                }
            }
        }

        // 分配新 target
        for (const { targetId, info } of targets) {
            // 跳过 Manager target 和 vscode webview target
            if (info.title === 'Manager') continue;
            const url = info.url || '';
            if (url.startsWith('vscode-webview://')) continue;

            // 检查是否已分配
            let alreadyAssigned = false;
            for (const pool of this.pools.values()) {
                if (pool.sessions.has(targetId)) {
                    alreadyAssigned = true;
                    break;
                }
            }
            if (alreadyAssigned) continue;

            // 尝试匹配 workspace
            const wsName = this.resolveWorkspace(targetId, info.title || '');
            if (wsName) {
                const pool = this.pools.get(wsName);
                if (pool && pool.sessions.size < pool.config.sessions) {
                    pool.sessions.set(targetId, {
                        targetId,
                        targetTitle: info.title || 'unknown',
                        workspace: wsName,
                        status: 'idle',
                    });
                    this.logger.info(`📌 Target "${info.title}" → workspace "${wsName}"`);
                }
            }
        }
    }

    /**
     * 解析 target 所属的 workspace
     */
    resolveWorkspace(targetId: string, targetTitle: string): string | null {
        const titleLower = targetTitle.toLowerCase();

        // 跳过 vscode webview 目标（如扩展自己的 Dashboard）
        if (titleLower.includes('vscode-webview://') || titleLower.includes('extensionid=')) {
            return null;
        }

        for (const [name, pool] of this.pools) {
            const cfg = pool.config;

            // 1. pathPattern 匹配
            if (cfg.pathPattern) {
                const pattern = cfg.pathPattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
                try {
                    if (new RegExp(pattern, 'i').test(targetTitle)) {
                        return name;
                    }
                } catch (_) { /* invalid regex, skip */ }
            }

            // 2. workspace name 子串匹配
            if (name && titleLower.includes(name.toLowerCase())) {
                return name;
            }

            // 3. branch name 匹配
            if (cfg.branch && titleLower.includes(cfg.branch.toLowerCase())) {
                return name;
            }
        }

        return null;
    }

    /**
     * 获取可派发任务的空闲 session（带 workspace 约束）
     */
    getIdleSessionForTask(task: TaskInfo): { targetId: string; workspace: string } | null {
        const strict = this.config.workspaceIsolation === 'strict';

        if (task.workspace) {
            // 有 workspace 标记的任务：只在对应 pool 找
            const pool = this.pools.get(task.workspace);
            if (!pool) return null;

            for (const [targetId, session] of pool.sessions) {
                if (session.status === 'idle') {
                    return { targetId, workspace: task.workspace };
                }
            }
            return null;
        }

        if (strict) {
            // 严格模式下，无 workspace 标记的任务不派发
            this.logger.debug('WorkspaceRouter: 严格模式下无 workspace 标记的任务被跳过');
            return null;
        }

        // flexible 模式：任意空闲 session
        for (const [wsName, pool] of this.pools) {
            for (const [targetId, session] of pool.sessions) {
                if (session.status === 'idle') {
                    return { targetId, workspace: wsName };
                }
            }
        }

        return null;
    }

    /**
     * 标记 session 状态
     */
    setSessionStatus(
        targetId: string,
        status: 'idle' | 'busy' | 'error',
        taskId?: string,
        taskTitle?: string,
        model?: string,
    ): void {
        for (const pool of this.pools.values()) {
            const session = pool.sessions.get(targetId);
            if (session) {
                session.status = status;
                session.taskId = taskId;
                session.taskTitle = taskTitle;
                if (model !== undefined) {
                    session.model = model;
                } else if (status === 'idle') {
                    session.model = undefined;
                }
                return;
            }
        }
    }

    /**
     * 获取所有 workspace 的状态快照（用于 Dashboard 渲染）
     */
    getStateSnapshot(): Array<{
        name: string;
        branch: string;
        sessions: WorkspaceSessionState[];
        queueCount: number;
    }> {
        const result = [];
        for (const [name, pool] of this.pools) {
            result.push({
                name,
                branch: pool.config.branch,
                sessions: Array.from(pool.sessions.values()),
                queueCount: 0, // 由 PipelineScheduler 填充
            });
        }
        return result;
    }

    /**
     * 获取指定 workspace 的配置
     */
    getWorkspaceConfig(name: string): WorkspaceConfig | undefined {
        return this.pools.get(name)?.config;
    }

    /**
     * 所有已注册的 workspace 名称
     */
    getWorkspaceNames(): string[] {
        return Array.from(this.pools.keys());
    }

    /**
     * 获取所有 workspace 池
     */
    getPools(): Map<string, WorkspacePool> {
        return this.pools;
    }
}
