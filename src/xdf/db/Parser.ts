/**
 * 文件解析器（纯函数，不依赖 Obsidian）
 *
 * 三件事：
 * 1. kind 识别：tags（档案/课程记录）+ 文件名（课次包 7 文件）
 * 2. heading 切块：契约 kind 文件 → sections（无标题内容 level=0 兜底）
 * 3. checkbox 双来源：html input（正则）+ markdown task（调用方传解析结果）
 *
 * 输入全部为普通对象/字符串，可在 Vitest 直接测试。
 */

// ========== 类型 ==========

export type FileKind =
    | "archive"
    | "lesson_nav"
    | "note"
    | "wordlist"
    | "grammar"
    | "homework"
    | "quiz"
    | "feedback"
    | "binary"   // 非 md 附件（pdf/word/ppt 等）：仅登记路径+归属，不读内容
    | "other";

export interface HeadingInfo {
    level: number;          // 1-6
    text: string;           // 标题文字
    position: { start: number; end: number }; // 正文行区间 [start, end)
}

export interface TaskInfo {
    text: string;           // 任务文字（如 "提交反馈"）
    checked: boolean;
    position: { start: number; end: number }; // 所在行区间
}

export interface SectionDraft {
    heading_path: string;   // "父/子" 链；level=0 兜底为空串
    level: number;          // 0-6（0=无标题整篇）
    title: string;
    body: string;
    order_index: number;
}

export interface CheckboxDraft {
    section_path: string;
    item_text: string;
    checked: boolean;
    source: "html" | "task" | "inline";
    order_index: number;
}

export interface ParsedFile {
    kind: FileKind;
    sections: SectionDraft[];
    checkboxes: CheckboxDraft[];
    /** nav 专有：「- [x] 提交反馈」勾选状态 */
    feedbackSent: boolean | null;
}

// ========== 常量 ==========

const TAG_ARCHIVE = "档案";
const TAG_VIP = "vip";
const TAG_CLASS = "class";
const TAG_LESSON = "课程记录";

const FEEDBACK_SENT_TEXT = "提交反馈";

// 课次包文件名模式（档案名任意）：Note 3 / Wordlist 3 / Grammar Note 3 / Homework 3 / Quiz 4 / Feedback 3
const LESSON_FILE_PATTERNS: Array<{ kind: FileKind; re: RegExp }> = [
    { kind: "note", re: /^Note\s+\d+$/ },
    { kind: "wordlist", re: /^Wordlist\s+\d+$/ },
    { kind: "grammar", re: /^Grammar Note\s+\d+$/ },
    { kind: "homework", re: /^Homework\s+\d+$/ },
    { kind: "quiz", re: /^Quiz\s+\d+$/ },
    { kind: "feedback", re: /^Feedback\s+\d+$/ },
];

// HTML checkbox：<input type="checkbox" checked> 正常（选项文字不跨行）
const HTML_CHECKBOX_RE = /<input[^>]*type="checkbox"[^>]*>[^<\n]*/gi;
const HTML_CHECKED_RE = /\bchecked\b/;

// ========== 通用归一化 ==========

/**
 * 换行归一化：CRLF/CR → LF。
 * 必须在一切行级解析（frontmatter/heading/task）之前执行——
 * split("\n") 会给每行残留尾部 \r，而 JS 正则的 . 不匹配 \r、$ 只认字符串末尾，
 * 导致 HEADING_RE 全部失配（老数据/Windows 编辑器产出的文件会整篇落进 level=0 兜底）。
 * 注意 \r\n→\n 不改变行数，heading/task 的行号区间保持有效。
 */
export function normalizeEol(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

// ========== frontmatter（YAML 子集解析） ==========

export interface FrontmatterResult {
    frontmatter: Record<string, unknown>;
    body: string; // 不含 frontmatter 的正文
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 解析 YAML frontmatter 子集（顶层标量 + 块列表），失败/缺失返回空对象
 */
export function parseFrontmatterBlock(content: string): FrontmatterResult {
    content = normalizeEol(content);
    const m = content.match(FM_RE);
    if (!m) return { frontmatter: {}, body: content };
    const raw = m[1];
    const frontmatter: Record<string, unknown> = {};
    let currentListKey: string | null = null;

    for (const line of raw.split("\n")) {
        // 块列表项
        const itemMatch = line.match(/^\s+-\s+(.*)$/);
        if (itemMatch && currentListKey) {
            const arr = frontmatter[currentListKey];
            if (Array.isArray(arr)) arr.push(parseScalar(itemMatch[1]));
            continue;
        }
        // key: value
        const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (kv) {
            const key = kv[1];
            const value = kv[2];
            if (value === "") {
                frontmatter[key] = [];
                currentListKey = key;
            } else {
                frontmatter[key] = parseScalar(value);
                currentListKey = null;
            }
        } else if (line.trim() === "") {
            continue;
        } else {
            currentListKey = null;
        }
    }
    // 空数组字段保持 []（如 links 暂无内容）
    return { frontmatter, body: content.slice(m[0].length) };
}

function parseScalar(raw: string): unknown {
    const s = raw.trim();
    if (s === "" || s === "null" || s === "~") return null;
    if (s === "true") return true;
    if (s === "false") return false;
    // 引号包裹 → 字符串
    if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
    // 数字
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    return s;
}

// ========== markdown task 解析 ==========

const TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;

/**
 * 从正文提取 markdown task（「- [x] 提交反馈」）
 */
export function parseMarkdownTasks(body: string): TaskInfo[] {
    const tasks: TaskInfo[] = [];
    const lines = normalizeEol(body).split("\n");
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TASK_RE);
        if (m) {
            tasks.push({
                text: m[2].trim(),
                checked: m[1].toLowerCase() === "x",
                position: { start: i, end: i + 1 },
            });
        }
    }
    return tasks;
}

// ========== kind 识别 ==========

/**
 * 归一化 tags（接受 string | string[]，容忍 # 前缀；单字符串按空白拆分，
 * 兼容旧数据「tags: "#档案 #vip"」内联写法）
 */
export function normalizeTags(tags: unknown): string[] {
    if (!tags) return [];
    const arr = Array.isArray(tags) ? tags : String(tags).split(/\s+/);
    return arr.map(t => String(t).replace(/^#/, "").trim()).filter(Boolean);
}

/**
 * kind 识别：tags 优先（档案/课程记录），其次文件名（课次包），否则 other
 * @param basename 文件名（不含 .md）
 * @param tags frontmatter tags（已由 Obsidian 解析）
 */
export function detectKind(basename: string, tags: unknown): FileKind {
    const tagList = normalizeTags(tags);
    const has = (t: string) => tagList.includes(t);

    if (has(TAG_ARCHIVE) && (has(TAG_VIP) || has(TAG_CLASS))) return "archive";
    if (has(TAG_LESSON) && (has(TAG_VIP) || has(TAG_CLASS))) return "lesson_nav";
    for (const p of LESSON_FILE_PATTERNS) {
        if (p.re.test(basename)) return p.kind;
    }
    return "other";
}

/**
 * 契约 kind：切块 + 解析的范围（other/binary 仅记 files 行）
 */
export function isContractKind(kind: FileKind): boolean {
    return kind !== "other" && kind !== "binary";
}

// ========== heading 切块 ==========

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * 从正文提取 heading 结构（行号区间）
 */
export function parseHeadings(body: string): HeadingInfo[] {
    const lines = normalizeEol(body).split("\n");
    const headings: HeadingInfo[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(HEADING_RE);
        if (m) {
            headings.push({
                level: m[1].length,
                text: m[2].trim(),
                position: { start: i, end: lines.length }, // end 稍后回填
            });
        }
    }
    // 每个 heading 的区间延伸到下一个「同级或更高级」标题（父块包含子孙内容，
    // 查询「提取原始记录」时一个块的 body 即含出勤等全部子块）
    for (let i = 0; i < headings.length; i++) {
        let end = lines.length;
        for (let j = i + 1; j < headings.length; j++) {
            if (headings[j].level <= headings[i].level) {
                end = headings[j].position.start;
                break;
            }
        }
        headings[i].position.end = end;
    }
    return headings;
}

/**
 * heading 切块：
 * - 每个 heading 产生一条 section，body = 标题行到下一标题之间的内容（含子标题原文）
 * - heading_path = 各级父标题链（## 👤 张三 / ### 原始记录 / #### 出勤 → "👤 张三/原始记录/出勤"）
 * - 首个标题之前的内容 / 无标题全文 → level=0 兜底条
 */
export function splitSections(rawBody: string): SectionDraft[] {
    const body = normalizeEol(rawBody);
    const lines = body.split("\n");
    const headings = parseHeadings(body);
    const sections: SectionDraft[] = [];
    let order = 0;

    const push = (s: Omit<SectionDraft, "order_index">) => {
        sections.push({ ...s, order_index: order++ });
    };

    // 1. 无标题兜底：首标题前内容（无任何标题时为全文）
    const firstHeadingStart = headings.length ? headings[0].position.start : -1;
    const preambleLines = firstHeadingStart >= 0
        ? lines.slice(0, firstHeadingStart)
        : lines;
    const preamble = preambleLines.join("\n").trim();
    if (preamble) {
        push({ heading_path: "", level: 0, title: "", body: preamble });
    } else if (!headings.length && body.trim() === "" && lines.length > 0) {
        // 纯空文件：不入库（零字符）
    }

    // 2. 逐 heading 建块，维护父链
    const stack: Array<{ level: number; text: string }> = [];
    for (const h of headings) {
        while (stack.length && stack[stack.length - 1].level >= h.level) {
            stack.pop();
        }
        stack.push({ level: h.level, text: h.text });
        const block = lines.slice(h.position.start, h.position.end).join("\n");
        push({
            heading_path: stack.map(s => s.text).join("/"),
            level: h.level,
            title: h.text,
            body: block,
        });
    }

    return sections;
}

// ========== checkbox 解析 ==========

/**
 * HTML checkbox 解析（正则，source='html'）
 * 输入为 section body，输出该块内的所有 <input type="checkbox"> 项
 */
export function parseHtmlCheckboxes(
    body: string,
    sectionPath: string
): CheckboxDraft[] {
    const results: CheckboxDraft[] = [];
    let m: RegExpExecArray | null;
    HTML_CHECKBOX_RE.lastIndex = 0;
    let order = 0;
    while ((m = HTML_CHECKBOX_RE.exec(body)) !== null) {
        const full = m[0];
        // 选项文字：input 标签后的紧邻文本（同一行）
        const afterTag = full.replace(/<input[^>]*>/i, "").trim();
        const checked = HTML_CHECKED_RE.test(full);
        // 标签内 checked 与文字后 checked 都算（保守）；文字为空则跳过
        const text = afterTag.replace(/\bchecked\b/g, "").trim();
        if (!text) continue;
        results.push({
            section_path: sectionPath,
            item_text: text,
            checked,
            source: "html",
            order_index: order++,
        });
    }
    return results;
}

/**
 * markdown task 解析结果 → CheckboxDraft（source='task'）
 * 按行号区间归属所在 section（取包含该行的最深 section），
 * 不在任何 section 内（首标题前正文）→ 空串
 */
export function parseTaskCheckboxes(
    tasks: TaskInfo[],
    ranges: SectionWithRange[]
): CheckboxDraft[] {
    const results: CheckboxDraft[] = [];
    let order = 0;
    for (const t of tasks) {
        results.push({
            section_path: findDeepestSectionPath(ranges, t.position.start),
            item_text: t.text,
            checked: t.checked,
            source: "task",
            order_index: order++,
        });
    }
    return results;
}

// ========== 单行 checkbox 组（Feedback 新契约） ==========

// 组行：行首固定标签（出勤|作业）+ 中文冒号 + ` | ` 分隔的 checkbox 项
const INLINE_GROUP_RE = /^\s*(出勤|作业)：(.*)$/;
// 单项：[x]/[ ] + 空格 + 选项文字（文字不含竖线）
const INLINE_ITEM_RE = /^\[([ xX])\]\s*(.*)$/;

/**
 * 单行 checkbox 组解析（source='inline'）
 *
 * Feedback 文件的出勤/作业选项新契约：一行内 ` | ` 分隔多个 `[x] 选项`，
 * 行首无 `- ` 前缀，metadataCache.listItems 不识别，必须正则解析正文。
 * 例：`出勤：[x] 正常 | [ ] 迟到 | [ ] 早退`
 *
 * @param body   正文（不含 frontmatter；内部做 EOL 归一化，行号与 ranges 一致）
 * @param ranges splitSectionsWithRanges 的切块行号区间（section 归属判定）
 */
export function parseInlineCheckboxGroups(
    body: string,
    ranges: SectionWithRange[]
): CheckboxDraft[] {
    const results: CheckboxDraft[] = [];
    const lines = normalizeEol(body).split("\n");
    let order = 0;
    for (let i = 0; i < lines.length; i++) {
        const gm = lines[i].match(INLINE_GROUP_RE);
        if (!gm) continue;
        for (const rawItem of gm[2].split("|")) {
            const im = rawItem.trim().match(INLINE_ITEM_RE);
            if (!im) continue;
            const text = im[2].trim();
            if (!text) continue;
            results.push({
                section_path: findDeepestSectionPath(ranges, i),
                item_text: text,
                checked: im[1].toLowerCase() === "x",
                source: "inline",
                order_index: order++,
            });
        }
    }
    return results;
}

/**
 * 行号 → 最深 section 的 heading_path：
 * 父块区间包含子孙块（parseHeadings 的区间语义），命中多个时取 level 最深者
 */
export function findDeepestSectionPath(
    ranges: SectionWithRange[],
    line: number
): string {
    let best: SectionWithRange | null = null;
    for (const r of ranges) {
        if (line >= r.startLine && line < r.endLine) {
            if (!best || r.level > best.level) best = r;
        }
    }
    return best ? best.heading_path : "";
}

/**
 * 带 heading 行区间的切块（Builder 用于 task/checkbox 归属判定）
 */
export interface SectionWithRange extends SectionDraft {
    startLine: number; // 块起始行（level=0 为 0；heading 块为标题行）
    endLine: number;   // 块结束行（不含，parseHeadings 的区间语义）
}

export function splitSectionsWithRanges(body: string): SectionWithRange[] {
    const sections = splitSections(body);
    const headings = parseHeadings(body);
    const withRanges: SectionWithRange[] = [];
    let headingIdx = 0;
    for (const s of sections) {
        if (s.level === 0) {
            // level=0 兜底条：[0, 首标题行)；无标题全文时到末尾
            const firstHeading = headings.length ? headings[0].position.start : (body.split("\n").length);
            withRanges.push({ ...s, startLine: 0, endLine: firstHeading });
        } else {
            const h = headings[headingIdx++];
            withRanges.push({ ...s, startLine: h.position.start, endLine: h.position.end });
        }
    }
    return withRanges;
}

/**
 * 叶子块判定：没有其他 section 的 heading_path 以它为前缀（父块不解析 html checkbox）
 */
export function isLeafSection(sec: SectionDraft, all: SectionDraft[]): boolean {
    if (!sec.heading_path) return true;
    const prefix = sec.heading_path + "/";
    return !all.some(s => s !== sec && s.heading_path.startsWith(prefix));
}

/**
 * 完整解析一个文件
 * @param basename 文件名（不含扩展名）
 * @param tags frontmatter tags
 * @param content 正文（不含 frontmatter）
 * @param tasks markdown task 列表（调用方从 metadataCache.listItems 取；无则传 []）
 */
export function parseFile(
    basename: string,
    tags: unknown,
    content: string,
    tasks: TaskInfo[] = []
): ParsedFile {
    const kind = detectKind(basename, tags);
    if (kind === "other") {
        return { kind, sections: [], checkboxes: [], feedbackSent: null };
    }

    const sections = splitSections(content);

    // checkbox 双来源（html 只解析叶子块——父块 body 含子孙内容，重复解析会翻倍）
    const checkboxes: CheckboxDraft[] = [];
    for (const sec of sections) {
        if (!isLeafSection(sec, sections)) continue;
        checkboxes.push(...parseHtmlCheckboxes(sec.body, sec.heading_path));
    }
    // task → checkbox（按行号区间归属最深 section）
    // 单行 checkbox 组 → checkbox（Feedback 新契约，source='inline'，同按行号归属）
    const ranges = splitSectionsWithRanges(content);
    checkboxes.push(...parseTaskCheckboxes(tasks, ranges));
    checkboxes.push(...parseInlineCheckboxGroups(content, ranges));

    // nav 专有：提交反馈勾选
    let feedbackSent: boolean | null = null;
    if (kind === "lesson_nav") {
        const t = tasks.find(
            x => x.text.replace(/\s+/g, "") === FEEDBACK_SENT_TEXT
        );
        feedbackSent = t ? t.checked : false;
    }

    return { kind, sections, checkboxes, feedbackSent };
}
