/**
 * 数据库同步日志：写 vault 内 00.SYSTEM/Logs/ai-log.md
 *
 * 用途（设计稿第五节）：同步失败/解析失败留痕，便于排查"为什么这个文件没入库"。
 * 设计约束：
 * - 失败日志自身不允许再抛错（否则打断同步主流程）——内部全 try/catch
 * - 不 debounce 不排队：错误是低频事件，直接 append
 * - 文件不存在时自动创建（含标题行）
 */

import { App, TFile, normalizePath } from "obsidian";

const LOG_PATH = "00.SYSTEM/Logs/ai-log.md";
const LOG_HEADER = "# AI 日志";

export type DbLogLevel = "warn" | "error";

export interface DbLogEntry {
    level: DbLogLevel;
    /** 模块，如 "DB同步" / "DB重建" / "DB对账" */
    source: string;
    message: string;
    /** 相关文件路径（可选） */
    path?: string;
}

/**
 * 追加一条日志到 ai-log.md
 * 任何内部失败静默降级为 console.error，绝不影响调用方。
 */
export async function appendDbLog(app: App, entry: DbLogEntry): Promise<void> {
    try {
        const line = formatEntry(entry);
        const existing = app.vault.getAbstractFileByPath(LOG_PATH);
        if (existing instanceof TFile) {
            await app.vault.append(existing, line);
        } else {
            // 目录可能不存在，create 会自动建父目录
            await app.vault.create(
                normalizePath(LOG_PATH),
                `${LOG_HEADER}\n\n${line}`
            );
        }
    } catch (err) {
        console.error("[XDF-Base] 写 ai-log 失败（降级 console）:", err, entry);
    }
}

function formatEntry(entry: DbLogEntry): string {
    const icon = entry.level === "error" ? "❌" : "⚠️";
    const time = new Date().toISOString().replace("T", " ").substring(0, 19);
    const pathSuffix = entry.path ? `（${entry.path}）` : "";
    return `- ${icon} \`${time}\` **[${entry.source}]** ${entry.message}${pathSuffix}\n`;
}
