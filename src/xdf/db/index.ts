/**
 * 数据库 API 导出
 *
 * 暴露给 QuickAdd 脚本的 db API 入口：
 *   app.plugins.plugins["xdf-base"].api.db.query(...)
 *   app.plugins.plugins["xdf-base"].api.db.exec(...)
 *   app.plugins.plugins["xdf-base"].api.db.rebuild()
 *   app.plugins.plugins["xdf-base"].api.db.status()
 */

import type { App } from "obsidian";
import { DBConnection } from "./Connection";
import { DBBuilder } from "./Builder";
import { DBSync } from "./Sync";

export interface XdfDBApi {
    /** 执行 SQL（INSERT/UPDATE/DELETE/CREATE） */
    exec: (sql: string, params?: any[]) => void;
    /** 查询 SQL（SELECT），返回对象数组 */
    query: <T = Record<string, any>>(sql: string, params?: any[]) => T[];
    /** 全量重建数据库（清空 + 重新扫描） */
    rebuild: () => Promise<{ fileCount: number; durationMs: number; errors: any[] }>;
    /** 获取数据库状态 */
    status: () => {
        path: string;
        isOpen: boolean;
        isDirty: boolean;
        tableCount: number;
        tables: string[];
    };
    /** 启用/禁用事件监听 */
    setSyncEnabled: (enabled: boolean) => void;
    /** 是否正在监听 */
    isSyncEnabled: () => boolean;
}

/**
 * 创建暴露给脚本的 db API
 */
export function createDBApi(app: App, db: DBConnection, sync: DBSync): XdfDBApi {
    const builder = new DBBuilder(app, db);

    return {
        exec: (sql, params) => db.exec(sql, params),
        query: (sql, params) => db.query(sql, params),
        rebuild: async () => {
            const report = await builder.rebuild();
            await db.save();
            return {
                fileCount: report.fileCount,
                durationMs: report.durationMs,
                errors: report.errors
            };
        },
        status: () => db.getStatus(),
        setSyncEnabled: (enabled) => sync.setEnabled(enabled),
        isSyncEnabled: () => sync["enabled"]  // 访问 private 字段
    };
}

export { DBConnection, DBBuilder, DBSync };
