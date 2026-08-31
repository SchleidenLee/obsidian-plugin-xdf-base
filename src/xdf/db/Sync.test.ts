/**
 * 增量同步测试：DBWriter.upsertFile / removeFile
 * 场景：modify（含打字→新 heading）、delete、rename、kind 升降级、档案页变更连带
 */

import { describe, it, expect, beforeAll } from "vitest";
import initSqlJs from "sql.js";

import { SchemaManager, type SqlDb } from "./Schema";
import { DBWriter, type FileSnapshot } from "./Builder";

class SqlJsAdapter implements SqlDb {
    constructor(public raw: any) {}
    exec(sql: string, params?: any[]): void {
        if (params && params.length > 0) {
            this.raw.run(sql, params);
        } else {
            this.raw.exec(sql);
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

// ---------- 测试数据 ----------

const ARCHIVE = `---
starting_date: 2026-06-27
schedule_type: weekend
course_type:
  - "中级讲义"
status: active
total_lessons: 2
last_date: null
tags:
  - "#档案"
  - "#vip"
subject: Reading
---

## 👥 学员信息

| 姓名 | 学校 | 年级 | 英语程度 | 目标分数 | 已上课程 | 考试时间 | 考试成绩 | 备注 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| 张三 | 某校 | 高二 | 中等 | 7 | L1 | 2026-12 | 6.5 | 无 |

## 📝 备注

首课学员

## 📚 课程索引

- [[张三 Lesson 1]]
`;

const NAV_L1 = `---
Date: 2026-06-27T12:20:00+08:00
lesson_number: 1
archive_name: "张三"
course_type:
  - "中级讲义"
need_send_feedback: true
links:
  - "[[张三|📁 档案首页]]"
  - "[[张三 Lesson 2|➡️ 下一课]]"
tags:
  - "#课程记录"
  - "#vip"
subject: Reading
---

## 📂本节课文件
- [[Note 1|📝 课堂笔记]]

## 📝 课堂反馈
- [ ] 提交反馈

## 授课内容

Lesson 1 填空题专项
`;

const NOTE_V1 = `# 笔记

## 词汇

appreciate

## 题型

填空题
`;

const NOTE_V2 = `# 笔记

## 词汇

appreciate
gratitude

## 题型

填空题

## 新增块

上课时补充的内容
`;

function snap(path: string, basename: string, content: string): FileSnapshot {
    return { path, basename, content, mtime: 1000, size: content.length };
}

// ---------- 测试 ----------

describe("增量同步 upsertFile / removeFile", () => {
    let db: SqlJsAdapter;
    let writer: DBWriter;

    beforeAll(async () => {
        const SQL = await initSqlJs();
        db = new SqlJsAdapter(new SQL.Database());
        new SchemaManager(db).apply();
        writer = new DBWriter(db);
        // 初始状态：档案 + nav + note
        writer.upsertFile(snap("张三/张三.md", "张三", ARCHIVE));
        writer.upsertFile(snap("张三/张三 Lesson 1/张三 Lesson 1.md", "张三 Lesson 1", NAV_L1));
        writer.upsertFile(snap("张三/张三 Lesson 1/Note 1.md", "Note 1", NOTE_V1));
    });

    it("初始增量写入：实体 + sections + 归属全部就位", () => {
        expect(db.query("SELECT * FROM archives WHERE name = '张三'")).toHaveLength(1);
        expect(db.query("SELECT * FROM lessons WHERE lesson_number = 1")).toHaveLength(1);
        // note 挂了 lesson_id + archive_id
        const note = db.query<{ archive_id: string; lesson_id: string }>(
            "SELECT archive_id, lesson_id FROM sections WHERE file_path LIKE '%Note 1%' LIMIT 1"
        );
        expect(note[0].archive_id).toBeTruthy();
        expect(note[0].lesson_id).toBeTruthy();
    });

    it("modify：Note 内容变化 → 只重写该文件行（上课记笔记场景）", () => {
        const before = {
            archives: db.query<{ c: number }>("SELECT COUNT(*) c FROM archives")[0].c,
            lessons: db.query<{ c: number }>("SELECT COUNT(*) c FROM lessons")[0].c,
            otherSecs: db.query<{ c: number }>(
                "SELECT COUNT(*) c FROM sections WHERE file_path NOT LIKE '%Note 1%'"
            )[0].c,
        };
        writer.upsertFile(snap("张三/张三 Lesson 1/Note 1.md", "Note 1", NOTE_V2));
        // 新增 heading → sections 变多
        const after = db.query<{ c: number }>(
            "SELECT COUNT(*) c FROM sections WHERE file_path LIKE '%Note 1%'"
        )[0].c;
        expect(after).toBe(4); // 词汇/题型/新增块 + level 0 兜底
        // 其他文件行未动（数量不变即未级联误删）
        expect(db.query<{ c: number }>("SELECT COUNT(*) c FROM archives")[0].c).toBe(before.archives);
        expect(db.query<{ c: number }>("SELECT COUNT(*) c FROM lessons")[0].c).toBe(before.lessons);
        expect(db.query<{ c: number }>(
            "SELECT COUNT(*) c FROM sections WHERE file_path NOT LIKE '%Note 1%'"
        )[0].c).toBe(before.otherSecs);
        // 新内容可查
        expect(
            db.query("SELECT * FROM sections WHERE heading_path LIKE '%新增块%'")
        ).toHaveLength(1);
    });

    it("modify：勾选提交反馈 → feedback_sent 更新", () => {
        const navChecked = NAV_L1.replace("- [ ] 提交反馈", "- [x] 提交反馈");
        writer.upsertFile(snap("张三/张三 Lesson 1/张三 Lesson 1.md", "张三 Lesson 1", navChecked));
        const l = db.query<{ feedback_sent: number }>(
            "SELECT feedback_sent FROM lessons WHERE lesson_number = 1"
        );
        expect(l[0].feedback_sent).toBe(1);
    });

    it("kind 降级：Note 改成脏格式 → other 只记路径；升回来恢复切块", () => {
        // 降级成 other（无 frontmatter 且 basename 不匹配任何契约 → other）
        writer.upsertFile(snap("张三/张三 Lesson 1/Note 1.md", "随手记", "随便写的自由文本"));
        const frow = db.query<{ kind: string }>("SELECT kind FROM files WHERE path LIKE '%Note 1%'");
        expect(frow[0].kind).toBe("other");
        // sections 行已清（other 不切块）
        expect(db.query(
            "SELECT * FROM sections WHERE file_path LIKE '%Note 1%'"
        )).toHaveLength(0);
        // 升级回来（重新写成 note——basename Note 1 命中契约）
        writer.upsertFile(snap("张三/张三 Lesson 1/Note 1.md", "Note 1", NOTE_V2));
        const frow2 = db.query<{ kind: string }>("SELECT kind FROM files WHERE path LIKE '%Note 1%'");
        expect(frow2[0].kind).toBe("note");
        expect(db.query(
            "SELECT * FROM sections WHERE file_path LIKE '%Note 1%'"
        ).length).toBeGreaterThan(0);
    });

    it("rename：旧路径删 + 新路径写（不产生幽灵行）", () => {
        writer.removeFile("张三/张三 Lesson 1/Note 1.md");
        writer.upsertFile(snap("张三/张三 Lesson 1/课堂笔记.md", "课堂笔记", NOTE_V2));
        expect(db.query("SELECT * FROM files WHERE path LIKE '%Note 1%'")).toHaveLength(0);
        expect(db.query("SELECT * FROM sections WHERE file_path LIKE '%Note 1%'")).toHaveLength(0);
        const frow = db.query<{ kind: string }>("SELECT kind FROM files WHERE path LIKE '%课堂笔记.md%'");
        expect(frow[0].kind).toBe("other"); // basename 变了不匹配契约 → other 登记路径
    });

    it("档案页 modify：原位更新，旗下数据零丢失（Bug 回归测试）", () => {
        const archiveIdBefore = db.query<{ id: string }>("SELECT id FROM archives WHERE name = '张三'")[0].id;
        const noteSecsBefore = db.query<{ c: number }>(
            "SELECT COUNT(*) c FROM sections WHERE file_path LIKE '%课堂笔记%'"
        )[0].c;
        const lessonsBefore = db.query<{ c: number }>("SELECT COUNT(*) c FROM lessons")[0].c;
        expect(lessonsBefore).toBe(1);

        // 改档案页（改备注 + frontmatter 字段）
        const archiveV2 = ARCHIVE.replace("首课学员", "首课学员（已更新备注）");
        writer.upsertFile(snap("张三/张三.md", "张三", archiveV2));

        // 档案实体原位更新：id 不变、行数不增
        const archiveRow = db.query<{ id: string }>("SELECT id FROM archives");
        expect(archiveRow).toHaveLength(1);
        expect(archiveRow[0].id).toBe(archiveIdBefore);
        // 旗下 Note 的 sections / lesson 实体零丢失（不删实体就不会触发级联）
        expect(db.query<{ c: number }>(
            "SELECT COUNT(*) c FROM sections WHERE file_path LIKE '%课堂笔记%'"
        )[0].c).toBe(noteSecsBefore);
        expect(db.query<{ c: number }>("SELECT COUNT(*) c FROM lessons")[0].c).toBe(lessonsBefore);
        // 档案页自身内容更新生效
        expect(db.query(
            "SELECT * FROM sections WHERE file_path = '张三/张三.md' AND body LIKE '%已更新备注%'"
        ).length).toBeGreaterThan(0);
        // 归属链完好：lesson 仍挂在该档案下
        const l = db.query<{ archive_id: string }>(
            "SELECT archive_id FROM lessons WHERE lesson_number = 1"
        );
        expect(l[0].archive_id).toBe(archiveIdBefore);
    });

    it("delete：删除 nav → lesson 实体 + 其 sections 级联清除", () => {
        writer.removeFile("张三/张三 Lesson 1/张三 Lesson 1.md");
        expect(db.query("SELECT * FROM lessons")).toHaveLength(0);
        expect(db.query(
            "SELECT * FROM sections WHERE file_path LIKE '%张三 Lesson 1.md%'"
        )).toHaveLength(0);
        // 档案实体不受影响
        expect(db.query("SELECT * FROM archives WHERE name = '张三'")).toHaveLength(1);
    });

    it("binary 附件：登记路径+归属，不切块不读内容", () => {
        // nav 已被上一测删除 → 先重写 nav（lesson 实体 + 课次文件夹映射就位）
        writer.upsertFile(snap("张三/张三 Lesson 1/张三 Lesson 1.md", "张三 Lesson 1", NAV_L1));

        // 课次文件夹下扔一个 pdf（归属映射基于当前库行）
        writer.upsertFile({
            path: "张三/张三 Lesson 1/讲义.pdf",
            basename: "讲义",
            content: "",
            mtime: 2000,
            size: 1024,
            binary: true,
        });
        const row = db.query<{ kind: string; archive_id: string | null; lesson_id: string | null; frontmatter_json: string | null; size: number }>(
            "SELECT kind, archive_id, lesson_id, frontmatter_json, size FROM files WHERE path LIKE '%讲义.pdf'"
        );
        expect(row).toHaveLength(1);
        expect(row[0].kind).toBe("binary");
        expect(row[0].archive_id).toBeTruthy();  // 归属档案
        expect(row[0].lesson_id).toBeTruthy();   // 归属课次
        expect(row[0].frontmatter_json).toBeNull();
        expect(row[0].size).toBe(1024);
        // 不产生 sections / checkboxes
        expect(db.query("SELECT * FROM sections WHERE file_path LIKE '%讲义.pdf'")).toHaveLength(0);
        expect(db.query("SELECT * FROM checkboxes WHERE file_path LIKE '%讲义.pdf'")).toHaveLength(0);

        // 归属验证：与档案实体 id 一致
        const archiveId = db.query<{ id: string }>("SELECT id FROM archives WHERE name = '张三'")[0].id;
        expect(row[0].archive_id).toBe(archiveId);

        // mtime 变更 → 原位更新（行数不增）
        writer.upsertFile({
            path: "张三/张三 Lesson 1/讲义.pdf",
            basename: "讲义",
            content: "",
            mtime: 3000,
            size: 2048,
            binary: true,
        });
        expect(db.query("SELECT * FROM files WHERE path LIKE '%讲义.pdf'")).toHaveLength(1);

        // 删除 → 行清
        writer.removeFile("张三/张三 Lesson 1/讲义.pdf");
        expect(db.query("SELECT * FROM files WHERE path LIKE '%讲义.pdf'")).toHaveLength(0);
    });

    it("removeFile：删除档案页 → 级联清空全部（终态干净）", () => {
        writer.removeFile("张三/张三.md");
        expect(db.query("SELECT * FROM archives")).toHaveLength(0);
        expect(db.query("SELECT * FROM lessons")).toHaveLength(0);
        expect(db.query("SELECT * FROM sections")).toHaveLength(0);
        expect(db.query("SELECT * FROM files")).toHaveLength(0);
        expect(db.query("SELECT * FROM checkboxes")).toHaveLength(0);
        // students 保留（跨档案实体，档案删除不清学生）
        expect(db.query("SELECT * FROM students").length).toBeGreaterThan(0);
    });
});
