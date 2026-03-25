import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger';
import { QuotaTracker, type WindowInfo } from './quota-tracker';

/**
 * 晨间报告生成器
 *
 * 在夜间模式关闭时汇总夜间工作数据，生成结构化报告。
 * 支持输出到日志、保存为 Markdown 文件、和 VS Code 信息面板。
 */

export interface NightTaskSummary {
    taskId: string;
    title: string;
    status: 'completed' | 'failed' | 'timeout';
    durationMinutes: number;
}

export interface NightReportData {
    period: { start: number; end: number };
    durationHours: number;
    windows: WindowInfo[];
    tasksDispatched: number;
    tasksCompleted: number;
    tasksFailed: number;
    autoClicks: number;
    autoRetries: number;
    quotaExhaustedCount: number;
    quotaUtilization: number;
}

export class NightReport {
    private readonly reportsDir: string;

    constructor(
        private quotaTracker: QuotaTracker,
        private logger: Logger,
        storagePath: string,
    ) {
        this.reportsDir = path.join(storagePath, 'night-reports');
    }

    /**
     * 生成晨间报告
     */
    generate(stats: {
        activatedAt: number;
        tasksDispatched: number;
        tasksCompleted: number;
        tasksFailed: number;
        quotaExhaustedCount: number;
    }): NightReportData {
        const now = Date.now();
        const durationHours = (now - stats.activatedAt) / 3600000;
        const windows = this.quotaTracker.getRecentHistory(
            Math.ceil(durationHours) + 1,
        );

        let totalClicks = 0;
        let totalRetries = 0;
        for (const w of windows) {
            totalClicks += w.clickCount;
            totalRetries += w.retryCount;
        }

        return {
            period: { start: stats.activatedAt, end: now },
            durationHours: Math.round(durationHours * 10) / 10,
            windows,
            tasksDispatched: stats.tasksDispatched,
            tasksCompleted: stats.tasksCompleted,
            tasksFailed: stats.tasksFailed,
            autoClicks: totalClicks,
            autoRetries: totalRetries,
            quotaExhaustedCount: stats.quotaExhaustedCount,
            quotaUtilization: this.quotaTracker.getUtilizationRate(
                Math.ceil(durationHours) + 1,
            ),
        };
    }

    /**
     * 格式化为 Markdown
     */
    formatMarkdown(data: NightReportData): string {
        const start = new Date(data.period.start).toLocaleString('zh-CN', { hour12: false });
        const end = new Date(data.period.end).toLocaleString('zh-CN', { hour12: false });

        const lines: string[] = [
            `# 🌅 夜间工作报告`,
            '',
            `> ${start} ~ ${end} (${data.durationHours}h)`,
            '',
            '## 📊 总览',
            '',
            '| 指标 | 值 |',
            '|------|-----|',
            `| 运行时长 | ${data.durationHours}h |`,
            `| 派发任务 | ${data.tasksDispatched} |`,
            `| 完成任务 | ${data.tasksCompleted} |`,
            `| 失败/超时 | ${data.tasksFailed} |`,
            `| 自动点击 | ${data.autoClicks} |`,
            `| 自动重试 | ${data.autoRetries} |`,
            `| 额度耗尽 | ${data.quotaExhaustedCount} 次 |`,
            `| 额度利用率 | ${data.quotaUtilization}% |`,
            '',
        ];

        // 窗口详情
        if (data.windows.length > 0) {
            lines.push(
                '## 🔋 额度窗口详情',
                '',
                '| 窗口时段 | 任务 | 点击 | 重试 | 耗尽 |',
                '|----------|------|------|------|------|',
            );

            for (const w of data.windows) {
                const s = new Date(w.startTime).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
                const e = new Date(w.endTime).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
                const ex = w.exhausted ? '⚠️ 是' : '✅ 否';
                lines.push(`| ${s}~${e} | ${w.taskCount} | ${w.clickCount} | ${w.retryCount} | ${ex} |`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * 保存报告到文件
     */
    async save(data: NightReportData): Promise<string> {
        try {
            if (!fs.existsSync(this.reportsDir)) {
                fs.mkdirSync(this.reportsDir, { recursive: true });
            }

            const dateStr = new Date().toISOString().split('T')[0];
            const filePath = path.join(this.reportsDir, `night-report-${dateStr}.md`);
            const markdown = this.formatMarkdown(data);

            fs.writeFileSync(filePath, markdown, 'utf-8');
            this.logger.info(`📄 晨间报告已保存: ${filePath}`);
            return filePath;
        } catch (err: any) {
            this.logger.debug(`保存晨间报告失败: ${err.message}`);
            return '';
        }
    }

    /**
     * 输出到日志
     */
    logReport(data: NightReportData): void {
        this.logger.info('');
        this.logger.info('==========================================');
        this.logger.info('  🌅 夜间工作报告');
        this.logger.info('==========================================');
        this.logger.info(`  运行时长: ${data.durationHours}h`);
        this.logger.info(`  派发任务: ${data.tasksDispatched}`);
        this.logger.info(`  完成任务: ${data.tasksCompleted}`);
        this.logger.info(`  失败/超时: ${data.tasksFailed}`);
        this.logger.info(`  自动点击: ${data.autoClicks}`);
        this.logger.info(`  自动重试: ${data.autoRetries}`);
        this.logger.info(`  额度耗尽: ${data.quotaExhaustedCount} 次`);
        this.logger.info(`  额度利用率: ${data.quotaUtilization}%`);
        this.logger.info('==========================================');
        this.logger.info('');
    }
}
