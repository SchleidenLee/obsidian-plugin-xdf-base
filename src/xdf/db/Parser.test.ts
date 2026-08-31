import { describe, it, expect } from "vitest";
import {
    detectKind,
    normalizeTags,
    splitSections,
    parseHtmlCheckboxes,
    parseFrontmatterBlock,
    parseFile,
} from "./Parser";

// ========== kind 识别 ==========

describe("detectKind", () => {
    it("档案页：#档案 + #vip/#class", () => {
        expect(detectKind("3164", ["#档案", "#vip"])).toBe("archive");
        expect(detectKind("3422", ["#档案", "#class"])).toBe("archive");
        expect(detectKind("丁清扬", ["档案", "vip"])).toBe("archive");
    });

    it("课次 nav：#课程记录 + #vip/#class", () => {
        expect(detectKind("3164 Lesson 5", ["#课程记录", "#class"])).toBe("lesson_nav");
    });

    it("课次包文件按文件名识别（无 tags）", () => {
        expect(detectKind("Note 3", [])).toBe("note");
        expect(detectKind("Wordlist 12", [])).toBe("wordlist");
        expect(detectKind("Grammar Note 5", [])).toBe("grammar");
        expect(detectKind("Homework 5", [])).toBe("homework");
        expect(detectKind("Quiz 6", [])).toBe("quiz");
        expect(detectKind("Feedback 5", [])).toBe("feedback");
    });

    it("脏数据 → other", () => {
        expect(detectKind("随手记", [])).toBe("other");
        expect(detectKind("Note 3", ["#其他标签"])).toBe("note"); // 文件名优先级高于无关 tags
        expect(detectKind("notes", [])).toBe("other"); // 复数不匹配
        expect(detectKind("Note", [])).toBe("other"); // 无数字
    });

    it("tags 字符串形式容忍", () => {
        expect(detectKind("x", "档案 vip")).toBe("archive"); // Obsidian 可能解析成单字符串
    });
});

describe("normalizeTags", () => {
    it("数组 + # 前缀剥离", () => {
        expect(normalizeTags(["#档案", "vip"])).toEqual(["档案", "vip"]);
    });
    it("null / 单字符串", () => {
        expect(normalizeTags(null)).toEqual([]);
        expect(normalizeTags("档案")).toEqual(["档案"]);
    });
});

// ========== heading 切块 ==========

describe("splitSections", () => {
    it("按 heading 层级切块，heading_path 为父链", () => {
        const body = [
            "## 👤 张三",
            "### 原始记录",
            "#### 出勤",
            "8月31日出勤情况：...",
            "### 反馈总结",
            "AI 生成内容",
        ].join("\n");

        const secs = splitSections(body);
        // 结构：👤 张三 / 原始记录 / 出勤 / 反馈总结（4 条 heading 块）
        expect(secs.map(s => s.heading_path)).toEqual([
            "👤 张三",
            "👤 张三/原始记录",
            "👤 张三/原始记录/出勤",
            "👤 张三/反馈总结",
        ]);
        expect(secs.map(s => s.level)).toEqual([2, 3, 4, 3]);
    });

    it("无标题内容整篇 level=0 兜底", () => {
        const body = "纯文本笔记，没有任何标题\n第二行";
        const secs = splitSections(body);
        expect(secs).toHaveLength(1);
        expect(secs[0].level).toBe(0);
        expect(secs[0].heading_path).toBe("");
        expect(secs[0].body).toContain("纯文本笔记");
    });

    it("首个标题前内容归入 level=0 条", () => {
        const body = "开头一段\n\n## 标题A\n内容";
        const secs = splitSections(body);
        expect(secs[0].level).toBe(0);
        expect(secs[0].body).toBe("开头一段");
        expect(secs[1].title).toBe("标题A");
    });

    it("body 含子标题原文（整块入库）", () => {
        const body = "## A\n### A1\n内容";
        const secs = splitSections(body);
        const a = secs.find(s => s.title === "A")!;
        expect(a.body).toContain("### A1");
    });

    it("空文件 → 无 section", () => {
        expect(splitSections("")).toHaveLength(0);
        expect(splitSections("\n\n")).toHaveLength(0);
    });
});

// ========== HTML checkbox ==========

describe("parseHtmlCheckboxes", () => {
    it("解析 checked 状态与选项文字", () => {
        const body = [
            "8月31日出勤情况：<input type=\"checkbox\" checked> 正常 <input type=\"checkbox\"> 迟到 <input type=\"checkbox\"> 早退",
            "第5次阅读作业：<input type=\"checkbox\"> 已完成 <input type=\"checkbox\"> 未完成",
        ].join("\n");

        const items = parseHtmlCheckboxes(body, "👤 张三/原始记录/出勤");
        expect(items).toHaveLength(5);
        expect(items[0]).toMatchObject({ item_text: "正常", checked: true, source: "html" });
        expect(items[1]).toMatchObject({ item_text: "迟到", checked: false });
        expect(items[2]).toMatchObject({ item_text: "早退", checked: false });
        expect(items[3]).toMatchObject({ item_text: "已完成", checked: false });
    });

    it("无 input → 空", () => {
        expect(parseHtmlCheckboxes("普通文本", "x")).toHaveLength(0);
    });
});

// ========== 完整解析 ==========

describe("parseFile", () => {
    it("other 文件不切块不解析", () => {
        const r = parseFile("随手记", [], "随便写的内容\n## 有标题也不切");
        expect(r.kind).toBe("other");
        expect(r.sections).toHaveLength(0);
        expect(r.checkboxes).toHaveLength(0);
    });

    it("feedback 文件：切块 + html checkbox", () => {
        const content = [
            "## 👤 张三",
            "### 原始记录",
            "#### 出勤",
            "8月31日出勤情况：<input type=\"checkbox\" checked> 正常 <input type=\"checkbox\"> 迟到",
            "#### 作业情况",
            "第5次阅读作业：<input type=\"checkbox\"> 已完成",
        ].join("\n");
        const r = parseFile("Feedback 5", [], content);
        expect(r.kind).toBe("feedback");
        expect(r.sections.map(s => s.heading_path)).toContain("👤 张三/原始记录/出勤");
        expect(r.checkboxes).toHaveLength(3);
        expect(r.checkboxes[0]).toMatchObject({ item_text: "正常", checked: true });
    });

    it("nav：提交反馈 task → feedbackSent", () => {
        const r = parseFile("3164 Lesson 5", ["#课程记录", "#class"], "正文", [
            { text: "提交反馈", checked: true, position: { start: 0, end: 0 } },
        ]);
        expect(r.feedbackSent).toBe(true);
        expect(r.checkboxes[0]).toMatchObject({ item_text: "提交反馈", source: "task" });
    });

    it("nav：未勾选 → feedbackSent=false", () => {
        const r = parseFile("n", ["#课程记录", "#vip"], "x", [
            { text: "提交反馈", checked: false, position: { start: 0, end: 0 } },
        ]);
        expect(r.feedbackSent).toBe(false);
    });
});

// ========== CRLF 兼容（老数据 / Windows 编辑器产出） ==========

describe("CRLF 兼容", () => {
    // 回归背景：split("\n") 给每行残留 \r，JS 正则 . 不匹配 \r → HEADING_RE
    // 全部失配，整篇落进 level=0 兜底，Feedback 页学员粒度静默丢失。
    const CRLF_FEEDBACK = [
        "## 👤 张三",
        "### 原始记录",
        "#### 出勤",
        "8月31日出勤情况：<input type=\"checkbox\" checked> 正常 <input type=\"checkbox\"> 迟到",
        "#### 作业情况",
        "第5次阅读作业：<input type=\"checkbox\"> 已完成",
        "### 反馈总结",
        "本周表现良好。",
    ].join("\r\n");

    it("CRLF 正文切块：heading_path 粒度完整", () => {
        const secs = splitSections(CRLF_FEEDBACK);
        const paths = secs.map(s => s.heading_path);
        expect(paths).toContain("👤 张三");
        expect(paths).toContain("👤 张三/原始记录/出勤");
        expect(paths).toContain("👤 张三/原始记录/作业情况");
        expect(paths).toContain("👤 张三/反馈总结");
        // 不允许整篇落进 level=0 兜底
        expect(secs.filter(s => s.level === 0)).toHaveLength(0);
    });

    it("CRLF + frontmatter：tags 识别与正文切块同时正确", () => {
        const content = "---\r\ntags:\r\n  - 档案\r\n  - vip\r\n---\r\n" + CRLF_FEEDBACK;
        const fm = parseFrontmatterBlock(content);
        expect(normalizeTags(fm.frontmatter.tags)).toEqual(["档案", "vip"]);
        const paths = splitSections(fm.body).map(s => s.heading_path);
        expect(paths).toContain("👤 张三/原始记录/出勤");
    });

    it("CRLF 正文 html checkbox：item_text 无 \\r 残留", () => {
        const r = parseFile("Feedback 5", [], CRLF_FEEDBACK);
        expect(r.checkboxes).toHaveLength(3);
        expect(r.checkboxes[0].item_text).toBe("正常");
        expect(r.checkboxes[0].checked).toBe(true);
    });

    it("CR（旧 Mac 风格）也能归一化", () => {
        const secs = splitSections(CRLF_FEEDBACK.replace(/\r\n/g, "\r"));
        expect(secs.map(s => s.heading_path)).toContain("👤 张三/反馈总结");
    });

    it("CRLF 不影响行号区间（task 归属依赖）", () => {
        const lf = CRLF_FEEDBACK.split("\r\n");
        const crlfLines = CRLF_FEEDBACK.split("\n");
        expect(crlfLines).toHaveLength(lf.length); // 行数一致 → 行号区间有效
    });
});
