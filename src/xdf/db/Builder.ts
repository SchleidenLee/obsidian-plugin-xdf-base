/**
 * 数据库全量重建器
 *
 * 职责：
 * 1. 遍历 vault 所有 markdown 文件
 * 2. 解析 frontmatter 和正文
 * 3. 重新填充所有表
 *
 * 注意：schema 暂未定义，本类目前只做骨架。后续添加表时，在这里实现具体的
 * 重建逻辑（每个表一个函数）。
 */

import type { App } from "obsidian";
import { DBConnection } from "./Connection";

export class DBBuilder {
    private app: App;
    private db: DBConnection;

    constructor(app: App, db: DBConnection) {
        this.app = app;
        this.db = db;
    }

    /**
     * 全量重建：清空 → 遍历 → 填充
     */
    async rebuild(): Promise<RebuildReport> {
        const startTime = Date.now();
        const report: RebuildReport = {
            fileCount: 0,
            tableStats: {
                totalTables: 0,
                tables: []
            },
            durationMs: 0,
            errors: []
        };

        try {
            // 1. 清空
            await this.db.clear();

            // 2. 遍历所有 .md 文件
            const files = this.app.vault.getMarkdownFiles();
            report.fileCount = files.length;

            for (const file of files) {
                try {
                    await this.indexFile(file);
                } catch (err) {
                    report.errors.push({
                        file: file.path,
                        message: String(err)
                    });
                }
            }

            // 3. 收集统计
            const status = this.db.getStatus();
            report.tableStats = {
                totalTables: status.tableCount,
                tables: status.tables
            };
        } catch (err) {
            report.errors.push({
                file: "<rebuild>",
                message: String(err)
            });
        }

        report.durationMs = Date.now() - startTime;
        return report;
    }

    /**
     * 索引单个文件
     * 后续可在此处添加：解析 frontmatter、识别档案页/课程页、插入对应表
     */
    private async indexFile(file: any): Promise<void> {
        // 骨架实现：什么都不做
        // 后续根据 schema 添加具体逻辑
        // 例如：
        //   const cache = this.app.metadataCache.getFileCache(file);
        //   if (isArchivePage(cache.frontmatter)) {
        //       this.indexArchive(file, cache);
        //   }
    }
}

export interface RebuildReport {
    fileCount: number;
    tableStats: {
        totalTables: number;
        tables: string[];
    };
    durationMs: number;
    errors: Array<{ file: string; message: string }>;
}
