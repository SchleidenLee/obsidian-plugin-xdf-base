/**
 * XDF-Base 内置脚本导出
 *
 * 这些脚本会被 esbuild 打包进 main.js，并在首次启动时释放到
 * 00.SYSTEM/xdf_base/scripts/ 目录。
 *
 * 每个脚本导出字符串内容（实际是 .js 源码），
 * 释放时直接写入文件即可。
 */

import { ARCHIVE_1ON1_CREATE_SCRIPT } from "./archive-1on1-create";
import { ARCHIVE_CLASS_CREATE_SCRIPT } from "./archive-class-create";
import { LESSON_1ON1_RECORD_SCRIPT } from "./lesson-1on1-record";
import { LESSON_CLASS_RECORD_SCRIPT } from "./lesson-class-record";
import { HOMEWORK_AI_SCRIPT } from "./homework-ai";
import { WORDLIST_AI_SCRIPT } from "./wordlist-ai";
import { ARCHIVE_UTILS_SCRIPT } from "./archive-utils";

/**
 * 脚本清单
 *
 * id: 全局唯一标识
 * displayName: 在 QuickAdd 面板里显示的名字
 * path: 释放到 00.SYSTEM/xdf_base/ 里的相对路径
 * content: 脚本内容
 * category: 分类（建档/每课记录/AI/工具）
 */
export interface PresetScript {
    id: string;
    displayName: string;
    path: string;
    content: string;
    category: "建档" | "每课记录" | "AI" | "工具";
}

export const PRESET_SCRIPTS: PresetScript[] = [
    {
        id: "archive-utils",
        displayName: "档案工具函数库",
        path: "utils/ArchiveUtils.js",
        content: ARCHIVE_UTILS_SCRIPT,
        category: "工具"
    },
    {
        id: "archive-1on1-create",
        displayName: "XDF: 一对一建档",
        path: "scripts/一对一建档.js",
        content: ARCHIVE_1ON1_CREATE_SCRIPT,
        category: "建档"
    },
    {
        id: "archive-class-create",
        displayName: "XDF: 班课建档",
        path: "scripts/班课建档.js",
        content: ARCHIVE_CLASS_CREATE_SCRIPT,
        category: "建档"
    },
    {
        id: "lesson-1on1-record",
        displayName: "XDF: 一对一每课记录",
        path: "scripts/一对一每课记录.js",
        content: LESSON_1ON1_RECORD_SCRIPT,
        category: "每课记录"
    },
    {
        id: "lesson-class-record",
        displayName: "XDF: 班课每课记录",
        path: "scripts/班课每课记录.js",
        content: LESSON_CLASS_RECORD_SCRIPT,
        category: "每课记录"
    },
    {
        id: "homework-ai",
        displayName: "XDF: AI 出作业",
        path: "scripts/HomeworkAI.js",
        content: HOMEWORK_AI_SCRIPT,
        category: "AI"
    },
    {
        id: "wordlist-ai",
        displayName: "XDF: AI 单词语法整理",
        path: "scripts/WordListAI.js",
        content: WORDLIST_AI_SCRIPT,
        category: "AI"
    }
];
