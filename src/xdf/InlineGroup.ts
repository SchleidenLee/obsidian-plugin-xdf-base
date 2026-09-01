/**
 * 单行 checkbox 组渲染（方案 B 契约的渲染层）
 *
 * 契约（见 archive-utils.ts buildPersonFeedback 注释）：
 *   出勤：[ ] 正常 | [ ] 迟到 | [ ] 早退 | [ ] 线上课 | [ ] 请假
 *   作业：[ ] 已完成 | [ ] 未完成
 * 源文件单行 → CodeMirror 行几何不被破坏（多行 CSS 压横排已证伪），
 * 本模块负责把 `[ ]` / `[x]` 与 ` | ` 渲染为内联 checkbox：
 * - Live Preview：CM6 ViewPlugin + Decoration.replace + WidgetType，
 *   点击 widget dispatch 精确 offset 的文本替换（空格 ↔ x）。
 * - 阅读模式：MarkdownPostProcessor 把段落重建为内联 checkbox 组，
 *   点击后 vault.modify 回写对应行。
 * DB 侧由 Parser.parseInlineCheckboxGroups 以 source='inline' 解析入库，
 * vault.modify 触发的增量同步自动覆盖。
 */

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { editorLivePreviewField, type App, type Plugin, type TFile } from "obsidian";

/** 组行：行首标签（出勤|作业）+ 中文冒号 */
const GROUP_LINE_RE = /^\s*(出勤|作业)：/;
/** 单个 item：[ ] / [x] / [X]（精确 3 字符的勾选标记） */
const ITEM_RE = /\[([ xX])\]/g;
/** item 间分隔符（连同两侧空白一起隐藏） */
const SEP_RE = /[ \t]*\|[ \t]*/;

interface GroupItem {
	checked: boolean;
	/** 勾选标记 `[` 在行内文本中的起始下标 */
	index: number;
}

function parseGroupLine(text: string): GroupItem[] | null {
	if (!GROUP_LINE_RE.test(text)) return null;
	const items: GroupItem[] = [];
	ITEM_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ITEM_RE.exec(text)) !== null) {
		items.push({ checked: m[1] !== " ", index: m.index });
	}
	return items.length > 0 ? items : null;
}

/** 取行内第 target 个 item 的文字（勾选标记之后、下一个分隔符之前） */
function itemTextAt(lineText: string, target: number): string {
	ITEM_RE.lastIndex = 0;
	let i = 0;
	let m: RegExpExecArray | null;
	while ((m = ITEM_RE.exec(lineText)) !== null) {
		if (i === target) {
			const rest = lineText.slice(m.index + m[0].length);
			const sep = rest.search(SEP_RE);
			return (sep === -1 ? rest : rest.slice(0, sep)).trim();
		}
		i++;
	}
	return "";
}

// ================= Live Preview（CM6） =================

class InlineCheckboxWidget extends WidgetType {
	constructor(
		readonly checked: boolean,
		/** 勾选标记 `[` 在文档中的绝对 offset */
		readonly pos: number,
	) {
		super();
	}

	eq(other: InlineCheckboxWidget): boolean {
		return other.checked === this.checked && other.pos === this.pos;
	}

	/** 事件交给 input 原生处理，CM 不做坐标映射（避免光标漂移） */
	ignoreEvent(): boolean {
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const input = document.createElement("input");
		input.type = "checkbox";
		input.className = "xdf-inline-checkbox";
		input.checked = this.checked;
		input.addEventListener("change", () => {
			// 勾选标记恒为 3 字符：[ ] / [x]
			view.dispatch({
				changes: {
					from: this.pos,
					to: this.pos + 3,
					insert: input.checked ? "[x]" : "[ ]",
				},
			});
		});
		return input;
	}
}

function buildDecorations(view: EditorView): DecorationSet {
	// 仅实时预览渲染；纯源码模式保持原文（widget 会干扰编辑）
	if (view.state.field(editorLivePreviewField, false) !== true) return Decoration.none;
	const builder = new RangeSetBuilder<Decoration>();
	for (const range of view.visibleRanges) {
		for (let pos = range.from; pos <= range.to; ) {
			const line = view.state.doc.lineAt(pos);
			const items = parseGroupLine(line.text);
			if (items) {
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					const tokenFrom = line.from + item.index;
					// checkbox widget 替换 `[ ]` / `[x]` 三字符
					builder.add(tokenFrom, tokenFrom + 3, Decoration.replace({
						widget: new InlineCheckboxWidget(item.checked, tokenFrom),
					}));
					// 仅隐藏 item 之间的 ` | ` 分隔符（保留标签文字）：
					// 从标签文字结束（分隔符起点）到下一个 `[`
					if (i < items.length - 1) {
						const after = line.text.slice(item.index + 3);
						const sep = SEP_RE.exec(after);
						if (sep) {
							const sepFrom = tokenFrom + 3 + sep.index;
							const nextStart = line.from + items[i + 1].index;
							if (nextStart > sepFrom) {
								builder.add(sepFrom, nextStart, Decoration.replace({}));
							}
						}
					}
				}
			}
			pos = line.to + 1;
		}
	}
	return builder.finish();
}

class InlineGroupView {
	decorations: DecorationSet;
	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
	}
	update(update: ViewUpdate): void {
		const wasLive = update.startState.field(editorLivePreviewField, false);
		const isLive = update.state.field(editorLivePreviewField, false);
		if (update.docChanged || update.viewportChanged || wasLive !== isLive) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

const inlineGroupViewPlugin = ViewPlugin.fromClass(InlineGroupView, {
	decorations: (v) => v.decorations,
});

// ================= 阅读模式 =================

/** 阅读模式点击：回写文件对应行的第 itemIndex 个勾选标记 */
async function toggleGroupItem(
	app: App,
	sourcePath: string,
	lineHint: number | null,
	lineText: string,
	itemIndex: number,
	checked: boolean,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(sourcePath);
	if (!file || !(file as TFile).stat) return;
	const content = await app.vault.read(file as TFile);
	const lines = content.split("\n");

	// 定位源行：优先 postprocessor 提供的行号（校验文本一致），否则全文找相同行
	let lineNo = -1;
	if (lineHint != null && lines[lineHint]?.trim() === lineText.trim()) {
		lineNo = lineHint;
	} else {
		const needle = lineText.trim();
		lineNo = lines.findIndex((l) => l.trim() === needle);
	}
	if (lineNo < 0) return;

	let count = -1;
	lines[lineNo] = lines[lineNo].replace(ITEM_RE, (m) => {
		count++;
		return count === itemIndex ? (checked ? "[x]" : "[ ]") : m;
	});
	await app.vault.modify(file as TFile, lines.join("\n"));
}

function renderReadingGroup(
	el: HTMLElement,
	lineHint: number | null,
	app: App,
	sourcePath: string,
): void {
	const text = el.textContent ?? "";
	const items = parseGroupLine(text);
	if (!items) return;

	const label = text.slice(0, text.indexOf("：") + 1);
	el.empty();
	el.addClass("xdf-inline-group");
	el.createSpan({ text: label });

	items.forEach((item, i) => {
		const itemEl = el.createSpan({ cls: "xdf-inline-item" });
		const cb = itemEl.createEl("input", { type: "checkbox", cls: "xdf-inline-checkbox" });
		cb.checked = item.checked;
		itemEl.createSpan({ text: itemTextAt(text, i) });
		cb.addEventListener("change", () => {
			void toggleGroupItem(app, sourcePath, lineHint, text, i, cb.checked);
		});
	});
}

// ================= 接线 =================

export function registerInlineGroupRendering(app: App, plugin: Plugin): void {
	// 实时预览（源码模式不渲染）：CM6 decoration
	plugin.registerEditorExtension(inlineGroupViewPlugin);

	// 阅读模式：postprocessor 重建段落
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		const blocks = el.querySelectorAll<HTMLElement>("p");
		for (const block of Array.from(blocks)) {
			const text = block.textContent ?? "";
			if (!GROUP_LINE_RE.test(text) || !/\[[ xX]\]/.test(text)) continue;
			const info = ctx.getSectionInfo(block);
			// MarkdownSectionInformation: { text, lineStart, lineEnd }
			const line = info ? info.lineStart : null;
			renderReadingGroup(block, line, app, ctx.sourcePath);
		}
	});
}
