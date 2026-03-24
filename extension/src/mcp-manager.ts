import { spawn, ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';

/**
 * MCP Server 进程管理器
 *
 * 管理内置 MCP Server 子进程的生命周期：
 *   - 自动启动 node dist/mcp-server.mjs
 *   - 自动写入 ~/.gemini/antigravity/mcp_config.json
 *   - 优雅降级：MCP 启动失败不影响核心功能
 */
export class McpManager {
    private process: ChildProcess | null = null;
    private extensionPath: string;
    private logger: Logger;

    constructor(extensionPath: string, logger: Logger) {
        this.extensionPath = extensionPath;
        this.logger = logger;
    }

    /**
     * 启动 MCP Server 子进程
     */
    async start(): Promise<boolean> {
        try {
            this.ensureMcpConfig();
        } catch (e: any) {
            this.logger.info(`[MCP] 配置写入失败（非致命）: ${e.message}`);
        }

        const serverPath = join(this.extensionPath, 'dist', 'mcp-server.mjs');
        if (!existsSync(serverPath)) {
            this.logger.info(`[MCP] 服务端文件不存在: ${serverPath}，跳过启动`);
            return false;
        }

        try {
            this.process = spawn('node', [serverPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, NODE_NO_WARNINGS: '1' },
            });

            this.process.stderr?.on('data', (d: Buffer) => {
                this.logger.info(`[MCP] ${d.toString().trim()}`);
            });

            this.process.stdout?.on('data', (d: Buffer) => {
                this.logger.debug(`[MCP:stdout] ${d.toString().trim()}`);
            });

            this.process.on('exit', (code) => {
                this.logger.info(`[MCP] 进程退出 (code: ${code})`);
                this.process = null;
            });

            this.process.on('error', (err) => {
                this.logger.error(`[MCP] 进程错误: ${err.message}`);
                this.process = null;
            });

            this.logger.info('[MCP] Server 已启动');
            return true;
        } catch (e: any) {
            this.logger.error(`[MCP] 启动失败: ${e.message}`);
            return false;
        }
    }

    /**
     * 停止 MCP Server 子进程
     */
    stop(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
            this.logger.info('[MCP] Server 已停止');
        }
    }

    /**
     * 重启 MCP Server
     */
    async restart(): Promise<boolean> {
        this.stop();
        return this.start();
    }

    /**
     * 获取 MCP Server 运行状态
     */
    get running(): boolean {
        return this.process !== null && this.process.exitCode === null;
    }

    /**
     * 自动写入 ~/.gemini/antigravity/mcp_config.json
     *
     * 确保 Antigravity IDE 能发现并连接内置 MCP Server。
     * 仅在配置不存在或路径不匹配时才写入。
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

        // 读取现有配置
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

        // 检查是否已有正确配置
        const existing = config.mcpServers['local-assistant'];
        if (existing?.command === 'node' && existing?.args?.[0] === serverPath) {
            return; // 已配置，无需更新
        }

        // 写入配置
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
