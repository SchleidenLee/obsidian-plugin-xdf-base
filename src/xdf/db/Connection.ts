/**
 * sql.js 数据库连接管理
 *
 * 职责：
 * 1. 从 .xdf/xdf.db 加载现有数据库（如果存在）
 * 2. 在内存里维护一个 SQL.Database 实例
 * 3. 提供 exec / query / save 接口
 * 4. 关闭时自动保存到磁盘
 *
 * sql.js 初始化是异步的（需要加载 WASM），所以 Connection 类的所有
 * 操作都需在 init() 完成后才能调用。
 */

import type { App } from "obsidian";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
// esbuild binary loader 把 wasm 内联进 main.js，运行时零外部依赖
import wasmBinary from "sql.js/dist/sql-wasm.wasm";

/**
 * 数据库状态
 */
export interface DBStatus {
    path: string;
    isOpen: boolean;
    isDirty: boolean;
    tableCount: number;
    tables: string[];
}

/**
 * 数据库连接包装器
 *
 * 注意：schema 暂不定义具体表结构，由调用方在 initialize() 后通过 exec() 创建。
 */
export class DBConnection {
    private app: App;
    private dbPath: string;
    private SQL: SqlJsStatic | null = null;
    private database: Database | null = null;
    private dirty: boolean = false;
    private initialized: boolean = false;

    constructor(app: App, dbPath: string = ".xdf/xdf.db") {
        this.app = app;
        this.dbPath = dbPath;
    }

    /**
     * 初始化数据库连接
     * - 加载 sql.js WASM
     * - 如果 .xdf/xdf.db 存在 → 加载
     * - 如果不存在 → 创建空数据库
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        // 1. 初始化 sql.js（wasm 二进制已内联）
        this.SQL = await initSqlJs({ wasmBinary });

        // 2. 确保 .xdf 目录存在
        const adapter = this.app.vault.adapter;
        const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf("/"));
        if (dir && !(await adapter.exists(dir))) {
            await adapter.mkdir(dir);
        }

        // 3. 加载或创建数据库
        const SQL = this.SQL;
        if (!SQL) {
            throw new Error("sql.js 初始化失败");
        }
        if (await adapter.exists(this.dbPath)) {
            const buffer = await adapter.readBinary(this.dbPath);
            this.database = new SQL.Database(new Uint8Array(buffer));
        } else {
            this.database = new SQL.Database();
            await this.save();
        }

        this.initialized = true;
    }

    /**
     * 执行 SQL（INSERT/UPDATE/DELETE/CREATE 等）
     */
    exec(sql: string, params?: any[]): void {
        this.ensureOpen();
        try {
            if (params) {
                const stmt = this.database!.prepare(sql);
                stmt.run(params);
                stmt.free();
            } else {
                this.database!.exec(sql);
            }
            this.dirty = true;
        } catch (err) {
            throw new Error(`SQL 执行失败: ${sql}\n${err}`);
        }
    }

    /**
     * 查询 SQL（SELECT），返回对象数组
     */
    query<T = Record<string, any>>(sql: string, params?: any[]): T[] {
        this.ensureOpen();
        const results: T[] = [];
        const stmt = this.database!.prepare(sql);
        try {
            stmt.bind(params || []);
            while (stmt.step()) {
                results.push(stmt.getAsObject() as T);
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    /**
     * 显式保存到磁盘
     */
    async save(): Promise<void> {
        this.ensureOpen();
        if (!this.dirty) return;

        const data = this.database!.export();
        const adapter = this.app.vault.adapter;

        // 确保目录存在
        const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf("/"));
        if (dir && !(await adapter.exists(dir))) {
            await adapter.mkdir(dir);
        }

        // writeBinary 在最新 obsidian 声明里接受 ArrayBuffer；sql.js 返回 Uint8Array<ArrayBuffer>。
        // 直接传入即可（Uint8Array 自身拥有 ArrayBuffer，类型擦除后兼容）。
        await adapter.writeBinary(this.dbPath, data as unknown as ArrayBuffer);
        this.dirty = false;
    }

    /**
     * 关闭数据库连接（自动保存）
     */
    async close(): Promise<void> {
        if (this.database) {
            await this.save();
            this.database.close();
            this.database = null;
            this.initialized = false;
        }
    }

    /**
     * 清空所有表（用于重建）
     */
    async clear(): Promise<void> {
        this.ensureOpen();
        if (!this.SQL) {
            throw new Error("sql.js 未初始化");
        }
        const SQL = this.SQL;
        // 关闭旧连接
        this.database!.close();
        // 创建新连接
        this.database = new SQL.Database();
        this.dirty = true;
        await this.save();
    }

    /**
     * 获取数据库状态信息
     */
    getStatus(): DBStatus {
        this.ensureOpen();
        let tables: string[] = [];
        let tableCount = 0;
        try {
            const result = this.query<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            );
            tables = result.map(r => r.name);
            tableCount = tables.length;
        } catch {
            // 数据库刚创建时可能没表
        }

        return {
            path: this.dbPath,
            isOpen: this.initialized,
            isDirty: this.dirty,
            tableCount,
            tables
        };
    }

    /**
     * 获取原始 Database 对象（高级用法，慎用）
     */
    getRawDatabase(): Database | null {
        return this.database;
    }

    private ensureOpen(): void {
        if (!this.initialized || !this.database) {
            throw new Error("数据库未初始化，请先调用 initialize()");
        }
    }
}
