import { Logger } from './logger';
import { CDPTargetManager } from './cdp-target-manager';

/**
 * CDP 消息发送器 — 通过 CDP Input API 向 Agent 会话发送聊天消息
 *
 * 复用 auto-accept.js 中已验证的 sendMessageViaCDP 逻辑，改造为 TypeScript 模块。
 *
 * 工作流:
 *   1. 聚焦 contenteditable 输入框
 *   2. Ctrl+A → Backspace 清空
 *   3. Input.insertText 插入文本
 *   4. Enter 发送
 */
export class CDPMessenger {
    constructor(
        private cdpManager: CDPTargetManager,
        private logger: Logger,
    ) {}

    /**
     * 向指定 target 发送聊天消息
     *
     * @param targetId - CDP target ID
     * @param message - 要发送的消息文本
     * @returns 是否发送成功
     */
    async sendMessage(targetId: string, message: string): Promise<boolean> {
        // 优先使用持久连接
        const conn = this.cdpManager.getConnection(targetId);
        if (conn?.ready) {
            return await this.sendViaClient(conn.client, message);
        }

        // 退而求其次：短连接
        const targets = await this.cdpManager.listTargets();
        const target = targets.find((t: any) => t.id === targetId);
        if (!target) {
            this.logger.debug(`CDPMessenger: target ${targetId} 不存在`);
            return false;
        }

        let client: any;
        try {
            client = await this.cdpManager.connectTarget(target);
            return await this.sendViaClient(client, message);
        } catch (err: any) {
            this.logger.debug(`CDPMessenger: 短连接失败: ${err.message}`);
            return false;
        } finally {
            if (client) {
                try { client.close(); } catch (_) { /* ignore */ }
            }
        }
    }

    private async sendViaClient(client: any, message: string): Promise<boolean> {
        const { Runtime, Input } = client;

        // 聚焦输入框
        const focus = await Runtime.evaluate({
            expression: `(() => {
                const el = document.querySelector('[contenteditable="true"]');
                if (!el) return { found: false };
                el.focus();
                return { found: true };
            })()`,
            returnByValue: true,
            awaitPromise: false,
        });

        if (!focus?.result?.value?.found) {
            this.logger.debug('CDPMessenger: 输入框未找到');
            return false;
        }

        // 清空现有内容
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }); // Ctrl+A
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', code: 'Backspace' });
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', code: 'Backspace' });

        // 插入消息文本
        await Input.insertText({ text: message });

        // 按 Enter 发送
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter' });
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });

        this.logger.info(`📤 消息已发送 (${message.length} 字符)`);
        return true;
    }
}
