/**
 * XDF-Base 扩展
 *
 * 在 QuickAdd（fork 版）onload 末尾被调用，挂载：
 * - 数据库管理
 * - 脚本释放
 * - Choice 预设
 * - 设置面板的数据库命令
 *
 * 注意：这个文件是 XDF-Base 唯一对 QuickAdd 主代码的侵入点。
 * 任何修改都集中在这，方便后续升级 QuickAdd 时 cherry-pick。
 */

import type { App, Plugin } from "obsidian";
import { Notice } from "obsidian";
import { DBConnection, DBSync, createDBApi, type XdfDBApi } from "./db";
import { DBBuilder } from "./db/Builder";
import { ScriptReleaser } from "./scripts/ScriptReleaser";
import { syncPresetChoices } from "./choiceManager";

export interface RebuildSummary {
    fileCount: number;
    durationMs: number;
    errors: Array<{ file: string; message: string }>;
}

export class XdfBaseExtension {
    private app: App;
    private plugin: Plugin;
    private db: DBConnection;
    private sync: DBSync;

    constructor(app: App, plugin: Plugin) {
        this.app = app;
        this.plugin = plugin;
        this.db = new DBConnection(app);
        this.sync = new DBSync(app, this.db);
    }

    /**
     * 初始化（onload 末尾调用）
     *
     * 顺序：脚本释放 → Choice 补全 → 事件监听 → 数据库。
     * 每步独立 try/catch：一步失败不拖垮其他步骤。
     */
    async initialize(): Promise<void> {
        // 0. 把自己注册到全局单例，供 settings tab 等模块访问
        setXdfBaseInstance(this);

        // 1. 释放预设脚本
        try {
            const releaser = new ScriptReleaser(this.app);
            const releaseReport = await releaser.releaseAll();
            console.log(`[XDF-Base] 脚本释放完成：新建 ${releaseReport.created.length}，覆盖 ${releaseReport.updated.length}，失败 ${releaseReport.failed.length}`);
        } catch (err) {
            console.error("[XDF-Base] 脚本释放失败:", err);
            new Notice("❌ XDF-Base 脚本释放失败：" + err);
        }

        // 2. 同步预设 Choice（文件夹分组，覆盖式）
        try {
            const choiceResult = syncPresetChoices(
                (this.plugin as any).settings?.choices || []
            );
            if (choiceResult.updated) {
                (this.plugin as any).settings.choices = choiceResult.choices;
                await (this.plugin as any).saveData((this.plugin as any).settings);
                console.log(`[XDF-Base] Choice 同步完成：新增文件夹 ${choiceResult.added.length}，重建 ${choiceResult.replaced.length}`);
            }
        } catch (err) {
            console.error("[XDF-Base] Choice 同步失败:", err);
        }

        // 3. 启动 vault 事件监听
        try {
            this.sync.attach();
            console.log("[XDF-Base] 事件监听已启动");
        } catch (err) {
            console.error("[XDF-Base] 事件监听启动失败:", err);
        }

        // 4. 初始化数据库（失败不影响上述功能）
        try {
            await this.db.initialize();
            this.registerDBApi();
            console.log("[XDF-Base] 数据库已初始化");
        } catch (err) {
            console.error("[XDF-Base] 数据库初始化失败:", err);
            new Notice("⚠️ XDF-Base 数据库暂不可用：" + err);
        }
    }

    /**
     * 清理（onunload 调用）
     */
    async cleanup(): Promise<void> {
        try {
            this.sync.detach();
            await this.db.close();
        } catch (err) {
            console.error("[XDF-Base] 清理失败:", err);
        }
    }

    /**
     * 获取 db API
     */
    getDBApi(): XdfDBApi {
        return createDBApi(this.app, this.db, this.sync);
    }

    /**
     * 手动初始化数据库（设置面板"Initialize database"按钮调用）
     * 幂等：若已初始化则直接返回
     */
    async initDatabase(): Promise<void> {
        await this.db.initialize();
    }

    /**
     * 手动触发数据库重建（设置面板"Rebuild database"按钮调用）
     * 返回真实数据：扫描文件数、耗时、错误列表
     */
    async rebuildDatabase(): Promise<RebuildSummary> {
        const builder = new DBBuilder(this.app, this.db);
        const report = await builder.rebuild();
        await this.db.save();
        return {
            fileCount: report.fileCount,
            durationMs: report.durationMs,
            errors: report.errors
        };
    }

    /**
     * 获取数据库状态（设置面板调用）
     */
    getDatabaseStatus() {
        return this.db.getStatus();
    }

    /**
     * 重新释放脚本（设置面板调用）
     */
    async releaseScripts() {
        const releaser = new ScriptReleaser(this.app);
        return await releaser.releaseAll();
    }

    /**
     * 重新同步预设 Choice（设置面板调用）
     */
    async ensureChoices() {
        const result = syncPresetChoices(
            (this.plugin as any).settings?.choices || []
        );
        if (result.updated) {
            (this.plugin as any).settings.choices = result.choices;
            await (this.plugin as any).saveData((this.plugin as any).settings);
        }
        return result;
    }

    private registerDBApi(): void {
        // 在 plugin 上挂个引用，方便其他模块访问
        (this.plugin as any)._xdfBase = this;
    }
}

/**
 * 全局单例（被 quickAddApi 引用）
 */
let xdfBaseInstance: XdfBaseExtension | null = null;

export function setXdfBaseInstance(instance: XdfBaseExtension): void {
    xdfBaseInstance = instance;
}

export function getXdfBaseInstance(): XdfBaseExtension | null {
    return xdfBaseInstance;
}
