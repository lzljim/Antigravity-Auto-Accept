import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'node:path';
import {
  readJSON, writeJSON, deleteJSON, readAllJSON,
  PATHS
} from '../utils/storage.js';

// ─── 数据结构 ─────────────────────────────────────────────

interface SharedContext {
  key: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  accessCount: number;
}

// ─── 辅助函数 ─────────────────────────────────────────────

function contextPath(key: string): string {
  // 将 key 中不适合做文件名的字符替换为下划线
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(PATHS.contexts, `${safeKey}.json`);
}

async function getAllContexts(): Promise<SharedContext[]> {
  const all = await readAllJSON<SharedContext>(PATHS.contexts);
  const now = new Date().toISOString();
  // 过滤掉已过期的上下文
  return all.filter(ctx => !ctx.expiresAt || ctx.expiresAt > now);
}

function formatContext(ctx: SharedContext): string {
  const tags = ctx.tags.length > 0 ? ` [${ctx.tags.join(', ')}]` : '';
  const expires = ctx.expiresAt ? ` (过期: ${ctx.expiresAt})` : '';
  return `📎 ${ctx.key}${tags}${expires} — 访问 ${ctx.accessCount} 次`;
}

// ─── 注册模块 ─────────────────────────────────────────────

export function registerContextBridge(server: McpServer): void {

  // ── tool: context_share ──
  server.registerTool(
    'context_share',
    {
      title: '分享上下文',
      description: '将信息分享到跨会话共享池中，其他 Antigravity 会话可以读取',
      inputSchema: z.object({
        key: z.string().describe('唯一标识符，如 "api-design-v2"'),
        content: z.string().describe('上下文内容（代码片段、设计决策、接口定义等）'),
        tags: z.array(z.string()).default([]).describe('分类标签'),
        expiresInHours: z.number().optional().describe('可选，过期时间（小时数），不填则永不过期'),
      }),
    },
    async ({ key, content, tags, expiresInHours }) => {
      const existing = await readJSON<SharedContext>(contextPath(key));

      const ctx: SharedContext = {
        key,
        content,
        tags,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: expiresInHours
          ? new Date(Date.now() + expiresInHours * 3600_000).toISOString()
          : undefined,
        accessCount: existing?.accessCount || 0,
      };
      await writeJSON(contextPath(key), ctx);

      const action = existing ? '更新' : '创建';
      return {
        content: [{ type: 'text', text: `✅ 上下文已${action}: ${formatContext(ctx)}\n\n内容预览 (前200字):\n${content.slice(0, 200)}${content.length > 200 ? '...' : ''}` }],
      };
    }
  );

  // ── tool: context_get ──
  server.registerTool(
    'context_get',
    {
      title: '获取上下文',
      description: '获取指定的共享上下文内容',
      inputSchema: z.object({
        key: z.string().describe('上下文标识符'),
      }),
    },
    async ({ key }) => {
      const ctx = await readJSON<SharedContext>(contextPath(key));
      if (!ctx) {
        return { content: [{ type: 'text', text: `❌ 上下文不存在: ${key}` }], isError: true };
      }
      // 检查过期
      if (ctx.expiresAt && ctx.expiresAt < new Date().toISOString()) {
        await deleteJSON(contextPath(key));
        return { content: [{ type: 'text', text: `⏰ 上下文已过期: ${key}` }], isError: true };
      }
      // 更新访问计数
      ctx.accessCount++;
      await writeJSON(contextPath(key), ctx);

      return {
        content: [{ type: 'text', text: `📎 **${ctx.key}**\n标签: ${ctx.tags.join(', ') || '无'}\n更新时间: ${ctx.updatedAt}\n访问次数: ${ctx.accessCount}\n\n---\n\n${ctx.content}` }],
      };
    }
  );

  // ── tool: context_list ──
  server.registerTool(
    'context_list',
    {
      title: '列出共享上下文',
      description: '列出所有可用的共享上下文',
      inputSchema: z.object({
        tag: z.string().optional().describe('按标签过滤'),
      }),
    },
    async ({ tag }) => {
      let contexts = await getAllContexts();
      if (tag) {
        contexts = contexts.filter(ctx => ctx.tags.includes(tag));
      }

      if (contexts.length === 0) {
        return { content: [{ type: 'text', text: '📋 没有可用的共享上下文' }] };
      }

      const lines = contexts.map(ctx => formatContext(ctx));
      return {
        content: [{ type: 'text', text: `📋 共享上下文列表 (${contexts.length} 个):\n\n${lines.join('\n')}` }],
      };
    }
  );

  // ── resource: context://all ──
  server.registerResource(
    'all-contexts',
    'context://all',
    {
      title: '所有共享上下文',
      description: '返回所有共享上下文的摘要列表',
      mimeType: 'application/json',
    },
    async () => {
      const contexts = await getAllContexts();
      const summary = contexts.map(ctx => ({
        key: ctx.key,
        tags: ctx.tags,
        updatedAt: ctx.updatedAt,
        accessCount: ctx.accessCount,
        contentLength: ctx.content.length,
      }));
      return {
        contents: [{ uri: 'context://all', text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── resource: context://{key} ──
  server.registerResource(
    'context-detail',
    new ResourceTemplate('context://{key}', {
      list: async () => {
        const contexts = await getAllContexts();
        return {
          resources: contexts.map(ctx => ({
            uri: `context://${ctx.key}`,
            name: ctx.key,
          })),
        };
      },
    }),
    {
      title: '上下文详情',
      description: '获取单个共享上下文的完整内容',
      mimeType: 'application/json',
    },
    async (uri, { key }) => {
      const ctx = await readJSON<SharedContext>(contextPath(key as string));
      if (!ctx) {
        return { contents: [{ uri: uri.href, text: '{"error": "Context not found"}' }] };
      }
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(ctx, null, 2) }],
      };
    }
  );
}
