import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'node:path';
import {
  readJSON, writeJSON, deleteJSON, readAllJSON,
  PATHS
} from '../utils/storage.js';

// ─── 数据结构 ─────────────────────────────────────────────

interface PromptTemplate {
  name: string;
  template: string;
  category: string;
  variables: string[];
  description: string;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── 辅助函数 ─────────────────────────────────────────────

function promptPath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(PATHS.prompts, `${safeName}.json`);
}

async function getAllPrompts(): Promise<PromptTemplate[]> {
  return readAllJSON<PromptTemplate>(PATHS.prompts);
}

/** 渲染模板：将 {{variable}} 替换为实际值 */
function renderTemplate(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function formatPrompt(p: PromptTemplate): string {
  const vars = p.variables.length > 0 ? ` (变量: ${p.variables.join(', ')})` : '';
  return `📝 ${p.name} [${p.category}]${vars} — 使用 ${p.usageCount} 次`;
}

// ─── 注册模块 ─────────────────────────────────────────────

export function registerPromptVault(server: McpServer): void {

  // ── tool: prompt_save ──
  server.registerTool(
    'prompt_save',
    {
      title: '保存提示词模板',
      description: '保存一个可复用的提示词模板，支持 {{variable}} 变量占位符',
      inputSchema: z.object({
        name: z.string().describe('模板唯一名称，如 "refactor-function"'),
        template: z.string().describe('模板内容，变量用 {{variableName}} 标记'),
        category: z.string().default('general').describe('分类: refactoring, debugging, feature, review, analysis 等'),
        variables: z.array(z.string()).default([]).describe('模板中的变量名列表'),
        description: z.string().default('').describe('模板描述说明'),
      }),
    },
    async ({ name, template, category, variables, description }) => {
      const existing = await readJSON<PromptTemplate>(promptPath(name));

      // 自动检测模板中的变量
      const detectedVars = [...template.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
      const allVars = [...new Set([...variables, ...detectedVars])];

      const prompt: PromptTemplate = {
        name,
        template,
        category,
        variables: allVars,
        description,
        usageCount: existing?.usageCount || 0,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeJSON(promptPath(name), prompt);

      const action = existing ? '更新' : '创建';
      return {
        content: [{ type: 'text', text: `✅ 提示词模板已${action}: ${formatPrompt(prompt)}` }],
      };
    }
  );

  // ── tool: prompt_get ──
  server.registerTool(
    'prompt_get',
    {
      title: '获取并渲染提示词',
      description: '获取提示词模板，可传入变量值进行渲染',
      inputSchema: z.object({
        name: z.string().describe('模板名称'),
        variables: z.record(z.string()).optional().describe('变量键值对，如 {"methodName": "calc", "filePath": "a.ts"}'),
      }),
    },
    async ({ name, variables }) => {
      const prompt = await readJSON<PromptTemplate>(promptPath(name));
      if (!prompt) {
        return { content: [{ type: 'text', text: `❌ 提示词模板不存在: ${name}` }], isError: true };
      }

      // 更新使用次数
      prompt.usageCount++;
      await writeJSON(promptPath(name), prompt);

      if (variables && Object.keys(variables).length > 0) {
        const rendered = renderTemplate(prompt.template, variables);
        // 检查是否还有未填充的变量
        const remaining = [...rendered.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
        const footer = remaining.length > 0
          ? `\n\n⚠️ 以下变量未填充: ${remaining.join(', ')}`
          : '';
        return {
          content: [{ type: 'text', text: `📝 渲染后的提示词 (${prompt.name}):\n\n---\n\n${rendered}${footer}` }],
        };
      }

      return {
        content: [{ type: 'text', text: `📝 模板 (${prompt.name}):\n\n分类: ${prompt.category}\n变量: ${prompt.variables.join(', ') || '无'}\n描述: ${prompt.description || '无'}\n使用次数: ${prompt.usageCount}\n\n---\n\n${prompt.template}` }],
      };
    }
  );

  // ── tool: prompt_list ──
  server.registerTool(
    'prompt_list',
    {
      title: '列出提示词模板',
      description: '列出所有保存的提示词模板',
      inputSchema: z.object({
        category: z.string().optional().describe('按分类过滤'),
      }),
    },
    async ({ category }) => {
      let prompts = await getAllPrompts();
      if (category) {
        prompts = prompts.filter(p => p.category === category);
      }

      if (prompts.length === 0) {
        return { content: [{ type: 'text', text: '📋 没有保存的提示词模板' }] };
      }

      // 按使用次数降序排列
      prompts.sort((a, b) => b.usageCount - a.usageCount);

      const lines = prompts.map(p => formatPrompt(p));
      const categories = [...new Set(prompts.map(p => p.category))];
      return {
        content: [{
          type: 'text',
          text: `📋 提示词模板 (${prompts.length} 个)\n分类: ${categories.join(', ')}\n\n${lines.join('\n')}`,
        }],
      };
    }
  );

  // ── tool: prompt_delete ──
  server.registerTool(
    'prompt_delete',
    {
      title: '删除提示词模板',
      description: '删除指定的提示词模板',
      inputSchema: z.object({
        name: z.string().describe('模板名称'),
      }),
    },
    async ({ name }) => {
      const ok = await deleteJSON(promptPath(name));
      return {
        content: [{ type: 'text', text: ok ? `🗑️ 提示词已删除: ${name}` : `❌ 提示词不存在: ${name}` }],
        isError: !ok,
      };
    }
  );
}
