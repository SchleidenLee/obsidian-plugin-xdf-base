/**
 * 数据库 Builder：把解析结果写入数据库
 *
 * 纯逻辑层：不依赖 Obsidian（vault 读取由调用方完成），
 * 输入是「文件快照」数组，输出写入统计。Vitest 可直接测。
 *
 * 写库顺序（foreign_keys=ON 强制）：students → archives → lessons
 * → class_roster → sections/checkboxes/files。
 */

import type { App, TFile } from "obsidian";
import type { SqlDb } from "./Schema";
import { SchemaManager } from "./Schema";
import {
    detectKind,
    parseFrontmatterBlock,
    parseMarkdownTasks,
    splitSections,
    parseHtmlCheckboxes,
    isLeafSection,
    normalizeTags,
    type FileKind,
    type SectionDraft,
    type CheckboxDraft,
} from "./Parser";

// ========== 输入类型 ==========

/** 调用方提供的文件快照（vault 或测试数据） */
export interface FileSnapshot {
    path: string;            // vault 相对路径，如 "丁清扬/丁清扬 Lesson 1/Note 1.md"
    basename: string;        // 文件名不含扩展名
    content: string;         // 全文（含 frontmatter）
    mtime: number;
    size: number;
    /** 非 md 附件（pdf/word/ppt）：true 时只登记 files 行，不读内容 */
    binary?: boolean;
}

export interface BuildStats {
    fileCount: number;
    byKind: Record<string, number>;
    archives: number;
    lessons: number;
    students: number;
    sections: number;
    checkboxes: number;
    errors: Array<{ path: string; message: string }>;
}

// ========== 常量 ==========

const NOW = () => new Date().toISOString();

const SUBJECT_DEFAULT = "Reading"; // 契约：所有课程 subject=Reading，缺字段时兜底

// ========== Builder ==========

export class DBWriter {
    private db: SqlDb;
    /** 档案名 → archive id（课次归属判定） */
    private archiveIdByName = new Map<string, string>();
    /** 档案文件夹路径 → archive id（按父目录上溯做归属判定） */
    private archiveIdByFolder = new Map<string, string>();
    /** 课次文件夹路径 → lesson id（课次包归属判定） */
    private lessonIdByFolder = new Map<string, string>();
    /** 学生姓名 → student id */
    private studentIdByName = new Map<string, string>();

    constructor(db: SqlDb) {
        this.db = db;
    }

    // ========== 增量同步接口 ==========

    /**
     * 增量写入单个文件（modify/create/rename-to）：
     * 按路径级联删旧数据 → 按当前 kind 重新分派写入。
     * 档案页变更会连带重写旗下所有文件的归属（外键 archive_id 变化）。
     */
    upsertFile(f: FileSnapshot): BuildStats {
        const stats = this.newStats(1);
        // 归属映射预热：从现有库行重建（增量模式下不扫全 vault）
        this.loadOwnershipMaps();
        try {
            // binary（非 md 附件）：只登记 files 行（路径+归属），不读内容不切块
            if (f.binary) {
                this.deleteFileRows(f.path);
                this.writeBinaryFileRow(f);
                stats.byKind["binary"] = 1;
                return stats;
            }
            const kind = detectKind(f.basename, parseFrontmatterBlock(f.content).frontmatter.tags);
            stats.byKind[kind] = 1;
            if (kind === "archive") {
                // 原位更新：writeArchive 按 name upsert（ON CONFLICT(id) DO UPDATE），
                // 绝不能先删实体——FK 级联会误伤旗下所有 sections/lessons，
                // 且重插生成新 uuid 会让旗下 files 行的 archive_id 全部悬空。
                // 档案页「删除/重命名」走 removeFile（那里才删实体）。
                this.writeArchive(f);
                stats.archives = 1;
                const r = this.writeFileContent(f);
                stats.sections += r.sections;
                stats.checkboxes += r.checkboxes;
            } else if (kind === "lesson_nav") {
                this.writeLesson(f);
                stats.lessons = 1;
                const r = this.writeFileContent(f);
                stats.sections += r.sections;
                stats.checkboxes += r.checkboxes;
            } else {
                // other/契约内容文件：只动自己的行
                this.deleteFileRows(f.path);
                const r = this.writeFileContent(f);
                stats.sections += r.sections;
                stats.checkboxes += r.checkboxes;
            }
        } catch (err) {
            stats.errors.push({ path: f.path, message: String(err) });
        }
        return stats;
    }

    /**
     * 增量删除单个文件（delete/rename-from）：
     * 档案页删除 → 连档案实体；nav 删除 → 连 lesson 实体；其余 → 只删自身行。
     */
    removeFile(path: string): void {
        this.loadOwnershipMaps();
        const frow = this.db.query<{ kind: string }>("SELECT kind FROM files WHERE path = ?", [path]);
        const kindFromFiles = frow.length ? frow[0].kind : null;

        // 档案页：按路径识别（files 行可能在，也可能已丢——双保险）
        const archiveRow = this.db.query<{ id: string }>("SELECT id FROM archives WHERE vault_path = ?", [path]);
        if (archiveRow.length) {
            // 旗下文件的登记行 + checkbox 残留一并清（归属实体已删，孤儿行无意义；
            // checkboxes 无外键不级联，必须显式删）
            const folder = path.substring(0, path.lastIndexOf("/"));
            this.db.exec(
                "DELETE FROM files WHERE path = ? OR (archive_id = ? AND path LIKE ?)",
                [path, archiveRow[0].id, folder + "/%"]
            );
            this.db.exec("DELETE FROM checkboxes WHERE file_path LIKE ?", [folder + "/%"]);
            this.db.exec("DELETE FROM archives WHERE id = ?", [archiveRow[0].id]); // 级联 lessons/roster/sections
        }
        // nav：按路径识别
        const navRow = this.db.query<{ id: string }>("SELECT id FROM lessons WHERE nav_path = ?", [path]);
        if (navRow.length) {
            this.db.exec("DELETE FROM lessons WHERE id = ?", [navRow[0].id]); // 级联 sections
        }
        // 兜底：kind 判断（档案页/nav 行已删或缺失时，靠 files.kind）
        if (!archiveRow.length && !navRow.length && (kindFromFiles === "archive" || kindFromFiles === "lesson_nav")) {
            // 实体行不存在但 files 行在——直接清行即可
        }
        this.deleteFileRows(path);
    }

    /** 按路径删除文件自身派生行（sections/checkboxes/files） */
    private deleteFileRows(path: string): void {
        this.db.exec("DELETE FROM sections WHERE file_path = ?", [path]);
        this.db.exec("DELETE FROM checkboxes WHERE file_path = ?", [path]);
        this.db.exec("DELETE FROM files WHERE path = ?", [path]);
    }

    /** binary 文件登记行（路径+归属+mtime/size，无内容无 frontmatter） */
    private writeBinaryFileRow(f: FileSnapshot): void {
        const { archiveId, lessonId } = this.resolveOwnership(f.path);
        this.db.exec(
            `INSERT INTO files (path, kind, archive_id, lesson_id, frontmatter_json, mtime, size, synced_at)
             VALUES (?, 'binary', ?, ?, NULL, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET kind='binary', archive_id=excluded.archive_id,
                lesson_id=excluded.lesson_id, frontmatter_json=NULL,
                mtime=excluded.mtime, size=excluded.size, synced_at=excluded.synced_at`,
            [f.path, archiveId, lessonId, f.mtime, f.size, NOW()]
        );
    }

    /** 从库行预热归属映射（增量模式不扫全 vault） */
    private loadOwnershipMaps(): void {
        if (this.archiveIdByFolder.size > 0) return; // 已预热
        for (const a of this.db.query<{ id: string; name: string; vault_path: string }>(
            "SELECT id, name, vault_path FROM archives"
        )) {
            this.archiveIdByName.set(a.name, a.id);
            this.archiveIdByFolder.set(a.vault_path.substring(0, a.vault_path.lastIndexOf("/")), a.id);
        }
        for (const l of this.db.query<{ id: string; folder_path: string }>(
            "SELECT id, folder_path FROM lessons"
        )) {
            this.lessonIdByFolder.set(l.folder_path, l.id);
        }
    }

    private newStats(fileCount: number): BuildStats {
        return {
            fileCount, byKind: {}, archives: 0, lessons: 0, students: 0,
            sections: 0, checkboxes: 0, errors: [],
        };
    }

    /**
     * 全量重建入口：清空 → 写入全部快照 → 落库
     * 调用方保证 schema 已 apply（含 foreign_keys=ON）
     */
    rebuildAll(files: FileSnapshot[]): BuildStats {
        const stats: BuildStats = {
            fileCount: files.length,
            byKind: {},
            archives: 0,
            lessons: 0,
            students: 0,
            sections: 0,
            checkboxes: 0,
            errors: [],
        };

        // 1. 清空（按 FK 反序删）
        this.db.exec(
            "DELETE FROM checkboxes; DELETE FROM sections; DELETE FROM files; " +
            "DELETE FROM class_roster; DELETE FROM lessons; DELETE FROM archives; DELETE FROM students"
        );

        // 2. 第一遍：档案页（建 archives/students/class_roster，登记归属映射）
        //    第二遍：课次 nav（建 lessons，登记课次文件夹映射）
        //    第三遍：其余文件（sections/checkboxes/files）
        const pass1: FileSnapshot[] = [];
        const pass2: FileSnapshot[] = [];
        const pass3: FileSnapshot[] = [];
        for (const f of files) {
            const kind = f.binary ? "binary" : this.detectKindOf(f);
            stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
            if (kind === "archive") pass1.push(f);
            else if (kind === "lesson_nav") pass2.push(f);
            else pass3.push(f);
        }

        for (const f of pass1) {
            try {
                this.writeArchive(f);
                stats.archives++;
                // 档案页自身也切块入库（👥 学员信息/📝 备注/📚 课程索引/📋 测试反馈）
                // + files 行登记（拍板：档案页必须切块，有特殊查询需求）
                const r = this.writeFileContent(f);
                stats.sections += r.sections;
                stats.checkboxes += r.checkboxes;
            } catch (err) {
                stats.errors.push({ path: f.path, message: String(err) });
            }
        }
        for (const f of pass2) {
            try {
                this.writeLesson(f);
                stats.lessons++;
                // nav 自身也走内容入库（sections + checkboxes：提交反馈/发送作业等 task）
                const r = this.writeFileContent(f);
                stats.sections += r.sections;
                stats.checkboxes += r.checkboxes;
            } catch (err) {
                stats.errors.push({ path: f.path, message: String(err) });
            }
        }
        for (const f of pass3) {
            try {
                const r = this.writeFileContent(f);
                stats.sections += r.sections;
                stats.checkboxes += r.checkboxes;
            } catch (err) {
                stats.errors.push({ path: f.path, message: String(err) });
            }
        }
        stats.students = this.studentIdByName.size;
        return stats;
    }

    // ========== kind 判定（frontmatter 解析后走 Parser） ==========

    private detectKindOf(f: FileSnapshot): FileKind {
        const { frontmatter } = parseFrontmatterBlock(f.content);
        return detectKind(f.basename, frontmatter.tags);
    }

    // ========== 档案页 ==========

    private writeArchive(f: FileSnapshot): void {
        const { frontmatter, body } = parseFrontmatterBlock(f.content);
        const tags = normalizeTags(frontmatter.tags);
        const kind = tags.includes("vip") ? "vip" : "class";
        const name = f.basename; // 档案名 = 文件名

        // students：一对一挂主学生；班课从学员信息表提取
        let studentId: string | null = null;
        const roster: Array<{ name: string; order: number }> = [];

        if (kind === "vip") {
            studentId = this.upsertStudent(name);
        } else {
            const students = parseStudentsFromBody(body);
            students.forEach((s, i) => {
                roster.push({ name: s, order: i });
            });
        }

        // archives upsert（按 name 幂等）
        const existing = this.db.query<{ id: string }>(
            "SELECT id FROM archives WHERE name = ?", [name]
        );
        const id = existing.length ? existing[0].id : uuid();
        this.db.exec(
            `INSERT INTO archives (id, kind, name, student_id, subject, schedule_type, status,
                student_count, course_types, starting_date, last_date, total_lessons, vault_path, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, student_id=excluded.student_id,
                subject=excluded.subject, schedule_type=excluded.schedule_type, status=excluded.status,
                student_count=excluded.student_count, course_types=excluded.course_types,
                starting_date=excluded.starting_date, last_date=excluded.last_date,
                total_lessons=excluded.total_lessons, vault_path=excluded.vault_path,
                updated_at=excluded.updated_at`,
            [
                id, kind, name, studentId,
                String(frontmatter.subject ?? SUBJECT_DEFAULT),
                String(frontmatter.schedule_type ?? ""),
                String(frontmatter.status ?? "active"),
                frontmatter.student_count != null ? Number(frontmatter.student_count) : (kind === "class" ? roster.length : null),
                JSON.stringify(arrayOf(frontmatter.course_type)),
                frontmatter.starting_date ? String(frontmatter.starting_date) : null,
                frontmatter.last_date ? String(frontmatter.last_date) : null,
                frontmatter.total_lessons != null ? Number(frontmatter.total_lessons) : 0,
                f.path,
                NOW(),
            ]
        );
        this.archiveIdByName.set(name, id);
        this.archiveIdByFolder.set(f.path.substring(0, f.path.lastIndexOf("/")), id);

        // class_roster（先清后写，保持幂等）
        this.db.exec("DELETE FROM class_roster WHERE archive_id = ?", [id]);
        for (const r of roster) {
            const sid = this.upsertStudent(r.name);
            this.db.exec(
                "INSERT INTO class_roster (archive_id, student_id, student_name, row_order) VALUES (?, ?, ?, ?)",
                [id, sid, r.name, r.order]
            );
        }
    }

    // ========== 课次 nav ==========

    private writeLesson(f: FileSnapshot): void {
        const { frontmatter, body } = parseFrontmatterBlock(f.content);
        const archiveName = String(frontmatter.archive_name ?? "");
        const archiveId = this.archiveIdByName.get(archiveName);
        if (!archiveId) {
            throw new Error(`nav 的 archive_name "${archiveName}" 未找到对应档案页`);
        }
        const lessonNumber = Number(frontmatter.lesson_number ?? 0);
        if (!lessonNumber) throw new Error("nav 缺少 lesson_number");

        // feedback_sent：正文「- [x] 提交反馈」
        const tasks = parseMarkdownTasks(body);
        const feedbackTask = tasks.find(t => t.text.replace(/\s+/g, "") === "提交反馈");
        const feedbackSent = feedbackTask ? (feedbackTask.checked ? 1 : 0) : 0;

        // UNIQUE(archive_id, lesson_number) 冲突时 upsert（以文件内容为准）
        const existing = this.db.query<{ id: string }>(
            "SELECT id FROM lessons WHERE archive_id = ? AND lesson_number = ?",
            [archiveId, lessonNumber]
        );
        const id = existing.length ? existing[0].id : uuid();
        this.db.exec(
            `INSERT INTO lessons (id, archive_id, lesson_number, date, subject, course_types,
                need_send_feedback, feedback_sent, nav_path, folder_path, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(archive_id, lesson_number) DO UPDATE SET date=excluded.date,
                subject=excluded.subject, course_types=excluded.course_types,
                need_send_feedback=excluded.need_send_feedback, feedback_sent=excluded.feedback_sent,
                nav_path=excluded.nav_path, folder_path=excluded.folder_path,
                updated_at=excluded.updated_at`,
            [
                id, archiveId, lessonNumber,
                frontmatter.Date ? String(frontmatter.Date) : null,
                String(frontmatter.subject ?? SUBJECT_DEFAULT),
                JSON.stringify(arrayOf(frontmatter.course_type)),
                frontmatter.need_send_feedback ? 1 : 0,
                feedbackSent,
                f.path,
                f.path.substring(0, f.path.lastIndexOf("/")),
                NOW(),
            ]
        );
        this.lessonIdByFolder.set(f.path.substring(0, f.path.lastIndexOf("/")), id);
    }

    // ========== 其余文件（sections/checkboxes/files） ==========

    private writeFileContent(f: FileSnapshot): { sections: number; checkboxes: number } {
        // binary 附件：只登记 files 行（path+归属），不读内容不切块
        if (f.binary) {
            this.deleteFileRows(f.path);
            this.writeBinaryFileRow(f);
            return { sections: 0, checkboxes: 0 };
        }
        const { frontmatter, body } = parseFrontmatterBlock(f.content);
        const kind = detectKind(f.basename, frontmatter.tags);

        // 归属判定（软引用）：路径前缀匹配档案文件夹 / 课次文件夹
        const { archiveId, lessonId } = this.resolveOwnership(f.path);

        // files 行（契约与 other 都登记；other 只登记存在）
        this.db.exec(
            `INSERT INTO files (path, kind, archive_id, lesson_id, frontmatter_json, mtime, size, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, archive_id=excluded.archive_id,
                lesson_id=excluded.lesson_id, frontmatter_json=excluded.frontmatter_json,
                mtime=excluded.mtime, size=excluded.size, synced_at=excluded.synced_at`,
            [
                f.path, kind, archiveId, lessonId,
                JSON.stringify(frontmatter),
                f.mtime, f.size, NOW(),
            ]
        );

        if (kind === "other") return { sections: 0, checkboxes: 0 };

        // 先删旧派生行（幂等）
        this.db.exec("DELETE FROM sections WHERE file_path = ?", [f.path]);
        this.db.exec("DELETE FROM checkboxes WHERE file_path = ?", [f.path]);

        // sections
        const sections: SectionDraft[] = splitSections(body);
        let secCount = 0;
        for (const sec of sections) {
            this.db.exec(
                `INSERT INTO sections (id, file_path, archive_id, lesson_id, heading_path, level, title, body, order_index, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [uuid(), f.path, archiveId, lessonId, sec.heading_path, sec.level, sec.title, sec.body, sec.order_index, NOW()]
            );
            secCount++;
        }

        // checkboxes：html（叶子块）+ task
        let cbCount = 0;
        for (const sec of sections) {
            if (!isLeafSection(sec, sections)) continue;
            const items = parseHtmlCheckboxes(sec.body, sec.heading_path);
            for (const item of items) {
                this.insertCheckbox(f.path, item, cbCount++);
            }
        }
        for (const t of parseMarkdownTasks(body)) {
            this.insertCheckbox(f.path, {
                section_path: "", // task 归属行号在纯函数层不做，正文级即可查
                item_text: t.text,
                checked: t.checked,
                source: "task",
                order_index: 0,
            }, cbCount++);
        }

        return { sections: secCount, checkboxes: cbCount };
    }

    private insertCheckbox(path: string, item: CheckboxDraft, order: number): void {
        this.db.exec(
            "INSERT INTO checkboxes (file_path, section_path, item_text, checked, source, order_index) VALUES (?, ?, ?, ?, ?, ?)",
            [path, item.section_path, item.item_text, item.checked ? 1 : 0, item.source, order]
        );
    }

    // ========== 归属判定 ==========

    /**
     * 归属判定（软引用）：课次文件夹精确匹配 → 档案文件夹逐级上溯 → 双 NULL
     */
    private resolveOwnership(path: string): { archiveId: string | null; lessonId: string | null } {
        let folder = path.substring(0, path.lastIndexOf("/"));
        // 逐级上溯：课次文件夹 → 档案文件夹（嵌套目录结构下依然成立）
        while (folder) {
            const lessonId = this.lessonIdByFolder.get(folder);
            if (lessonId) {
                const l = this.db.query<{ archive_id: string }>(
                    "SELECT archive_id FROM lessons WHERE id = ?", [lessonId]
                );
                return { archiveId: l.length ? l[0].archive_id : null, lessonId };
            }
            const archiveId = this.archiveIdByFolder.get(folder);
            if (archiveId) return { archiveId, lessonId: null };
            const idx = folder.lastIndexOf("/");
            folder = idx === -1 ? "" : folder.substring(0, idx);
        }
        return { archiveId: null, lessonId: null };
    }

    // ========== students ==========

    private upsertStudent(name: string): string {
        const existing = this.studentIdByName.get(name);
        if (existing) return existing;
        const rows = this.db.query<{ id: string }>(
            "SELECT id FROM students WHERE name = ?", [name]
        );
        const id = rows.length ? rows[0].id : uuid();
        this.db.exec(
            `INSERT INTO students (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`,
            [id, name, NOW(), NOW()]
        );
        this.studentIdByName.set(name, id);
        return id;
    }
}

// ========== vault 扫描 ==========

/** 跳过的目录（系统/垃圾目录不扫描） */
const SKIP_DIRS = new Set([".obsidian", ".trash", ".xdf"]);

/** 跳过的扩展名（二进制大文件登记无意义或属系统文件） */
const SKIP_EXTS = new Set(["tmp", "log", "crdownload", "part"]);

/**
 * 扫描 vault 全部文件为 FileSnapshot（数据库同步的采集层）
 * md 全文读取；非 md（pdf/word/ppt 等）标记 binary 只登记路径+归属
 */
export async function collectVaultFiles(app: App): Promise<FileSnapshot[]> {
    const files: FileSnapshot[] = [];
    for (const file of app.vault.getFiles() as TFile[]) {
        // getFiles 含隐藏目录文件，过滤系统目录
        if (file.path.split("/").some(seg => SKIP_DIRS.has(seg))) continue;
        if (SKIP_EXTS.has(file.extension.toLowerCase())) continue;
        if (file.extension === "md") {
            const content = await app.vault.cachedRead(file);
            files.push({
                path: file.path,
                basename: file.basename,
                content,
                mtime: Math.floor(file.stat.mtime / 1000),
                size: file.stat.size,
            });
        } else {
            files.push({
                path: file.path,
                basename: file.basename,
                content: "",
                mtime: Math.floor(file.stat.mtime / 1000),
                size: file.stat.size,
                binary: true,
            });
        }
    }
    return files;
}

/**
 * 全量重建便捷入口：扫描 vault → schema 应用 → 写库（插件侧调用）
 */
export async function rebuildDatabase(app: App, db: SqlDb): Promise<BuildStats> {
    new SchemaManager(db).apply();
    const files = await collectVaultFiles(app);
    return new DBWriter(db).rebuildAll(files);
}

// ========== 工具 ==========

function uuid(): string {
    // crypto.randomUUID 在 Electron/Node 20+ 均可用
    return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function arrayOf(v: unknown): unknown[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

/**
 * 从档案页正文「学员信息」表格提取学生姓名（班课）
 */
function parseStudentsFromBody(body: string): string[] {
    const lines = body.split("\n");
    const students: string[] = [];
    let inTable = false;
    for (const line of lines) {
        if (line.includes("姓名")) {
            inTable = true;
            continue;
        }
        if (!inTable) continue;
        if (!line.trim().startsWith("|")) break;      // 表格结束
        if (/^\|[\s:-]+\|/.test(line)) continue;      // 分隔行
        const cells = line.split("|").map(c => c.trim());
        // | name | ... | → split 后首尾为空串，name 在 index 1
        const name = cells[1];
        if (name && name !== "姓名") students.push(name);
    }
    return students;
}
