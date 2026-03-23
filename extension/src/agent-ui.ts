import { Logger } from './logger';

// antigravity-sdk 类型
type AntigravitySDKType = any;

/**
 * Agent View UI 集成
 *
 * 使用 antigravity-sdk 的 IntegrationManager 在 Agent 面板中添加自定义 UI 元素。
 */
export class AgentUI {
    private sdk: AntigravitySDKType;
    private logger: Logger;
    private ui: any = null;

    constructor(sdk: AntigravitySDKType, logger: Logger) {
        this.sdk = sdk;
        this.logger = logger;
    }

    /**
     * 安装 Agent View 集成
     */
    async install(stats: { acceptCount: number; retryCount: number; running: boolean }): Promise<void> {
        try {
            // 动态获取 IntegrationManager
            let IntegrationManager: any;
            try {
                const sdkModule = require('antigravity-sdk');
                IntegrationManager = sdkModule.IntegrationManager;
            } catch {
                this.logger.debug('IntegrationManager 不可用，跳过 Agent View 集成');
                return;
            }

            if (!IntegrationManager) {
                this.logger.debug('IntegrationManager 未找到');
                return;
            }

            this.ui = new IntegrationManager();

            // 顶栏按钮：显示统计信息
            this.ui.addTopBarButton('auto-accept-stats', '🤖', 'Auto Accept Stats', {
                title: 'Auto Accept',
                rows: [
                    { key: 'Status', value: stats.running ? '✅ 运行中' : '⏸ 暂停' },
                    { key: 'Accepted', value: String(stats.acceptCount) },
                    { key: 'Retried', value: String(stats.retryCount) },
                ],
            });

            await this.ui.install();
            this.ui.enableAutoRepair();

            this.logger.info('🎨 Agent View UI 集成已安装');
        } catch (err: any) {
            this.logger.debug(`Agent View 集成安装失败: ${err.message}`);
        }
    }

    /**
     * 更新统计信息
     */
    async updateStats(stats: { acceptCount: number; retryCount: number; running: boolean }): Promise<void> {
        if (!this.ui) {
            return;
        }

        try {
            // 重新安装以更新数据（IntegrationManager 的更新方式）
            await this.install(stats);
        } catch (err: any) {
            this.logger.debug(`更新 Agent View 统计失败: ${err.message}`);
        }
    }
}
