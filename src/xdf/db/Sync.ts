/**
 * Vault 事件监听 + 增量同步
 *
 * 职责：
 * 1. 监听 vault 文件变更（create/modify/delete/rename）
 * 2. 500ms debounce（合并连续输入）+ 2s 节流（防高频打字节奏打爆写盘）
 * 3. 按 pending 路径分桶增量同步：
 *    - create/modify → DBWriter.upsertFile(path)
 *    - delete        → DBWriter.removeFile(path)
 *    - rename        → removeFile(oldPath) + upsertFile(newPath)
 *    - 档案页变更    → 旗下 nav 文件重读后连带 upsert（归属外键重算）
 *
 * 数据一致性：md 是唯一数据源，数据库是查询镜像；任何时刻数据库
 * 落后 md 最多约 2.5s（500ms debounce + 2s 节流），最终一致。
 */

import { TFile, type App } from "obsidian";
import { DBConnection } from "./Connection";
import { DBWriter, type FileSnapshot } from "./Builder";
import { detectKind, parseFrontmatterBlock } from "./Parser";
import { appendDbLog } from "./DbLog";

/** debounce：输入静默多久后触发 flush */
const DEBOUNCE_MS = 500;
/** 节流：两次 flush 的最小间隔（防 600ms 规律停顿节奏高频写盘） */
const THROTTLE_MS = 2000;

interface PendingEvent {
    type: "create" | "modify" | "delete" | "rename";
    path: string;        // 新路径（rename 时为新路径）
    oldPath?: string;    // rename 时的旧路径
    timestamp: number;
}

export class DBSync {
    private app: App;
    private db: DBConnection;
    private debounceTimer: number | null = null;
    private throttleTimer: number | null = null;
    private lastFlushAt = 0;
    private enabled: boolean = true;
    private pendingEvents: PendingEvent[] = [];
    private flushing = false;

    constructor(app: App, db: DBConnection) {
        this.app = app;
        this.db = db;
    }

    /**
     * 启动监听
     */
    attach(): void {
        this.app.vault.on("create", this.handleEvent);
        this.app.vault.on("modify", this.handleEvent);
        this.app.vault.on("delete", this.handleDelete);
        this.app.vault.on("rename", this.handleRename);
    }

    /**
     * 停止监听
     */
    detach(): void {
        this.app.vault.off("create", this.handleEvent);
        this.app.vault.off("modify", this.handleEvent);
        this.app.vault.off("delete", this.handleDelete);
        this.app.vault.off("rename", this.handleRename);
        this.clearTimers();
    }

    /**
     * 设置是否启用同步
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) this.clearTimers();
    }

    /**
     * 手动触发全量重建（用于初始化或用户主动点击）
     */
    async rebuildNow(): Promise<void> {
        this.clearTimers();
        const { rebuildDatabase } = await import("./Builder");
        await rebuildDatabase(this.app, this.db);
        await this.db.save();
        this.lastFlushAt = Date.now();
    }

    // ========== 事件处理 ==========

    /** 系统目录与非登记扩展名不进同步（与 collectVaultFiles 的过滤一致） */
    private shouldTrack(file: TFile): boolean {
        if (!this.enabled) return false;
        if (file.path.split("/").some(seg => [".obsidian", ".trash", ".xdf"].includes(seg))) return false;
        if (["tmp", "log", "crdownload", "part"].includes(file.extension.toLowerCase())) return false;
        return true;
    }

    private handleEvent = (file: TFile) => {
        if (!this.shouldTrack(file)) return;
        this.enqueue({ type: "modify", path: file.path, timestamp: Date.now() });
    };

    private handleDelete = (file: TFile) => {
        if (!this.shouldTrack(file)) return;
        this.enqueue({ type: "delete", path: file.path, timestamp: Date.now() });
    };

    private handleRename = (file: TFile, oldPath: string) => {
        if (!this.shouldTrack(file)) return;
        this.enqueue({
            type: "rename", path: file.path, oldPath, timestamp: Date.now(),
        });
    };

    private enqueue(event: PendingEvent): void {
        this.pendingEvents.push(event);
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(() => {
            this.debounceTimer = null;
            this.scheduleFlush();
        }, DEBOUNCE_MS);
    }

    /**
     * 节流入口：距上次 flush 不足 THROTTLE_MS 时，延迟到差值期满再跑
     */
    private scheduleFlush(): void {
        if (this.flushing) return; // 上一轮还在跑：其结束后会再检查 pendingEvents
        const elapsed = Date.now() - this.lastFlushAt;
        if (elapsed >= THROTTLE_MS) {
            void this.flush();
            return;
        }
        if (this.throttleTimer !== null) return; // 已在等待
        this.throttleTimer = window.setTimeout(() => {
            this.throttleTimer = null;
            void this.flush();
        }, THROTTLE_MS - elapsed);
    }

    // ========== 增量同步 ==========

    private async flush(): Promise<void> {
        if (this.flushing || this.pendingEvents.length === 0) return;
        this.flushing = true;
        this.lastFlushAt = Date.now();

        // 取走本轮事件（新事件进下一轮）
        const events = this.pendingEvents;
        this.pendingEvents = [];

        try {
            // 1. 按路径分桶（同一路径多事件只保留最后语义）
            //    rename = 旧路径删 + 新路径写
            const deletedPaths = new Set<string>();
            const upsertPaths = new Set<string>();
            for (const ev of events) {
                if (ev.type === "delete") {
                    deletedPaths.add(ev.path);
                    upsertPaths.delete(ev.path);
                } else if (ev.type === "rename") {
                    if (ev.oldPath) deletedPaths.add(ev.oldPath);
                    upsertPaths.delete(ev.oldPath ?? "");
                    upsertPaths.add(ev.path);
                } else { // create / modify
                    upsertPaths.add(ev.path);
                }
            }

            // 2. 每轮 flush 用新 writer：归属映射从当前库行预热，
            //    避免长命实例的映射过期（档案删除后残留死 id → FK 违规）
            const writer = new DBWriter(this.db);

            // 2a. 先删后写
            for (const path of deletedPaths) {
                writer.removeFile(path);
            }

            // 3. 快照 + 按 kind 分组（binary 附件只登记，与 md 同流程）
            const archiveSnaps: FileSnapshot[] = [];
            const navSnaps: FileSnapshot[] = [];
            const otherSnaps: FileSnapshot[] = [];
            for (const path of upsertPaths) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (!(file instanceof TFile)) continue;
                const snap = await this.snapshotOf(file);
                if (snap.binary) {
                    otherSnaps.push(snap); // binary 无实体依赖，进"其余"桶
                    continue;
                }
                const kind = detectKind(
                    snap.basename,
                    parseFrontmatterBlock(snap.content).frontmatter.tags
                );
                if (kind === "archive") archiveSnaps.push(snap);
                else if (kind === "lesson_nav") navSnaps.push(snap);
                else otherSnaps.push(snap);
            }

            // 4. 写入顺序 = 归属链依赖顺序：档案 → nav → 其余
            //    （nav 的 archive_id 查映射需要档案已写；其余文件的 lesson_id 需要 nav 已写）
            const archiveFolders = new Set<string>();
            for (const s of archiveSnaps) {
                const stats = writer.upsertFile(s);
                if (stats.errors.length > 0) {
                    console.error("[XDF-Base] 增量写入失败（档案页）:", stats.errors);
                    for (const e of stats.errors) {
                        void appendDbLog(this.app, {
                            level: "error", source: "DB同步",
                            message: e.message, path: e.path,
                        });
                    }
                }
                archiveFolders.add(s.path.substring(0, s.path.lastIndexOf("/")));
            }
            for (const s of navSnaps) {
                const stats = writer.upsertFile(s);
                if (stats.errors.length > 0) {
                    console.error("[XDF-Base] 增量写入失败（nav）:", stats.errors);
                    for (const e of stats.errors) {
                        void appendDbLog(this.app, {
                            level: "error", source: "DB同步",
                            message: e.message, path: e.path,
                        });
                    }
                }
            }
            for (const s of otherSnaps) {
                const stats = writer.upsertFile(s);
                if (stats.errors.length > 0) {
                    console.error("[XDF-Base] 增量写入失败:", stats.errors);
                    for (const e of stats.errors) {
                        void appendDbLog(this.app, {
                            level: "error", source: "DB同步",
                            message: e.message, path: e.path,
                        });
                    }
                }
            }

            // 5. 安全网：档案页删除/重命名后旗下文件若没拿到独立事件
            //    （如外部同步改目录），按 vault 实际文件补齐重写（含 binary 附件）
            for (const folder of archiveFolders) {
                const children = this.app.vault
                    .getFiles()
                    .filter(f => f.path.startsWith(folder + "/") && !upsertPaths.has(f.path));
                for (const file of children) {
                    const snap = await this.snapshotOf(file);
                    writer.upsertFile(snap);
                }
            }

            await this.db.save();
        } catch (err) {
            console.error("[XDF-Base] DB 增量同步失败:", err);
            void appendDbLog(this.app, {
                level: "error",
                source: "DB同步",
                message: `增量同步失败：${String(err)}`,
            });
        } finally {
            this.flushing = false;
            // flush 期间又有事件进来 → 立即安排下一轮（仍受节流约束）
            if (this.pendingEvents.length > 0) {
                this.scheduleFlush();
            }
        }
    }

    private async snapshotOf(file: TFile): Promise<FileSnapshot> {
        const isMd = file.extension === "md";
        const content = isMd ? await this.app.vault.cachedRead(file) : "";
        return {
            path: file.path,
            basename: file.basename,
            content,
            mtime: Math.floor(file.stat.mtime / 1000),
            size: file.stat.size,
            binary: !isMd,
        };
    }

    private clearTimers(): void {
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.throttleTimer !== null) {
            window.clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        this.pendingEvents = [];
    }

    /**
     * 获取待处理事件数（用于状态显示）
     */
    getPendingCount(): number {
        return this.pendingEvents.length;
    }
}
