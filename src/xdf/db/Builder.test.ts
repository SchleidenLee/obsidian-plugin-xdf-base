/**
 * Builder 集成测试：sql.js 内存库 + Reference/current class 真实数据
 * 运行环境：WSL（singleThread，见 vitest.xdf.config.mts）
 */

import { describe, it, expect, beforeAll } from "vitest";
import initSqlJs from "sql.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaManager, type SqlDb } from "./Schema";
import { DBWriter, type FileSnapshot } from "./Builder";
import { detectKind, parseFrontmatterBlock } from "./Parser";

// ---------- sql.js 包装成 SqlDb ----------

class SqlJsAdapter implements SqlDb {
    constructor(public raw: any) {}
    exec(sql: string, params?: any[]): void {
        if (params && params.length > 0) {
            this.raw.run(sql, params); // 单条带参
        } else {
            this.raw.exec(sql); // 多语句 DDL / 无参
        }
    }
    query<T = Record<string, any>>(sql: string, params?: any[]): T[] {
        const stmt = this.raw.prepare(sql);
        try {
            if (params) stmt.bind(params);
            const rows: T[] = [];
            while (stmt.step()) rows.push(stmt.getAsObject() as T);
            return rows;
        } finally {
            stmt.free();
        }
    }
}

// ---------- 数据加载 ----------

const REFERENCE_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../Reference/current class"
);

function walkMd(dir: string, base: string, out: FileSnapshot[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkMd(full, base, out);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
            const stat = fs.statSync(full);
            out.push({
                path: path.relative(base, full).split(path.sep).join("/"),
                basename: entry.name.replace(/\.md$/, ""),
                content: fs.readFileSync(full, "utf-8"),
                mtime: Math.floor(stat.mtimeMs / 1000),
                size: stat.size,
            });
        }
    }
}

// ---------- 测试 ----------

describe("Builder 全量重建（真实 Reference 数据）", () => {
    let db: SqlJsAdapter;
    let stats: ReturnType<DBWriter["rebuildAll"]>;

    beforeAll(async () => {
        const SQL = await initSqlJs();
        db = new SqlJsAdapter(new SQL.Database());
        new SchemaManager(db).apply();
        const files: FileSnapshot[] = [];
        walkMd(REFERENCE_DIR, REFERENCE_DIR, files);
        stats = new DBWriter(db).rebuildAll(files);
    });

    it("档案数：18 班课 + 18 一对一 = 36", () => {
        expect(stats.errors).toEqual([]);
        expect(stats.archives).toBe(36);
        const kinds = db.query<{ kind: string; c: number }>(
            "SELECT kind, COUNT(*) c FROM archives GROUP BY kind"
        );
        const byKind = Object.fromEntries(kinds.map(k => [k.kind, k.c]));
        expect(byKind.vip).toBe(18);
        expect(byKind.class).toBe(18);
    });

    it("lessons：nav 全部入库，feedback_sent 来自勾选状态", () => {
        expect(stats.lessons).toBeGreaterThan(100);
        // 丁清扬 Lesson 1：提交反馈未勾选
        const l1 = db.query<{
            lesson_number: number; need_send_feedback: number; feedback_sent: number;
        }>(
            `SELECT l.lesson_number, l.need_send_feedback, l.feedback_sent
             FROM lessons l JOIN archives a ON a.id = l.archive_id
             WHERE a.name = '丁清扬' AND l.lesson_number = 1`
        );
        expect(l1).toHaveLength(1);
        expect(l1[0].need_send_feedback).toBe(1);
        expect(l1[0].feedback_sent).toBe(0);
    });

    it("原始记录可按 学生×维度 提取（核心查询）", () => {
        const rows = db.query<{ body: string }>(
            `SELECT s.body FROM sections s
             JOIN lessons l ON l.id = s.lesson_id
             JOIN archives a ON a.id = l.archive_id
             WHERE a.name = '丁清扬' AND l.lesson_number = 1
               AND s.heading_path LIKE '%原始记录%'`
        );
        expect(rows.length).toBeGreaterThan(0);
        // 父块（原始记录）应包含子块内容（出勤文字）
        const parent = rows.find(r => r.body.includes("按时出勤"));
        expect(parent).toBeTruthy();
    });

    it("checkboxes：task 双来源入库（提交反馈/发送作业）", () => {
        const cbs = db.query<{ item_text: string; checked: number; source: string }>(
            `SELECT c.item_text, c.checked, c.source FROM checkboxes c
             WHERE c.file_path LIKE '%丁清扬 Lesson 1%'`
        );
        const texts = cbs.map(c => c.item_text);
        expect(texts).toContain("提交反馈");
        expect(texts).toContain("发送作业到家长群");
        const sent = cbs.find(c => c.item_text === "发送作业到家长群");
        expect(sent?.checked).toBe(1);
        expect(cbs.every(c => c.source === "task" || c.source === "html")).toBe(true);
    });

    it("sections 全量切块且课次包文件挂 lesson_id", () => {
        expect(stats.sections).toBeGreaterThan(500);
        const note = db.query<{ heading_path: string }>(
            `SELECT s.heading_path FROM sections s
             WHERE s.file_path LIKE '%丁清扬 Lesson 1/Note 1%' AND s.lesson_id IS NOT NULL`
        );
        expect(note.length).toBeGreaterThan(0);
    });

    it("档案页自身切块入库（学员信息/课程索引等区块）", () => {
        // 档案页的 sections（拍板：档案页必须切块）
        const archiveSecs = db.query<{ heading_path: string; body: string }>(
            `SELECT s.heading_path, s.body FROM sections s
             JOIN archives a ON a.id = s.archive_id
             WHERE a.name = '3164' AND s.lesson_id IS NULL
               AND s.file_path = a.vault_path`
        );
        expect(archiveSecs.length).toBeGreaterThan(0);
        const paths = archiveSecs.map(s => s.heading_path);
        expect(paths.some(p => p.includes("学员信息"))).toBe(true);
        // 档案页在 files 表有登记行
        const frow = db.query<{ kind: string; archive_id: string; lesson_id: string | null }>(
            "SELECT kind, archive_id, lesson_id FROM files WHERE path = (SELECT vault_path FROM archives WHERE name = '3164')"
        );
        expect(frow).toHaveLength(1);
        expect(frow[0].kind).toBe("archive");
        expect(frow[0].lesson_id).toBeNull();
    });

    it("班课 roster 入库（class_roster）", () => {
        const roster = db.query<{ c: number }>(
            `SELECT COUNT(*) c FROM class_roster cr JOIN archives a ON a.id = cr.archive_id
             WHERE a.kind = 'class'`
        );
        expect(roster[0].c).toBeGreaterThan(50);
    });

    it("脏数据 other 只登记路径不入 sections", () => {
        const others = db.query<{ path: string }>(
            "SELECT path FROM files WHERE kind = 'other'"
        );
        if (others.length > 0) {
            const secCount = db.query<{ c: number }>(
                "SELECT COUNT(*) c FROM sections WHERE file_path = ?", [others[0].path]
            );
            expect(secCount[0].c).toBe(0);
        }
    });

    it("重复执行 rebuildAll 幂等（行数不翻倍）", { timeout: 120000 }, () => {
        const before = db.query<{ c: number }>("SELECT COUNT(*) c FROM lessons")[0].c;
        const files: FileSnapshot[] = [];
        walkMd(REFERENCE_DIR, REFERENCE_DIR, files);
        new DBWriter(db).rebuildAll(files);
        const after = db.query<{ c: number }>("SELECT COUNT(*) c FROM lessons")[0].c;
        expect(after).toBe(before);
    });

    // ========== 粒度回归（真实数据逐文件） ==========
    //
    // 背景：CRLF 文件曾因 HEADING_RE 失配整篇落进 level=0 兜底，
    // Feedback 页学员粒度静默丢失且无任何报错。此测试对真实数据
    // 逐文件断言「源文件里的每个标题，sections 里必须有一一对应的块」，
    // nav / 档案首页 / Feedback 页的完整粒度由此锁死。

    it("粒度回归：契约文件源标题与 sections 一一对应（含 CRLF）", { timeout: 120000 }, () => {
        const files: FileSnapshot[] = [];
        walkMd(REFERENCE_DIR, REFERENCE_DIR, files);
        const offenders: string[] = [];

        for (const f of files) {
            const fm = parseFrontmatterBlock(f.content);
            const kind = detectKind(f.basename, fm.frontmatter.tags);
            if (kind === "other") continue;

            // 源文件正文中的全部标题（归一化后匹配）
            const body = fm.body.replace(/\r\n?/g, "\n");
            const srcTitles = body.split("\n")
                .map(l => l.match(/^#{1,6}\s+(.*)$/))
                .filter((m): m is RegExpMatchArray => m !== null)
                .map(m => m[1].trim());
            if (srcTitles.length === 0) continue;

            const dbTitles = db.query<{ title: string }>(
                "SELECT title FROM sections WHERE file_path = ? AND level > 0",
                [f.path]
            ).map(r => r.title);

            for (const t of srcTitles) {
                if (!dbTitles.includes(t)) {
                    offenders.push(`${f.path} :: 缺标题块「${t}」`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("粒度回归：Feedback 页学员级原始记录可查（👤/原始记录）", { timeout: 120000 }, () => {
        // 源文件里存在 ## 👤 的 feedback 文件，库里必须能按 heading_path 查到原始记录
        const files: FileSnapshot[] = [];
        walkMd(REFERENCE_DIR, REFERENCE_DIR, files);
        const withStudents = files.filter(f => {
            const fm = parseFrontmatterBlock(f.content);
            if (detectKind(f.basename, fm.frontmatter.tags) !== "feedback") return false;
            return /^##\s+👤/m.test(fm.body.replace(/\r\n?/g, "\n"));
        });
        // Reference 数据必须真的含有学员结构化 Feedback，否则此测试无意义
        expect(withStudents.length).toBeGreaterThan(0);

        const missing: string[] = [];
        for (const f of withStudents) {
            const rows = db.query<{ c: number }>(
                "SELECT COUNT(*) c FROM sections WHERE file_path = ? AND heading_path LIKE '%/原始记录'",
                [f.path]
            );
            if (rows[0].c === 0) missing.push(f.path);
        }
        expect(missing).toEqual([]);
    });
});
