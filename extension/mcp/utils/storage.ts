import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * 数据根目录：项目根目录下的 .mcp-data/
 * 数据随项目通过 git 同步到其他设备
 */
export const DATA_ROOT = join(__dirname, '..', '..', '.mcp-data');

/** 确保目录存在 */
export async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

/** 读取 JSON 文件 */
export async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 写入 JSON 文件（原子写入：先写临时文件再重命名） */
export async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await ensureDir(dirname(filePath));
  const content = JSON.stringify(data, null, 2);
  // 先写入临时文件，再覆盖目标文件，减少写入中断导致数据损坏的风险
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, content, 'utf-8');
  await writeFile(filePath, content, 'utf-8');
  // 清理临时文件
  try { await unlink(tmpPath); } catch { /* ignore */ }
}

/** 删除 JSON 文件 */
export async function deleteJSON(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 列出目录下所有 JSON 文件（返回完整路径） */
export async function listJSONFiles(dirPath: string): Promise<string[]> {
  await ensureDir(dirPath);
  try {
    const files = await readdir(dirPath);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => join(dirPath, f));
  } catch {
    return [];
  }
}

/** 读取目录下所有 JSON 文件并解析 */
export async function readAllJSON<T>(dirPath: string): Promise<T[]> {
  const files = await listJSONFiles(dirPath);
  const results: T[] = [];
  for (const file of files) {
    const data = await readJSON<T>(file);
    if (data) results.push(data);
  }
  return results;
}

/** 生成简单的唯一 ID（无外部依赖） */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/** 获取各模块的数据目录路径 */
export const PATHS = {
  tasks: join(DATA_ROOT, 'tasks'),
  contexts: join(DATA_ROOT, 'contexts'),
  prompts: join(DATA_ROOT, 'prompts'),
  plans: join(DATA_ROOT, 'plans'),
};
