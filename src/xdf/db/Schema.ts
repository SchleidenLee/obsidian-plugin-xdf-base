/**
 * 数据库 Schema 管理
 *
 * DDL 唯一权威来源：项目根目录「数据库模板.sql」（git 仓库外，防回溯丢失）。
 * 本文件内嵌同一份 DDL（esbuild 无法引用仓库外文件），两处必须保持一致，
 * 修改表结构时：先改模板 → 同步此处 → 递增 SCHEMA_VERSION 并写迁移。
 *
 * 职责：
 * 1. 建表（CREATE TABLE IF NOT EXISTS，幂等）
 * 2. 开启外键（PRAGMA foreign_keys 是 per-connection 的，clear() 重建后必须重执行）
 * 3. 版本管理（PRAGMA user_version）
 */

/** 结构化 SQL 接口：DBConnection 与测试用的 sql.js 包装均满足 */
export interface SqlDb {
    exec(sql: string, params?: any[]): void;
    query<T = Record<string, any>>(sql: string, params?: any[]): T[];
}

/** 当前 schema 版本，与数据库模板.sql 末尾的 PRAGMA user_version 一致 */
export const SCHEMA_VERSION = 1;

/** 数据库模板.sql 的内嵌副本（两处同步修改） */
export const SCHEMA_DDL = [
    // ---------- 实体层 ----------

    `CREATE TABLE IF NOT EXISTS students (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`,

    `CREATE TABLE IF NOT EXISTS archives (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    name          TEXT NOT NULL UNIQUE,
    student_id    TEXT REFERENCES students(id),
    subject       TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    status        TEXT NOT NULL,
    student_count INTEGER,
    course_types  TEXT NOT NULL,
    starting_date TEXT,
    last_date     TEXT,
    total_lessons INTEGER NOT NULL DEFAULT 0,
    vault_path    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_archives_student ON archives(student_id)`,

    `CREATE TABLE IF NOT EXISTS lessons (
    id                 TEXT PRIMARY KEY,
    archive_id         TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
    lesson_number      INTEGER NOT NULL,
    date               TEXT,
    subject            TEXT NOT NULL,
    course_types       TEXT NOT NULL,
    need_send_feedback INTEGER NOT NULL CHECK (need_send_feedback IN (0, 1)),
    feedback_sent      INTEGER NOT NULL DEFAULT 0 CHECK (feedback_sent IN (0, 1)),
    nav_path           TEXT NOT NULL,
    folder_path        TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (archive_id, lesson_number)
)`,

    `CREATE TABLE IF NOT EXISTS class_roster (
    archive_id   TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
    student_id   TEXT REFERENCES students(id),
    student_name TEXT NOT NULL,
    row_order    INTEGER NOT NULL,
    PRIMARY KEY (archive_id, row_order)
)`,

    // ---------- 内容层 ----------

    `CREATE TABLE IF NOT EXISTS sections (
    id           TEXT PRIMARY KEY,
    file_path    TEXT NOT NULL,
    archive_id   TEXT REFERENCES archives(id) ON DELETE CASCADE,
    lesson_id    TEXT REFERENCES lessons(id) ON DELETE CASCADE,
    heading_path TEXT NOT NULL,
    level        INTEGER NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    order_index  INTEGER NOT NULL,
    updated_at   TEXT NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_sections_file ON sections(file_path)`,
    `CREATE INDEX IF NOT EXISTS idx_sections_lesson ON sections(lesson_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sections_archive ON sections(archive_id)`,

    `CREATE TABLE IF NOT EXISTS files (
    path            TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    archive_id      TEXT,
    lesson_id       TEXT,
    frontmatter_json TEXT,
    mtime           INTEGER NOT NULL,
    size            INTEGER NOT NULL,
    synced_at       TEXT NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_files_archive ON files(archive_id)`,
    `CREATE INDEX IF NOT EXISTS idx_files_lesson ON files(lesson_id)`,

    `CREATE TABLE IF NOT EXISTS checkboxes (
    file_path    TEXT NOT NULL,
    section_path TEXT NOT NULL,
    item_text    TEXT NOT NULL,
    checked      INTEGER NOT NULL CHECK (checked IN (0, 1)),
    source       TEXT NOT NULL,
    order_index  INTEGER NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_checkboxes_file ON checkboxes(file_path)`,
].join(";\n") + ";";

export class SchemaManager {
    private db: SqlDb;

    constructor(db: SqlDb) {
        this.db = db;
    }

    /**
     * 应用 schema：建表（幂等）+ 版本迁移 + 开外键。
     * 在 Connection.initialize() 和 clear() 之后调用。
     */
    apply(): void {
        const current = this.getVersion();

        if (current === 0) {
            // 全新库：建表 + 标版本（SCHEMA_DDL 是 join 后的多语句字符串）
            this.db.exec(SCHEMA_DDL);
            this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (current < SCHEMA_VERSION) {
            // 已有旧库：跑增量迁移（当前无历史版本，预留）
            this.migrate(current);
        }
        // current === SCHEMA_VERSION：无需处理

        this.enableForeignKeys();
    }

    /**
     * 开启外键约束（per-connection，clear() 重建实例后必须重执行）
     */
    enableForeignKeys(): void {
        this.db.exec("PRAGMA foreign_keys = ON");
    }

    /**
     * 当前 schema 版本（0 = 空库）
     */
    getVersion(): number {
        // PRAGMA 结果需用 query 读
        const rows = this.db.query<{ user_version: number }>(
            "PRAGMA user_version"
        );
        return rows.length ? Number(rows[0].user_version) : 0;
    }

    /**
     * 增量迁移（预留：版本 1 之后加列/加表时在此追加步骤）
     */
    private migrate(from: number): void {
        // 示例：
        // if (from < 2) {
        //     this.db.exec("ALTER TABLE archives ADD COLUMN xxx TEXT");
        // }
        void from;
        this.enableForeignKeys();
    }
}
