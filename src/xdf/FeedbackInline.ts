/**
 * Feedback 文件 task 横排（视图层）
 *
 * 给打开契约文件（Feedback N.md）的 markdown 视图根元素（.workspace-leaf-content）
 * 打上 qa-xdf-feedback-inline 类，styles.css 据此让出勤/作业 task 横排。
 * 类名由插件主动添加，不依赖 Obsidian 未文档化的 DOM 属性（data-path 方案已证伪：
 * 编辑器视图上没有该属性）。
 *
 * 已用 DevTools 注入实验验证：阅读视图（ul.contains-task-list flex）与
 * 实时预览（.cm-line.HyperMD-task-line inline-flex）两种模式均可横排。
 *
 * 纯视图层：不影响文件内容、frontmatter、数据库。事件每次全量重算所有窗格，
 * 避免类残留。onunload 时由 detachFeedbackInline 清理。
 */

import type { App, Plugin, WorkspaceLeaf } from "obsidian";

const CLASS_NAME = "qa-xdf-feedback-inline";
const FEEDBACK_BASENAME = /^Feedback \d+$/;

function isFeedbackFile(file: { basename: string; extension: string } | null): boolean {
    return !!file && file.extension === "md" && FEEDBACK_BASENAME.test(file.basename);
}

function leafContentEl(leaf: WorkspaceLeaf): HTMLElement | null {
    // 实测（1.9.x）：MarkdownView.containerEl 就是 .workspace-leaf-content 本身；
    // 兼容旧版指向 .view-content 的情况，回退查父元素
    const el = (leaf.view as unknown as { containerEl?: HTMLElement } | null)?.containerEl;
    if (!el) return null;
    if (el.hasClass("workspace-leaf-content")) return el;
    const parent = el.parentElement;
    return parent?.hasClass("workspace-leaf-content") ? parent : null;
}

/** 启动：注册事件 + 首次布局重算（事件驱动打类名） */
export function attachFeedbackInline(app: App, plugin: Plugin): void {
    const update = () => {
        for (const leaf of app.workspace.getLeavesOfType("markdown")) {
            const el = leafContentEl(leaf);
            if (!el) continue;
            const file = (leaf.view as unknown as { file?: { basename: string; extension: string } | null } | null)
                ?.file ?? null;
            el.toggleClass(CLASS_NAME, isFeedbackFile(file));
        }
    };
    // layout-change 覆盖窗格增删，file-open/active-leaf-change 覆盖打开文件；
    // 类打在 workspace-leaf-content 上（模式切换不会重建该元素），漏事件也不会残留错窗格
    plugin.registerEvent(app.workspace.on("layout-change", update));
    plugin.registerEvent(app.workspace.on("file-open", update));
    plugin.registerEvent(app.workspace.on("active-leaf-change", update));

    if (app.workspace.layoutReady) {
        update();
    } else {
        app.workspace.onLayoutReady(update);
    }
}

/** 卸载：移除所有视图上打过的类 */
export function detachFeedbackInline(app: App): void {
    for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        leafContentEl(leaf)?.removeClass(CLASS_NAME);
    }
}
