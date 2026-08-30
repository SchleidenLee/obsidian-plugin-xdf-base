/**
 * Vault 事件监听 + 增量同步
 *
 * 职责：
 * 1. 监听 vault 文件变更（create/modify/delete/rename）
 * 2. 500ms debounce
 * 3. 触发增量同步
 *
 * 增量同步的具体实现由 DBBuilder 决定（先做全量重建作为简化方案）。
 */

import type { App, TFile } from "obsidian";
import { DBConnection } from "./Connection";
import { DBBuilder } from "./Builder";

export class DBSync {
    private app: App;
    private db: DBConnection;
    private builder: DBBuilder;
    private debounceTimer: number | null = null;
    private enabled: boolean = true;
    private pendingEvents: PendingEvent[] = [];

    constructor(app: App, db: DBConnection) {
        this.app = app;
        this.db = db;
        this.builder = new DBBuilder(app, db);
    }

    /**
     * 启动监听
     */
    attach(): void {
        this.app.vault.on("create", this.handleEvent);
        this.app.vault.on("modify", this.handleEvent);
        this.app.vault.on("delete", this.handleEvent);
        this.app.vault.on("rename", this.handleEvent);
    }

    /**
     * 停止监听
     */
    detach(): void {
        this.app.vault.off("create", this.handleEvent);
        this.app.vault.off("modify", this.handleEvent);
        this.app.vault.off("delete", this.handleEvent);
        this.app.vault.off("rename", this.handleEvent);
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    /**
     * 设置是否启用同步
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled && this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    /**
     * 手动触发重建（用于初始化或用户主动点击）
     */
    async rebuildNow(): Promise<void> {
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        await this.builder.rebuild();
        await this.db.save();
    }

    private handleEvent = (file: TFile) => {
        if (!this.enabled) return;

        // 只关心 markdown 文件
        if (file.extension !== "md") return;

        // 记录 pending 事件
        this.pendingEvents.push({
            type: "vault-change",
            path: file.path,
            timestamp: Date.now()
        });

        // debounce 500ms
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(() => {
            this.flush();
        }, 500);
    };

    private async flush(): Promise<void> {
        this.debounceTimer = null;
        const eventCount = this.pendingEvents.length;
        this.pendingEvents = [];

        if (eventCount === 0) return;

        // 当前简化方案：全量重建
        // 后续可以做增量（按文件路径分桶）
        try {
            await this.builder.rebuild();
            await this.db.save();
        } catch (err) {
            console.error("[XDF-Base] DB 同步失败:", err);
        }
    }

    /**
     * 获取待处理事件数（用于状态显示）
     */
    getPendingCount(): number {
        return this.pendingEvents.length;
    }
}

interface PendingEvent {
    type: string;
    path: string;
    timestamp: number;
}
