import { Logger } from './logger';
import { Config } from './config';

/**
 * 任务难度等级
 */
export type DifficultyLevel = 'L4' | 'L3' | 'L2' | 'L1';

/**
 * 模型路由结果
 */
export interface ModelRoutingResult {
    model: string;
    difficulty: DifficultyLevel;
    reason: string;
}

/**
 * 任务信息（用于模型路由判定）
 */
interface TaskForRouting {
    title: string;
    description?: string;
    priority?: string;
    tags?: string[];
    estimatedMinutes?: number;
    codeContext?: string;
    workspace?: string;
}

// ── 预定义模型名称 ──

const MODELS = {
    OPUS: 'Claude Opus 4.6 (Thinking)',
    SONNET: 'Claude Sonnet 4.6 (Thinking)',
    GEMINI: 'Gemini 3.1 Pro (High)',
} as const;

// ── 性质标签分类 ──

const L4_TAGS = ['architecture', 'design', 'system-design'];
const L1_SIMPLE_TAGS = ['testing', 'documentation', 'review', 'docs', 'test'];
const L1_BUGFIX_TAGS = ['bugfix', 'bug', 'fix', 'hotfix'];

/**
 * ModelRouter — 难度→模型映射规则引擎
 *
 * 根据任务的 priority / tags / estimatedMinutes / codeContext 等信息
 * 自动判定任务难度等级（L4–L1），并映射到最适合的 AI 模型。
 *
 * 映射策略（与 PRD 一致）：
 *   L4 架构级 → Claude Opus (Thinking)
 *   L3 复杂   → Claude Sonnet (Thinking) / Opus (上下文 > 50 files)
 *   L2 标准   → Claude Sonnet (Thinking)
 *   L1 简单   → Gemini Pro (测试/文档) / Sonnet (Bug修复)
 *
 * 支持 workspace preferredModels 覆盖。
 */
export class ModelRouter {
    constructor(
        private config: Config,
        private logger: Logger,
    ) {}

    /**
     * 根据任务信息决定最佳模型
     *
     * @param task              任务信息
     * @param preferredModels   workspace 级别的偏好模型列表（可选）
     * @returns                 模型路由结果
     */
    resolveModel(task: TaskForRouting, preferredModels?: string[]): ModelRoutingResult {
        // 1. 判定难度等级
        const difficulty = this.assessDifficulty(task);

        // 2. 根据难度 + 性质映射模型
        let model = this.mapDifficultyToModel(difficulty, task);

        // 3. 如果 workspace 有偏好模型，尝试在偏好列表中找匹配
        if (preferredModels && preferredModels.length > 0) {
            const preferred = this.findPreferredModel(difficulty, preferredModels);
            if (preferred) {
                model = preferred;
            }
        }

        const reason = `难度=${difficulty}, priority=${task.priority || 'medium'}, tags=${(task.tags || []).join(',')}`;
        this.logger.info(`🤖 模型路由: "${task.title}" → ${this.getDisplayName(model)} (${reason})`);

        return { model, difficulty, reason };
    }

    /**
     * 获取模型的简短展示名
     */
    getDisplayName(model: string): string {
        const lower = model.toLowerCase();
        if (lower.includes('opus')) return 'Opus';
        if (lower.includes('sonnet')) return 'Sonnet';
        if (lower.includes('gemini')) return 'Gemini';
        // 截取第一段作为名称
        return model.split(/[(\s]/)[0] || model;
    }

    // ── 内部方法 ──

    /**
     * 评估任务难度等级
     */
    private assessDifficulty(task: TaskForRouting): DifficultyLevel {
        const tags = (task.tags || []).map(t => t.toLowerCase());
        const priority = (task.priority || 'medium').toLowerCase();
        const minutes = task.estimatedMinutes || 30;

        // L4: urgent priority 或包含架构设计标签
        if (priority === 'urgent' || tags.some(t => L4_TAGS.includes(t))) {
            return 'L4';
        }

        // L1: low priority 或纯测试/文档/Review 标签
        if (priority === 'low' || tags.some(t => L1_SIMPLE_TAGS.includes(t))) {
            // 但如果预估时间很长，升级到 L2
            if (minutes > 60) return 'L2';
            return 'L1';
        }

        // L3: high priority 或预估超过 60 分钟
        if (priority === 'high' || minutes > 60) {
            return 'L3';
        }

        // L2: medium priority，其他
        return 'L2';
    }

    /**
     * 根据难度和任务性质映射到模型
     */
    private mapDifficultyToModel(difficulty: DifficultyLevel, task: TaskForRouting): string {
        const tags = (task.tags || []).map(t => t.toLowerCase());

        switch (difficulty) {
            case 'L4':
                return MODELS.OPUS;

            case 'L3': {
                // 如果 codeContext 暗示大量文件（简单启发式：行数 > 500 或包含 "50" 以上的文件引用）
                const ctx = task.codeContext || '';
                const fileRefs = (ctx.match(/\b\w+\.\w{2,4}\b/g) || []).length;
                if (fileRefs > 50) {
                    return MODELS.OPUS;
                }
                return MODELS.SONNET;
            }

            case 'L2':
                return MODELS.SONNET;

            case 'L1': {
                // Bug 修复用 Sonnet，测试/文档/配置用 Gemini
                if (tags.some(t => L1_BUGFIX_TAGS.includes(t))) {
                    return MODELS.SONNET;
                }
                return MODELS.GEMINI;
            }

            default:
                return MODELS.SONNET;
        }
    }

    /**
     * 在 workspace preferredModels 中找到与难度最匹配的模型
     */
    private findPreferredModel(difficulty: DifficultyLevel, preferredModels: string[]): string | null {
        if (preferredModels.length === 0) return null;

        // L4/L3 优先找 Opus，然后 Sonnet
        // L2 优先找 Sonnet
        // L1 优先找 Gemini，然后 Sonnet
        const preferenceMap: Record<DifficultyLevel, string[]> = {
            L4: ['opus', 'sonnet'],
            L3: ['sonnet', 'opus'],
            L2: ['sonnet', 'gemini'],
            L1: ['gemini', 'sonnet'],
        };
        const preference = preferenceMap[difficulty];

        for (const keyword of preference) {
            const match = preferredModels.find(m => m.toLowerCase().includes(keyword));
            if (match) return match;
        }

        // 未匹配到偏好，返回列表第一个
        return preferredModels[0];
    }
}
