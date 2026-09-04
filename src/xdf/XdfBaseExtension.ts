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
import { Notice, TFile } from "obsidian";
import { DBConnection, DBSync, createDBApi, type XdfDBApi } from "./db";
import { rebuildDatabase as rebuildVaultDatabase, DBWriter } from "./db/Builder";
import { SchemaManager } from "./db/Schema";
import { appendDbLog } from "./db/DbLog";
import { ScriptReleaser } from "./scripts/ScriptReleaser";
import { syncPresetChoices } from "./choiceManager";
import { registerInlineGroupRendering } from "./InlineGroup";

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

        // 3. 初始化数据库（建表 + 空库全量重建 / 旧库对账补漏）
        //    必须在 sync.attach() 之前完成：避免监听器打到未初始化的连接
        try {
            await this.db.initialize();
            new SchemaManager(this.db).apply();
            this.registerDBApi();
            await this.reconcileOnStartup();
            console.log("[XDF-Base] 数据库已初始化");
        } catch (err) {
            console.error("[XDF-Base] 数据库初始化失败:", err);
            new Notice("⚠️ XDF-Base 数据库暂不可用：" + err);
            void appendDbLog(this.app, {
                level: "error",
                source: "DB启动",
                message: `数据库初始化失败：${String(err)}`,
            });
        }

        // 4. 启动 vault 事件监听（数据库就绪后才挂）
        try {
            this.sync.attach();
            console.log("[XDF Base] 事件监听已启动");
        } catch (err) {
            console.error("[XDF Base] 事件监听启动失败:", err);
        }

        // 5. 单行 checkbox 组渲染（InlineGroup：CM6 decoration + 阅读模式 postprocessor，
        //    均随插件生命周期自动清理，无需手动 detach）
        try {
            registerInlineGroupRendering(this.app, this.plugin);
        } catch (err) {
            console.error("[XDF-Base] InlineGroup 渲染挂载失败:", err);
        }
    }

    /**
     * 启动对账（设计稿同步机制第 2 条）：
     * - 空库（files 表为空且 vault 有 md）→ 全量重建
     * - vault 有而库无 / mtime 不一致 → 逐文件补 upsert（事件丢失兜底）
     * - 库有而 vault 无 → 按路径删除（文件在外部被移走）
     */
    private async reconcileOnStartup(): Promise<void> {
        const files = this.app.vault.getFiles()
            .filter(f => !f.path.split("/").some(seg => [".obsidian", ".trash", ".xdf"].includes(seg)))
            .filter(f => !["tmp", "log", "crdownload", "part"].includes(f.extension.toLowerCase()));
        const knownRows = this.db.query<{ path: string; mtime: number }>(
            "SELECT path, mtime FROM files"
        );
        const known = new Map(knownRows.map(r => [r.path, r.mtime]));

        // 库有 vault 无 → 删
        const vaultPaths = new Set(files.map(f => f.path));
        for (const row of knownRows) {
            if (!vaultPaths.has(row.path)) {
                new DBWriter(this.db).removeFile(row.path);
            }
        }

        // vault 有库无 / mtime 变 → 补（md 读内容，非 md 登记为 binary）
        const stale: TFile[] = [];
        for (const f of files) {
            const recorded = known.get(f.path);
            if (recorded == null || recorded !== Math.floor(f.stat.mtime / 1000)) {
                stale.push(f);
            }
        }

        if (knownRows.length === 0 && files.length > 0) {
            // 空库 → 全量重建（含 frontmatter 解析、实体、切块、binary 登记）
            const stats = await rebuildVaultDatabase(this.app, this.db);
            await this.db.save();
            console.log(`[XDF-Base] 空库全量重建完成：${stats.fileCount} 文件，错误 ${stats.errors.length}`);
            for (const e of stats.errors) {
                void appendDbLog(this.app, {
                    level: "warn", source: "DB重建",
                    message: e.message, path: e.path,
                });
            }
            return;
        }

        if (stale.length > 0 || knownRows.length > vaultPaths.size) {
            const writer = new DBWriter(this.db);
            for (const f of stale) {
                const isMd = f.extension === "md";
                const stats = writer.upsertFile({
                    path: f.path,
                    basename: f.basename,
                    content: isMd ? await this.app.vault.cachedRead(f) : "",
                    mtime: Math.floor(f.stat.mtime / 1000),
                    size: f.stat.size,
                    binary: !isMd,
                });
                for (const e of stats.errors) {
                    void appendDbLog(this.app, {
                        level: "warn", source: "DB对账",
                        message: e.message, path: e.path,
                    });
                }
            }
            await this.db.save();
            console.log(`[XDF Base] 启动对账完成：补写 ${stale.length} 个文件`);
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
        // 建表 + 开外键（幂等；clear() 重建后同样要重跑）
        new SchemaManager(this.db).apply();
    }

    /**
     * 手动触发数据库重建（设置面板"Rebuild database"按钮调用）
     * 返回真实数据：扫描文件数、耗时、错误列表
     */
    async rebuildDatabase(): Promise<RebuildSummary> {
        const started = Date.now();
        const stats = await rebuildVaultDatabase(this.app, this.db);
        await this.db.save();
        return {
            fileCount: stats.fileCount,
            durationMs: Date.now() - started,
            errors: stats.errors.map(e => ({ file: e.path, message: e.message }))
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
