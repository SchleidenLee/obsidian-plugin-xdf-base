/**
 * ArchiveUtils 工具函数库
 * 释放到 00.SYSTEM/xdf_base/utils/ArchiveUtils.js
 *
 * 跨脚本共用：常量、frontmatter、选择器、课次包模板、档案回填。
 */

export const ARCHIVE_UTILS_SCRIPT = String.raw`/**
 * XDF ArchiveUtils — 跨脚本共用常量与函数
 */

// ========== 常量 ==========

const LESSON_TIME_SLOTS = ["10:00", "12:20", "15:30", "17:50", "20:10"];
const CLASS_TIME_SLOTS = ["10:00", "12:20", "15:30", "17:50"];

const SCHEDULE_TYPES = ["weekend (周末班)", "full-time (全日制)"];

const COURSE_TYPES = [
    "Foundation Grammar",
    "L1教材",
    "L1讲义",
    "L2教材",
    "L2讲义",
    "精讲精练"
];

const IELTS_COURSE_TYPES = ["L1教材", "L1讲义", "L2教材", "L2讲义", "精讲精练"];
const IELTS_SUBJECTS = ["Listening", "Speaking", "Reading", "Writing"];

const SUBJECT_LABELS = {
    Listening: "听力",
    Speaking: "口语",
    Reading: "阅读",
    Writing: "写作"
};

const TAGS = {
    ARCHIVE: "#档案",
    VIP: "#vip",
    CLASS: "#class",
    LESSON: "#课程记录"
};

// 统一格式常量（档案页索引标题 / nav frontmatter links 顺序：上一课 → 档案 → 下一课）
const INDEX_HEADER = "## 📚 课程索引";
const LINK_PREV = "⬅️ 上一课";
const LINK_ARCHIVE = "📁 档案首页";
const LINK_NEXT = "➡️ 下一课";

const STATUS_ACTIVE = "active";

const TIME_MODE_OPTIONS = ["🤖 自动识别（推荐）", "📅 手动选择"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ========== 基础 ==========

function qa() {
    const plugins = app.plugins.plugins;
    const p = plugins["xdf-base"] || plugins.quickadd;
    if (!p || !p.api) throw new Error("XDF-Base / QuickAdd 未加载");
    return p.api;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function stripQuotes(s) {
    return String(s).trim().replace(/^["']|["']$/g, "");
}

function joinPath(base, name) {
    return base ? base + "/" + name : name;
}

async function openFile(path, newLeaf) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file) await app.workspace.getLeaf(!!newLeaf).openFile(file);
    return file;
}

function loadUtilsCode() {
    return app.vault.adapter.read("00.SYSTEM/xdf_base/utils/ArchiveUtils.js");
}

// ========== 科目 / 文案 ==========

function isIELTSCourse(courseType) {
    return IELTS_COURSE_TYPES.includes(courseType);
}

function getSubjectLabel(subject) {
    if (!subject) return "";
    return SUBJECT_LABELS[subject] || subject;
}

/** Feedback 用：第N次阅读作业 */
function buildHomeworkLabel(lessonNumber, subject) {
    const label = getSubjectLabel(subject);
    return label
        ? "第" + lessonNumber + "次" + label + "作业"
        : "第" + lessonNumber + "次作业";
}

/** 导航页作业标题：3月15日第5次阅读作业 */
function buildNavHomeworkTitle(month, day, n, subject) {
    const label = getSubjectLabel(subject);
    const hw = label ? label + "作业" : "作业";
    return month + "月" + day + "日第" + n + "次" + hw;
}

function buildLessonFolderName(archiveName, lessonNumber) {
    return archiveName + " Lesson " + lessonNumber;
}

function getLessonFileNames(archiveName, lessonNumber) {
    return {
        nav: archiveName + " Lesson " + lessonNumber,
        note: "Note " + lessonNumber,
        wordlist: "Wordlist " + lessonNumber,
        grammar: "Grammar Note " + lessonNumber,
        homework: "Homework " + lessonNumber,
        quiz: "Quiz " + (lessonNumber + 1),
        feedback: "Feedback " + lessonNumber
    };
}

function yamlScalar(value) {
    if (value === null) return "null";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "string") {
        if (DATE_RE.test(value) || ISO_DT_RE.test(value)) return value;
        return JSON.stringify(value);
    }
    return JSON.stringify(value);
}

function buildFrontmatter(fields) {
    const lines = ["---"];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            lines.push(key + ":");
            for (const item of value) {
                lines.push("  - " + yamlScalar(item));
            }
        } else {
            lines.push(key + ": " + yamlScalar(value));
        }
    }
    lines.push("---", "");
    return lines.join("\n");
}

/**
 * 解析档案 YAML frontmatter（支持 tags / course_type 块列表和行内数组）
 */
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { meta: {}, tags: [], courseTypes: [], raw: "" };

    const raw = match[1];
    const meta = {};
    const tags = [];
    const courseTypes = [];
    let inTags = false;
    let inCourseType = false;

    function parseLine(line) {
        const idx = line.indexOf(":");
        if (idx <= 0) return null;
        return {
            key: line.substring(0, idx).trim(),
            value: line.substring(idx + 1).trim()
        };
    }

    for (const line of raw.split("\n")) {
        if (inTags) {
            if (line.trim().startsWith("- ")) {
                tags.push(stripQuotes(line.trim().substring(2)));
                continue;
            }
            inTags = false;
        }
        if (inCourseType) {
            if (line.trim().startsWith("- ")) {
                courseTypes.push(stripQuotes(line.trim().substring(2)));
                continue;
            }
            inCourseType = false;
        }
        if (!line.trim()) continue;

        const parsed = parseLine(line);
        if (parsed) {
            if (parsed.key === "tags") {
                const arrMatch = parsed.value.match(/^\[(.*)\]$/);
                if (arrMatch) {
                    tags.push.apply(tags, arrMatch[1].split(",").map(s => stripQuotes(s)).filter(Boolean));
                } else if (!parsed.value) {
                    inTags = true;
                }
            } else if (parsed.key === "course_type") {
                if (!parsed.value) inCourseType = true;
            } else {
                meta[parsed.key] = parsed.value === "null" ? null : stripQuotes(parsed.value);
            }
        } else if (line.trim() === "tags:") {
            inTags = true;
        } else if (line.trim() === "course_type:") {
            inCourseType = true;
        }
    }

    return { meta: meta, tags: tags, courseTypes: courseTypes, raw: raw };
}

function lastCourseType(parsed, fallback) {
    if (parsed.courseTypes && parsed.courseTypes.length > 0) {
        return parsed.courseTypes[parsed.courseTypes.length - 1];
    }
    return fallback || "";
}

function hasTag(tagList, tag) {
    const norm = String(tag).replace(/^#/, "");
    return (tagList || []).some(t => String(t).replace(/^#/, "") === norm);
}

/** 替换 total_lessons / last_date；日期无引号 */
function updateArchiveTimestamps(content, total, dateStr) {
    return content
        .replace(/(total_lessons:\s*)(\d+)/, "$1" + total)
        .replace(/(last_date:\s*)(null|[^\n]*)/, "$1" + dateStr);
}

function appendLinkBeforeDivider(content, header, link) {
    if (content.indexOf(link) !== -1) return content;
    const headerPos = content.indexOf(header);
    if (headerPos === -1) return content;
    const after = content.substring(headerPos);
    const dividerPos = after.indexOf("\n---");
    if (dividerPos === -1) return content;
    const insertPos = headerPos + dividerPos;
    return content.substring(0, insertPos) + "\n" + link + content.substring(insertPos);
}

function appendCourseTypeLine(content, courseType) {
    const line = "  - " + yamlScalar(courseType);
    const lines = content.split("\n");
    let lastIdx = -1;
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "course_type:") {
            inBlock = true;
            continue;
        }
        if (inBlock) {
            if (lines[i].trim().startsWith("- ")) {
                lastIdx = i;
            } else if (lines[i].trim() === "---" || (lines[i].trim() && !lines[i].trim().startsWith("-"))) {
                break;
            }
        }
    }
    if (lastIdx === -1) return content;
    lines.splice(lastIdx + 1, 0, line);
    return lines.join("\n");
}

/** 向 frontmatter 的 YAML 列表键（如 links:）末尾追加一项 */
function appendLinkListEntry(content, key, entry) {
    const lines = content.split("\n");
    const keyIdx = lines.findIndex(function (l) { return l.trim() === key + ":"; });
    if (keyIdx === -1) return content;
    let lastIdx = -1;
    for (let i = keyIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith("- ")) {
            lastIdx = i;
        } else if (t === "---" || t === "" || !t.startsWith("-")) {
            break;
        }
    }
    lines.splice(lastIdx === -1 ? keyIdx + 1 : lastIdx + 1, 0, "  - " + yamlScalar(entry));
    return lines.join("\n");
}

/** 档案页课程索引链接：一对一「第 N 课 - date」/ 班课「📖 Lesson N - date」 */
function buildIndexLink(kind, folderName, lessonNumber, dateStr) {
    const label = kind === "class"
        ? "📖 Lesson " + lessonNumber + " - " + dateStr
        : "第 " + lessonNumber + " 课 - " + dateStr;
    return "- [[" + folderName + "|" + label + "]]";
}

function insertNewCourseTypeBlock(content, courseType, link) {
    const indexPos = content.indexOf(INDEX_HEADER);
    if (indexPos === -1) return content;
    const endMarker = content.indexOf("## 📋 测试反馈", indexPos);
    const sectionEnd = endMarker !== -1 ? endMarker : content.length;
    const section = content.substring(indexPos, sectionEnd);
    const lastDiv = section.lastIndexOf("---");
    if (lastDiv === -1) return content;
    const insertPos = indexPos + lastDiv + 3;
    const block = "\n\n### 🏷️ " + courseType + "\n" + link + "\n\n---\n";
    return content.substring(0, insertPos) + block + content.substring(insertPos);
}

async function updateArchiveFrontmatter(archiveFile, partialFm) {
    const original = await app.vault.read(archiveFile);
    const parsed = parseFrontmatter(original);
    const merged = Object.assign({}, parsed.meta, partialFm);
    if (parsed.tags.length && merged.tags === undefined) merged.tags = parsed.tags;
    if (parsed.courseTypes.length && merged.course_type === undefined) merged.course_type = parsed.courseTypes;
    const bodyStart = original.indexOf("---", 3);
    const body = bodyStart > 0 ? original.substring(bodyStart + 3) : "\n";
    await app.vault.modify(archiveFile, buildFrontmatter(merged) + body);
}

function buildArchiveFrontmatterFields(opts) {
    const kindTag = opts.kind === "class" ? TAGS.CLASS : TAGS.VIP;
    const fields = {
        starting_date: opts.startingDate,
        schedule_type: opts.scheduleType,
        course_type: [opts.courseType]
    };
    if (opts.subject) fields.subject = opts.subject;
    fields.status = STATUS_ACTIVE;
    fields.total_lessons = 0;
    fields.last_date = null;
    if (opts.kind === "class") fields.student_count = opts.studentCount;
    fields.tags = [TAGS.ARCHIVE, kindTag];
    return fields;
}

function buildLessonNavFrontmatter(opts) {
    const kindTag = opts.kind === "class" ? TAGS.CLASS : TAGS.VIP;
    const links = [];
    if (opts.prevLessonFolderName) {
        links.push("[[" + opts.prevLessonFolderName + "|" + LINK_PREV + "]]");
    }
    links.push("[[" + opts.archiveName + "|" + LINK_ARCHIVE + "]]");
    const fields = {
        Date: opts.isoDate,
        lesson_number: opts.lessonNumber,
        archive_name: opts.archiveName,
        course_type: [opts.courseType]
    };
    if (opts.subject) fields.subject = opts.subject;
    fields.need_send_feedback = !!opts.needSendFeedback;
    fields.links = links;
    fields.tags = [TAGS.LESSON, kindTag];
    return fields;
}

// ========== 文件系统 ==========

function getAllFolders() {
    return app.vault.getAllLoadedFiles()
        .filter(f => f.children)
        .map(f => f.path)
        .filter(p => p !== "")
        .sort();
}

async function ensureFolder(path) {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing) return false;
    await app.vault.createFolder(path);
    return true;
}

async function ensureFolderWithConfirm(path, confirmMsg) {
    const existing = app.vault.getAbstractFileByPath(path);
    if (!existing) {
        await app.vault.createFolder(path);
        return "created";
    }
    if (confirmMsg && !confirm(confirmMsg)) throw new Error("用户取消操作");
    return "exists";
}

async function writeOrUpdateFile(path, content) {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing) {
        await app.vault.modify(existing, content);
        return "updated";
    }
    await app.vault.create(path, content);
    return "created";
}

async function writeIfNotExists(path, content) {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing) return "skipped";
    await app.vault.create(path, content);
    return "created";
}

async function resolveArchiveInFolder(folderPath) {
    const folderName = folderPath.split("/").pop();
    const preferred = joinPath(folderPath, folderName + ".md");
    let file = app.vault.getAbstractFileByPath(preferred);
    if (file) return file;

    const mdFiles = app.vault.getAllLoadedFiles()
        .filter(f => f.path.startsWith(folderPath + "/") && f.path.endsWith(".md") && !f.children)
        .map(f => f.path);

    if (mdFiles.length === 1) {
        return app.vault.getAbstractFileByPath(mdFiles[0]);
    }
    if (mdFiles.length > 1) {
        const picked = await qa().suggester(mdFiles, mdFiles, false, "检测到多个 Markdown 文件，请选择档案首页");
        if (!picked) throw new Error("未选择档案页");
        return app.vault.getAbstractFileByPath(picked);
    }
    throw new Error("在 \"" + folderPath + "\" 中未找到有效的档案页 (.md 文件)");
}

function getNextLessonNumber(folderPath) {
    const pattern = /Lesson\s*(\d+)/i;
    let max = 0;
    const subFolders = app.vault.getAllLoadedFiles()
        .filter(f => f.children && f.path.startsWith(folderPath + "/"))
        .map(f => f.path);
    for (const p of subFolders) {
        const m = p.match(pattern);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > max) max = n;
        }
    }
    return max + 1;
}

function parseStudentsFromTable(content) {
    const lines = content.split("\n");
    let tableStart = false;
    const students = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf("姓名") !== -1) {
            tableStart = true;
            continue;
        }
        if (tableStart) {
            if (!line.startsWith("|")) break;
            if (line.indexOf("---") !== -1) continue;
            const parts = line.split("|").map(function (x) { return x.trim(); });
            const name = parts[1];
            if (name && name !== "姓名") students.push({ name: name });
        }
    }
    return students;
}

function fileHasTags(file, requiredTags) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache || !cache.frontmatter) return false;
    const fmTags = cache.frontmatter.tags || [];
    const flat = cache.frontmatter.tag || "";
    const all = [].concat(fmTags).concat(flat ? [flat] : []);
    return requiredTags.every(function (tag) { return hasTag(all, tag); });
}

// ========== 选择器 ==========

async function pickTimeSlot(slots, placeholder) {
    const t = await qa().suggester(slots, slots, false, placeholder || "请选择时间");
    if (!t) throw new Error("必须选择时间");
    return t;
}

async function pickScheduleType(placeholder) {
    const raw = await qa().suggester(
        SCHEDULE_TYPES, SCHEDULE_TYPES, false,
        placeholder || "请选择上课频率"
    );
    if (!raw) throw new Error("未选择上课频率");
    return raw.split(" ")[0];
}

async function pickCourseType(placeholder) {
    const t = await qa().suggester(
        COURSE_TYPES, COURSE_TYPES, false,
        placeholder || "请选择课程体系"
    );
    if (!t) throw new Error("必须选择课程体系");
    return t;
}

async function pickCourseTypeWithDefault(defaultTag) {
    if (!defaultTag) {
        return { courseType: await pickCourseType(), isNew: true };
    }
    const otherOptions = COURSE_TYPES.filter(function (opt) { return opt !== defaultTag; });
    const tagOptions = ["默认 (" + defaultTag + ")"].concat(otherOptions);
    const selected = await qa().suggester(
        tagOptions, tagOptions, false,
        "请选择本节课所属的课程体系"
    );
    if (!selected) throw new Error("未选择课程体系");
    if (selected === "默认 (" + defaultTag + ")") {
        return { courseType: defaultTag, isNew: false };
    }
    return { courseType: selected, isNew: true };
}

async function pickSubjectIfIELTS(courseType) {
    if (!isIELTSCourse(courseType)) return null;
    const subject = await qa().suggester(
        IELTS_SUBJECTS, IELTS_SUBJECTS, false,
        "请选择科目（雅思课程）"
    );
    if (!subject) throw new Error("未选择科目");
    return subject;
}

async function pickTargetFolder(placeholder) {
    const all = getAllFolders();
    const options = ["(根目录)"].concat(all);
    const picked = await qa().suggester(
        options, options, false,
        placeholder || "选择存放位置"
    );
    if (!picked) throw new Error("未选择存放位置");
    return picked === "(根目录)" ? "" : picked;
}

async function pickFolder(placeholder, filterFn) {
    let folders = getAllFolders();
    if (typeof filterFn === "function") folders = folders.filter(filterFn);
    if (folders.length === 0) throw new Error("未找到可用文件夹");
    const picked = await qa().suggester(
        folders, folders, false,
        placeholder || "请选择文件夹"
    );
    if (!picked) throw new Error("未选择文件夹");
    return picked;
}

async function pickArchiveByKind(kind, placeholder) {
    const kindTag = kind === "class" ? TAGS.CLASS : TAGS.VIP;
    const files = app.vault.getMarkdownFiles();
    const candidates = [];
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.path.indexOf(".trash") !== -1) continue;
        if (fileHasTags(f, [TAGS.ARCHIVE, kindTag])) candidates.push(f);
    }
    if (candidates.length === 0) {
        new Notice("未找到 " + kindTag + " 档案，请先建档");
        return null;
    }
    const display = await qa().suggester(
        candidates.map(function (f) { return f.basename; }),
        candidates,
        false,
        placeholder || "请选择档案"
    );
    if (!display) return null;
    const content = await app.vault.read(display);
    return { name: display.basename, path: display.path, file: display, content: content };
}

// ========== 时间 ==========

function formatISO(date) {
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hours = pad2(date.getHours());
    const minutes = pad2(date.getMinutes());
    const seconds = pad2(date.getSeconds());
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const offsetH = pad2(Math.floor(Math.abs(offsetMinutes) / 60));
    const offsetM = pad2(Math.abs(offsetMinutes) % 60);
    return year + "-" + month + "-" + day + "T" + hours + ":" + minutes + ":" + seconds + sign + offsetH + ":" + offsetM;
}

function formatDateStr(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function getNearestSlotDate(slots) {
    const now = new Date();
    let nearest = null;
    let minDiff = Infinity;
    for (let i = 0; i < slots.length; i++) {
        const parts = slots[i].split(":");
        const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(parts[0], 10), parseInt(parts[1], 10), 0);
        const diff = Math.abs(now - candidate);
        if (diff < minDiff) {
            minDiff = diff;
            nearest = candidate;
        }
    }
    return nearest;
}

async function pickLessonTime(slots) {
    const mode = await qa().suggester(
        TIME_MODE_OPTIONS, TIME_MODE_OPTIONS, false,
        "请选择课程时间获取方式"
    );
    let date;
    if (!mode || mode === TIME_MODE_OPTIONS[0]) {
        date = getNearestSlotDate(slots);
    } else {
        const manualDate = await qa().datePrompt("请选择课程日期", { dateFormat: "YYYY-MM-DD" });
        if (!manualDate) throw new Error("未选择日期");
        const manualTime = await pickTimeSlot(slots, "请选择课程时间");
        date = new Date(manualDate + "T" + manualTime + ":00");
    }
    return {
        date: date,
        iso: formatISO(date),
        dateStr: formatDateStr(date),
        month: date.getMonth() + 1,
        day: date.getDate()
    };
}

async function pickStartingDate() {
    const d = await qa().datePrompt("请选择首课日期", { dateFormat: "YYYY-MM-DD" });
    if (!d) throw new Error("首课日期不能为空");
    if (d instanceof Date) return formatDateStr(d);
    const s = String(d);
    if (DATE_RE.test(s)) return s;
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return formatDateStr(parsed);
    return s.substring(0, 10);
}

// ========== 模板 ==========

function buildPersonFeedback(opts) {
    // 出勤/作业为单行 checkbox 组契约：源文件中每组保持单行（任意短标签 + 中文冒号 +
    // " | "分隔的 ≥2 个选项），保证 CodeMirror 几何安全；插件负责渲染为内联 checkbox，
    // DB 以 source='inline' 解析；全部默认不勾——勾选状态必须来自老师手动点击，杜绝模板默认值污染数据
    const lines = [
        "## 👤 " + opts.name,
        "",
        "",
        "### 原始记录",
        "#### 出勤",
        opts.month + "月" + opts.day + "日出勤情况：[ ] 正常 | [ ] 迟到 | [ ] 早退 | [ ] 线上课 | [ ] 请假",
        "",
        ""
    ];
    // 作业情况写上一课布置的作业（本课讲评的那份）；第 1 课没有上一课作业，不生成
    if (opts.lessonNumber > 1) {
        const homeworkLabel = buildHomeworkLabel(opts.lessonNumber - 1, opts.subject);
        lines.push(
            "#### 作业情况",
            homeworkLabel + "：[ ] 已完成 | [ ] 未完成",
            "",
            ""
        );
    }
    lines.push(
        "#### 入门测情况",
        "",
        "",
        "#### 课堂表现",
        "",
        "",
        "#### 掌握情况",
        "",
        "",
        "#### 需要加强",
        "",
        "",
        "### 反馈总结",
        "<!-- AI_GENERATED_START -->",
        "待生成",
        "",
        "<!-- AI_GENERATED_END -->",
        ""
    );
    return lines.join("\n");
}

function buildClassFeedback(students, opts) {
    return students.map(function (s) {
        const name = s.name || s;
        return buildPersonFeedback({
            name: name,
            lessonNumber: opts.lessonNumber,
            month: opts.month,
            day: opts.day,
            subject: opts.subject
        });
    }).join("\n");
}

function buildNav(opts) {
    const n = opts.lessonNumber;
    const names = getLessonFileNames(opts.archiveName, n);
    const fm = buildFrontmatter(buildLessonNavFrontmatter(opts));
    const navTitle = buildNavHomeworkTitle(opts.month, opts.day, n, opts.subject);
    const isClass = opts.kind === "class";

    const fileList = [
        "## 📂本节课文件",
        "- [[" + names.note + "|📝 课堂笔记]]",
        "- [[" + names.wordlist + "|📚 词汇表]]",
        "- [[" + names.grammar + "|📖 语法笔记]]",
        "- [[" + names.homework + "|✍️ 课后作业]]",
        "- [[" + names.quiz + "|📋 下节课入门测]]",
        "---"
    ].join("\n");

    let middle;
    if (isClass) {
        middle = [
            "## 📝 课堂反馈",
            "- [ ] 提交反馈",
            "- [[" + names.feedback + "|💬 课堂反馈]]",
            "",
            "### 授课内容",
            "",
            "",
            "",
            "### 原始记录",
            "",
            "",
            "",
            "#### 出勤",
            "",
            "",
            "",
            "#### 整体表现",
            "",
            "",
            "",
            "#### 作业情况",
            "",
            "",
            "",
            "#### 入门测情况",
            "",
            "",
            "",
            "#### 授课进度",
            "",
            "",
            "### 反馈总结",
            "<!-- AI_GENERATED_START -->",
            "待生成",
            "<!-- AI_GENERATED_END -->",
            "",
            "---"
        ].join("\n");
    } else {
        middle = [
            "## 📝 课堂反馈",
            "- [ ] 提交反馈",
            "- [[" + names.feedback + "|💬 课堂反馈]]",
            "### 授课内容",
            "",
            "---"
        ].join("\n");
    }

    const homeworkBlock = [
        "## ✍️作业记录",
        "",
        "- [ ] 发送作业到家长群",
        navTitle + "：",
        "",
        "",
        "---"
    ].join("\n");

    const nextBlock = [
        "",
        "## 📌 下次课提醒",
        "",
        "- [ ] 准备打印作业",
        "- [ ] 准备入门测",
        "",
        ""
    ].join("\n");

    return fm + fileList + "\n" + middle + "\n" + homeworkBlock + "\n" + nextBlock;
}

/**
 * 档案页正文（一对一/班课统一骨架）
 * opts: { kind, archiveName, students?, courseType, startingDate }
 * 差异仅两处：学员表行数；课程索引是否带课型子块
 */
function buildArchiveBody(opts) {
    const isClass = opts.kind === "class";
    const students = isClass ? (opts.students || []) : [opts.archiveName];
    const rows = students.map(function (name) {
        return "| " + name + " | | | | | | | | |";
    }).join("\n");

    let indexSection;
    if (isClass) {
        indexSection = [
            INDEX_HEADER,
            "<!-- 每次课后在这里增加课程链接 -->",
            "",
            ""
        ].join("\n");
    } else {
        indexSection = [
            INDEX_HEADER,
            "",
            "### 🏷️ " + opts.courseType,
            "- *暂无课程记录，等待生成第 1 课...*",
            ""
        ].join("\n");
    }

    return [
        "## 👥 学员信息",
        "",
        "| 姓名 | 学校 | 年级 | 英语程度 | 目标分数 | 已上课程 | 考试时间 | 考试成绩 | 备注 |",
        "|------|------|------|----------|----------|----------|----------|----------|------|",
        rows,
        "",
        "---",
        "",
        "## 📝 备注",
        "<!-- 在此记录班级注意事项 -->",
        "",
        "---",
        "",
        indexSection,
        "---",
        "",
        "## 📋 测试反馈",
        ""
    ].join("\n");
}

/**
 * 创建课次文件夹 + 7 个文件
 * opts.overwrite: true 覆盖已有文件（一对一）；false 已存在则跳过（班课）
 */
async function writeLessonPackage(opts) {
    const folderName = buildLessonFolderName(opts.archiveName, opts.lessonNumber);
    const folderPath = joinPath(opts.parentFolder, folderName);
    const names = getLessonFileNames(opts.archiveName, opts.lessonNumber);

    // 上一课 nav 存在时，frontmatter links 记入「⬅️ 上一课」
    if (!opts.prevLessonFolderName && opts.lessonNumber > 1) {
        const prevFolder = buildLessonFolderName(opts.archiveName, opts.lessonNumber - 1);
        const prevNavPath = joinPath(joinPath(opts.parentFolder, prevFolder),
            getLessonFileNames(opts.archiveName, opts.lessonNumber - 1).nav + ".md");
        if (app.vault.getAbstractFileByPath(prevNavPath)) {
            opts.prevLessonFolderName = prevFolder;
        }
    }

    if (opts.overwrite) {
        await ensureFolderWithConfirm(
            folderPath,
            "课程文件夹 \"" + folderPath + "\" 已存在，是否覆盖内部文件？"
        );
    } else {
        const created = await ensureFolder(folderPath);
        if (created) new Notice("📁 创建课程文件夹 " + folderName);
    }

    const nav = buildNav(opts);
    let feedback;
    if (opts.kind === "class") {
        feedback = buildClassFeedback(opts.students || [], opts);
    } else {
        feedback = buildPersonFeedback({
            name: opts.archiveName,
            lessonNumber: opts.lessonNumber,
            month: opts.month,
            day: opts.day,
            subject: opts.subject
        });
    }

    const files = [
        { name: names.nav, content: nav },
        { name: names.note, content: "" },
        { name: names.wordlist, content: "" },
        { name: names.grammar, content: "" },
        { name: names.homework, content: "" },
        { name: names.quiz, content: "" },
        { name: names.feedback, content: feedback }
    ];

    const writer = opts.overwrite ? writeOrUpdateFile : writeIfNotExists;
    for (let i = 0; i < files.length; i++) {
        const path = joinPath(folderPath, files[i].name + ".md");
        await writer(path, files[i].content);
    }

    return { folderName: folderName, folderPath: folderPath, names: names };
}

/** 上一课 nav 的 links 末尾追加「➡️ 下一课」 */
async function appendNextLessonLinkToPrev(archiveFile, lessonNumber) {
    if (lessonNumber <= 1) return;
    const prevFolderName = buildLessonFolderName(archiveFile.basename, lessonNumber - 1);
    const prevNavPath = joinPath(joinPath(archiveFile.parent.path, prevFolderName),
        getLessonFileNames(archiveFile.basename, lessonNumber - 1).nav + ".md");
    const prevFile = app.vault.getAbstractFileByPath(prevNavPath);
    if (!prevFile) return;
    const content = await app.vault.read(prevFile);
    const nextLink = "[[" + buildLessonFolderName(archiveFile.basename, lessonNumber) + "|" + LINK_NEXT + "]]";
    if (content.indexOf(nextLink) !== -1) return;
    await app.vault.modify(prevFile, appendLinkListEntry(content, "links", nextLink));
}

async function updateArchiveAfterLesson(opts) {
    const archiveFile = opts.archiveFile;
    let content = await app.vault.read(archiveFile);
    const link = opts.link;
    const n = opts.lessonNumber;
    const dateStr = opts.dateStr;

    if (opts.isNewCourseType) {
        content = appendCourseTypeLine(content, opts.courseType);
        content = insertNewCourseTypeBlock(content, opts.courseType, link);
    } else {
        content = appendLinkBeforeDivider(content, opts.indexHeader || INDEX_HEADER, link);
    }

    content = updateArchiveTimestamps(content, n, dateStr);
    await app.vault.modify(archiveFile, content);
    await appendNextLessonLinkToPrev(archiveFile, n);
}

// ========== 导出 ==========

module.exports = {
    LESSON_TIME_SLOTS,
    CLASS_TIME_SLOTS,
    SCHEDULE_TYPES,
    COURSE_TYPES,
    IELTS_COURSE_TYPES,
    IELTS_SUBJECTS,
    SUBJECT_LABELS,
    TAGS,
    INDEX_HEADER,
    STATUS_ACTIVE,
    TIME_MODE_OPTIONS,
    qa,
    pad2,
    stripQuotes,
    joinPath,
    openFile,
    loadUtilsCode,
    isIELTSCourse,
    getSubjectLabel,
    buildHomeworkLabel,
    buildNavHomeworkTitle,
    buildLessonFolderName,
    getLessonFileNames,
    yamlScalar,
    buildFrontmatter,
    parseFrontmatter,
    lastCourseType,
    hasTag,
    updateArchiveTimestamps,
    appendLinkBeforeDivider,
    appendLinkListEntry,
    appendCourseTypeLine,
    insertNewCourseTypeBlock,
    buildIndexLink,
    updateArchiveFrontmatter,
    buildArchiveFrontmatterFields,
    buildLessonNavFrontmatter,
    getAllFolders,
    ensureFolder,
    ensureFolderWithConfirm,
    writeOrUpdateFile,
    writeIfNotExists,
    resolveArchiveInFolder,
    getNextLessonNumber,
    parseStudentsFromTable,
    fileHasTags,
    pickTimeSlot,
    pickScheduleType,
    pickCourseType,
    pickCourseTypeWithDefault,
    pickSubjectIfIELTS,
    pickTargetFolder,
    pickFolder,
    pickArchiveByKind,
    formatISO,
    formatDateStr,
    getNearestSlotDate,
    pickLessonTime,
    pickStartingDate,
    buildPersonFeedback,
    buildClassFeedback,
    buildNav,
    buildArchiveBody,
    writeLessonPackage,
    updateArchiveAfterLesson
};
`;
