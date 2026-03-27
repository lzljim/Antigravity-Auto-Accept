import { Logger } from './logger';
import { CDPTargetManager } from './cdp-target-manager';
import { buildSwitchModelScript } from './cdp-scripts';

/**
 * 模型切换结果
 */
export interface ModelSwitchResult {
    success: boolean;
    model?: string;
    error?: string;
}

/**
 * ModelSwitcher — 通过 CDP 切换 Antigravity 会话的 AI 模型
 *
 * 封装 `buildSwitchModelScript`，注入到目标会话并执行模型切换。
 * 切换失败时返回 `false`（允许调用方继续派发，不强制中止）。
 */
export class ModelSwitcher {
    /** 模型切换超时（ms） */
    private static readonly SWITCH_TIMEOUT_MS = 5000;

    constructor(
        private cdpManager: CDPTargetManager,
        private logger: Logger,
    ) {}

    /**
     * 切换指定 target 的 AI 模型
     *
     * @param targetId      CDP target ID
     * @param modelName     目标模型名称（如 "Claude Opus 4.6 (Thinking)"）
     * @returns             切换结果
     */
    async switchModel(targetId: string, modelName: string): Promise<ModelSwitchResult> {
        const conn = this.cdpManager.getConnection(targetId);
        if (!conn?.ready) {
            this.logger.debug(`ModelSwitcher: target ${targetId} 无可用连接`);
            return { success: false, error: 'target not connected' };
        }

        const script = buildSwitchModelScript(modelName);

        try {
            const result: any = await this.withTimeout(
                conn.client.Runtime.evaluate({
                    expression: script,
                    returnByValue: true,
                    awaitPromise: true,
                }),
                ModelSwitcher.SWITCH_TIMEOUT_MS,
            );

            const value = result?.result?.value;
            if (!value) {
                this.logger.debug(`ModelSwitcher: 未获取返回值`);
                return { success: false, error: 'no return value' };
            }

            if (value.success) {
                this.logger.info(`🔀 模型已切换: ${value.model} (target: ${targetId.substring(0, 8)})`);
                return { success: true, model: value.model };
            } else {
                this.logger.debug(`ModelSwitcher: 切换失败 — ${value.error}`);
                return { success: false, error: value.error };
            }
        } catch (err: any) {
            this.logger.debug(`ModelSwitcher: 执行异常 — ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    /**
     * 超时包装
     */
    private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`模型切换超时 (${ms}ms)`));
            }, ms);
            promise.then(
                (val) => { clearTimeout(timer); resolve(val); },
                (err) => { clearTimeout(timer); reject(err); },
            );
        });
    }
}
