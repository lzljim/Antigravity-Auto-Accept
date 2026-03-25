import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';

/**
 * MCP Server 配置管理器
 *
 * 职责：将 mcp-server.mjs 的路径写入 ~/.gemini/antigravity/mcp_config.json，
 * 由 Antigravity IDE 负责按需启动和回收 MCP Server 进程（MCP 协议规范）。
 *
 * 不在这里 spawn 子进程，原因：
 *   - MCP 协议规定 Client（IDE）负责启动 Server
 *   - VS Code 扩展 spawn 会造成双实例冲突（端口 EADDRINUSE）
 *   - 进程生命周期应由 IDE 管理，IDE 退出时自动回收
 */
export class McpManager {
    private extensionPath: string;
    private logger: Logger;

    constructor(extensionPath: string, logger: Logger) {
        this.extensionPath = extensionPath;
        this.logger = logger;
    }

    /**
     * 写入 MCP 配置，让 Antigravity IDE 知道从哪里启动 MCP Server。
     * 实际进程由 IDE 负责启动，这里不 spawn。
     */
    async start(): Promise<boolean> {
        try {
            this.ensureMcpConfig();
            this.logger.info('[MCP] 配置已就绪，等待 Antigravity IDE 启动 Server');
            return true;
        } catch (e: any) {
            this.logger.info(`[MCP] 配置写入失败（非致命）: ${e.message}`);
            return false;
        }
    }

    /** 兼容接口，无实际操作（进程由 IDE 管理）*/
    stop(): void { /* no-op */ }

    /** 兼容接口 */
    async restart(): Promise<boolean> {
        return this.start();
    }

    /** 兼容接口 */
    get running(): boolean {
        return false; // 进程不在本扩展管控范围内
    }

    /**
     * 写入 ~/.gemini/antigravity/mcp_config.json
     *
     * 仅在路径不匹配时更新配置，避免不必要的文件写入。
     */
    private ensureMcpConfig(): void {
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        if (!userProfile) {
            this.logger.debug('[MCP] 无法确定用户目录，跳过 mcp_config.json 写入');
            return;
        }

        const configDir = join(userProfile, '.gemini', 'antigravity');
        const configPath = join(configDir, 'mcp_config.json');
        const serverPath = join(this.extensionPath, 'dist', 'mcp-server.mjs');

        let config: any = { mcpServers: {} };
        if (existsSync(configPath)) {
            try {
                config = JSON.parse(readFileSync(configPath, 'utf-8'));
            } catch {
                /* 配置文件损坏，用默认值 */
            }
        }
        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        const existing = config.mcpServers['local-assistant'];
        if (existing?.command === 'node' && existing?.args?.[0] === serverPath) {
            return; // 已配置，无需更新
        }

        config.mcpServers['local-assistant'] = {
            command: 'node',
            args: [serverPath],
            env: {},
        };

        mkdirSync(configDir, { recursive: true });
        writeFileSync(configPath, JSON.stringify(config, null, 2));
        this.logger.info(`[MCP] 已自动更新 ${configPath}`);
    }
}
