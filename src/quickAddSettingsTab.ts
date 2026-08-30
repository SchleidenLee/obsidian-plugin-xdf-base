import type {
	App,
	Setting,
	SettingDefinitionGroup,
	SettingDefinitionItem,
	TextAreaComponent,
} from "obsidian";
import {
	ButtonComponent,
	ExtraButtonComponent,
	Notice,
	PluginSettingTab,
	TextComponent,
} from "obsidian";
import type QuickAdd from "./main";
import type IChoice from "./types/choices/IChoice";
import ChoiceView from "./gui/choiceList/ChoiceView.svelte";
import ChoicesUnavailable from "./gui/choiceList/ChoicesUnavailable.svelte";
import { mountComponent, type MountHandle } from "./gui/svelte/mountComponent";
import type { Plain } from "./gui/svelte/persist.svelte";
import { GenericTextSuggester } from "./gui/suggesters/genericTextSuggester";
import GlobalVariablesView from "./gui/GlobalVariables/GlobalVariablesView.svelte";
import { settingsStore } from "./settingsStore";
import {
	getAllFolderPathsInVault,
	normalizeTemplateFolderPaths,
} from "./utilityObsidian";
import { sortFolderPathsByTree } from "./utils/folder-sorting";
import { ExportPackageModal } from "./gui/PackageManager/ExportPackageModal";
import { ImportPackageModal } from "./gui/PackageManager/ImportPackageModal";
import { InputPromptDraftStore } from "./utils/InputPromptDraftStore";
import type { QuickAddSettings } from "./settings";
import {
	DEFAULT_DATE_ALIASES,
	formatDateAliasLines,
	parseDateAliasLines,
} from "./utils/dateAliases";
import { renderDevelopmentInfo } from "./quickAddSettingsDevelopmentInfo";
import { createDocsLink, DOCS_URLS, openDocsUrl } from "./docs";
import { rootChoicesOf } from "./utils/choiceUtils";
import { getXdfBaseInstance } from "./xdf/XdfBaseExtension";
import { ScriptReleaser } from "./xdf/scripts/ScriptReleaser";
import { AIAssistantSettingsModal } from "./gui/AIAssistantSettingsModal";

/** String-named keys of {@link QuickAddSettings} — used to type the declarative
 * `control` keys so a mistyped key is caught at compile time. */
type SettingsKey = Extract<keyof QuickAddSettings, string>;

/**
 * Shared by the Packages definition (which is what the settings search indexes)
 * and by the rendered description (which the row rewrites as the export state
 * changes), so the two can never drift.
 */
const PACKAGES_DESC = "将 QuickAdd 自动化配置打包导出或导入，便于复用。";

export class QuickAddSettingsTab extends PluginSettingTab {
	public plugin: QuickAdd;
	private choiceViewHandle: MountHandle | null = null;
	private globalVariablesViewHandle: MountHandle | null = null;
	/** Live store subscription behind the Packages row's Export state. */
	private packagesUnsubscribe: (() => void) | null = null;

	constructor(app: App, plugin: QuickAdd) {
		super(app, plugin);
		this.plugin = plugin;
		this.icon = "zap";
	}

	// -----------------------------------------------------------------------
	// Store bridge
	//
	// QuickAdd's single source of truth is the zustand `settingsStore`, and the
	// only persistence path is the subscriber installed in main.ts (which sets
	// `plugin.settings` and calls `saveSettings()` on every store change). The
	// declarative `control` API would otherwise bind directly to
	// `plugin.settings[key]` and call `saveData` itself, bypassing the store and
	// leaving every live store consumer (formatter, dateParser, choiceExecutor,
	// the AI command, the Svelte views, ...) stale. Overriding both accessors to
	// read/write the store keeps it authoritative. We must NOT also touch
	// `plugin.settings` or call `saveData` here — the subscriber owns that.
	// -----------------------------------------------------------------------

	override getControlValue(key: string): unknown {
		const state = settingsStore.getState();

		// `inputPrompt` is stored as an enum but surfaced as a boolean toggle.
		if (key === "inputPrompt") {
			return state.inputPrompt === "multi-line";
		}

		return state[key as keyof QuickAddSettings];
	}

	override setControlValue(key: string, value: unknown): void {
		if (key === "inputPrompt") {
			settingsStore.setState({
				inputPrompt: value ? "multi-line" : "single-line",
			});
			return;
		}

		if (key === "persistInputPromptDrafts") {
			const enabled = Boolean(value);
			settingsStore.setState({ persistInputPromptDrafts: enabled });
			if (!enabled) {
				InputPromptDraftStore.getInstance().clearAll();
			}
			return;
		}

		settingsStore.setState({ [key]: value } as Partial<QuickAddSettings>);
	}

	override getSettingDefinitions(): SettingDefinitionItem<SettingsKey>[] {
		const groups: SettingDefinitionItem<SettingsKey>[] = [
			this.choicesGroup(),
			this.aiGroup(),
			this.databaseGroup(),
			this.advancedPage(),
		];

		return groups;
	}

	override hide(): void {
		// In declarative mode the framework owns row teardown — unloading the
		// control Components and running each render def's cleanup closure —
		// which the base hide() drives. We must call it (the old imperative tab
		// emptied containerEl itself, so the missing super.hide() was harmless
		// then; it is not now). destroySettingViews() is the idempotent safety
		// net for the two Svelte mounts.
		super.hide();
		this.destroySettingViews();
	}

	private destroySettingViews(): void {
		this.choiceViewHandle?.destroy();
		this.choiceViewHandle = null;
		this.globalVariablesViewHandle?.destroy();
		this.globalVariablesViewHandle = null;
		// Safety net for the Packages subscription: the render cleanup already
		// unsubscribes, but this row outlives no view of its own, so a missed
		// cleanup would leak a listener for the plugin's lifetime.
		this.packagesUnsubscribe?.();
		this.packagesUnsubscribe = null;
	}

	// ----- group builders -----

	private choicesGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "选项",
			// QuickAdd 的自动化能力有一套要学的语法（{{VALUE}}、{{DATE}}、
			// capture 目标……），文档入口放在第一个分组标题上。
			extraButtons: [
				(button) =>
					button
						.setIcon("help-circle")
						.setTooltip("QuickAdd 文档")
						.onClick(() =>
							openDocsUrl(DOCS_URLS.gettingStarted, button.extraSettingsEl),
						),
			],
			items: [
				{
					name: "选项列表",
					render: (setting) => this.renderChoicesView(setting),
				},
			],
		};
	}

	private packagesGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "打包",
			items: [
				{
					name: "打包导出 / 导入",
					desc: PACKAGES_DESC,
					render: (setting) => this.renderPackages(setting),
				},
			],
		};
	}

	private choicePickerGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "选择面板",
			items: [
				{
					name: "搜索文件夹内的选项",
					desc: "在选择面板搜索时，同时匹配文件夹内嵌套的选项并显示其路径。注意：嵌套匹配可能排在同级匹配之前。关闭后只搜索当前展开的层级。",
					control: { type: "toggle", key: "searchNestedChoices" },
				},
				{
					name: "「从模板新建笔记」入口",
					desc: "在 Run QuickAdd 面板里加一行，列出模板文件夹中的模板，无需专门的 Template 选项即可从模板建笔记。仅配置了模板文件夹后显示；命令面板入口始终可用。",
					control: {
						type: "dropdown",
						key: "templateFolderLauncherRow",
						defaultValue: "bottom",
						options: {
							bottom: "显示在底部（不抢占第一个回车位）",
							top: "显示在顶部",
							off: "隐藏",
						},
					},
				},
			],
		};
	}

	private inputGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "输入",
			items: [
				{
					name: "使用多行输入框",
					desc: "用多行输入框代替单行。多行用 Ctrl/Cmd+Enter 提交，Enter 插入换行。",
					control: { type: "toggle", key: "inputPrompt" },
				},
				{
					name: "保留输入草稿",
					desc: "关闭输入框时保留草稿，重新打开时恢复。草稿仅保存在当前会话。",
					control: { type: "toggle", key: "persistInputPromptDrafts" },
				},
				{
					name: "Capture 使用编辑器选中文本作为默认值",
					desc: "启用后，Capture 用当前编辑器选中的文本作为 {{VALUE}}，可能跳过输入提示。关闭后始终提示输入 {{VALUE}}。",
					control: { type: "toggle", key: "useSelectionAsCaptureValue" },
				},
				{
					name: "单页输入（One-page input）",
					desc: this.descWithDocsLink(
						"把一个选项的所有输入收集到一张表单里一次性填写，而不是逐条弹出提示。支持 Template / Capture 选项以及声明了输入的宏脚本。 Template 和 Capture 选项可以单独覆盖此设置。 ",
						DOCS_URLS.onePageInputs,
						"了解单页输入",
					),
					control: { type: "toggle", key: "onePageInputEnabled" },
				},
				{
					name: "日期别名",
					desc:
						"自然语言日期解析的简称。" +
						"每行一条：别名 = 短语。示例：tm = tomorrow。",
					render: (setting) => this.renderDateAliases(setting),
				},
			],
		};
	}

	private templatesGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "模板与属性",
			items: [
				{
					name: "模板文件夹路径",
					desc: "存放模板的文件夹，配置 QuickAdd 时从中推荐模板文件。可添加多个；留空则推荐全库所有模板文件。",
					render: (setting) => this.renderTemplateFolderPaths(setting),
				},
				{
					name: "将字符串 frontmatter 变量转为类型化属性（Beta）",
					desc:
						"脚本返回的列表/对象值始终写成规范的 Obsidian 属性（列表写为 List）。" +
						"此开关额外把字符串值转为类型化属性：逗号或项目列表字符串转为 List，" +
						"\"42\" 转为 Number，\"true\" 转为 Checkbox 等。默认关闭；字符串转换是启发式规则，可能存在边缘情况。",
					control: { type: "toggle", key: "enableTemplatePropertyTypes" },
				},
			],
		};
	}

	private notificationsGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "通知",
			items: [
				{
					name: "更新公告",
					desc: "安装新版本时显示发布说明，包括新功能、演示视频和缺陷修复。",
					control: {
						type: "dropdown",
						key: "announceUpdates",
						defaultValue: "major",
						options: {
							all: "每个新版本都显示",
							major: "仅大版本显示（新功能、破坏性变更）",
							none: "不显示",
						},
					},
				},
				{
					name: "Capture 成功通知",
					desc: "内容捕获成功后显示通知，确认操作已完成。",
					control: { type: "toggle", key: "showCaptureNotification" },
				},
				{
					name: "输入取消通知",
					desc: "输入提示被取消（未提交）时显示通知。不需要可关闭。",
					control: {
						type: "toggle",
						key: "showInputCancellationNotification",
					},
				},
			],
		};
	}

	private globalVariablesGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "全局变量",
			items: [
				{
					name: "全局变量",
					render: (setting) => this.renderGlobalVariablesView(setting),
				},
			],
		};
	}

	private aiGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "AI",
			items: [
				{
					name: "启用 AI 在线功能",
					desc: "关闭后，脚本调用 AI 会直接报错。老师日常使用请保持开启。",
					render: (setting) => {
						setting.addToggle((toggle) => {
							toggle.setValue(
								!settingsStore.getState().disableOnlineFeatures,
							);
							toggle.onChange((enabled) =>
								settingsStore.setState({
									disableOnlineFeatures: !enabled,
								}),
							);
						});
					},
				},
				{
					name: "配置 AI 供应商",
					desc: "添加 AI 供应商（如 DeepSeek）：从官网复制接口地址、填入 API Key、自动获取模型列表并选择默认模型。脚本调用 AI 时使用这里的默认模型。",
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText("配置 AI…")
								.setCta()
								.onClick(() => {
									void new AIAssistantSettingsModal(
										this.app,
										settingsStore.getState().ai,
									).waitForClose
										.then((ai) => {
											if (ai) settingsStore.setState({ ai });
										})
										.catch(() => {});
								}),
						);
					},
				},
			],
		};
	}

	private databaseGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "数据与脚本",
			items: [
				{
					name: "数据库状态",
					desc: "XDF-Base 通过 SQLite 数据库（存于 .xdf/xdf.db）与 vault 保持同步。重建会清空表并全量扫描所有 markdown 文件。",
					render: (setting) => this.renderDatabasePanel(setting),
				},
				{
					name: "预设脚本",
					desc: "XDF-Base 内置课程记录脚本，每次启动自动释放到 00.SYSTEM/xdf_base/（内置脚本覆盖更新，用户新建的脚本不受影响）。",
					render: (setting) => this.renderScriptPanel(setting),
				},
			],
		};
	}

	private appearanceGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "外观",
			items: [
				{
					name: "侧边栏图标",
					desc: "在侧边栏 ribbon 显示 QuickAdd 图标。需要重载插件生效。",
					control: { type: "toggle", key: "enableRibbonIcon" },
				},
			],
		};
	}

	private developerGroup(): SettingDefinitionGroup<SettingsKey> {
		return {
			type: "group",
			heading: "开发者",
			items: [
				{
					name: "开发信息",
					desc: "面向开发者的 Git 信息。",
					render: (setting) => this.renderDevInfo(setting),
				},
			],
		};
	}

	/** 老师日常用不到的选项，收进二级页面。 */
	private advancedPage(): SettingDefinitionItem<SettingsKey> {
		const items: SettingDefinitionItem<SettingsKey>[] = [
			this.choicePickerGroup(),
			this.inputGroup(),
			this.templatesGroup(),
			this.notificationsGroup(),
			this.globalVariablesGroup(),
			this.packagesGroup(),
			this.appearanceGroup(),
		];

		if (__IS_DEV_BUILD__) {
			items.push(this.developerGroup());
		}

		return {
			type: "page",
			name: "高级设置",
			desc: "普通使用无需改动，以下选项保持默认即可",
			items,
		};
	}

	// ----- render helpers -----

	/**
	 * A description ending in a documentation link. Built fresh on every call: the
	 * declarative renderer clones fragments before inserting them, but
	 * getSettingDefinitions() runs per render anyway, so a fresh fragment is free
	 * and cannot be accidentally re-parented.
	 *
	 * `linkText` names its destination wherever two links could be on screen at
	 * once, matching Obsidian's own "Learn more about ..." phrasing.
	 */
	private descWithDocsLink(
		text: string,
		url: string,
		linkText = "Learn more",
	): DocumentFragment {
		const fragment = document.createDocumentFragment();
		fragment.append(document.createTextNode(text));
		createDocsLink(fragment, url, linkText);
		return fragment;
	}

	/** Strip the label/description column and let a row span the full width —
	 * used to host the mounted Svelte views. The declarative API requires a
	 * `name` on every definition (for search indexing); we set it on the def and
	 * remove the rendered `infoEl` here so the view still spans full width. */
	private prepareFullWidthSetting(setting: Setting): void {
		setting.infoEl.remove();
		setting.settingEl.addClass("qa-setting-full-width");
		setting.controlEl.addClass("qa-setting-full-width-control");
	}

	// The declarative framework builds every group by calling these `render`
	// closures in turn, so a throw out of one of them abandons the rest: when
	// ChoiceView's mount threw, QuickAdd's settings came up as a lone "Choices &
	// packages" heading with nothing under it, and no other section rendered at
	// all (#1451, #1507, #1566). That guard now lives in mountComponent itself, so
	// every Svelte host in the plugin gets it (#1584) — here we only choose which
	// card takes the view's place.
	//
	// ChoiceView has its own <svelte:boundary> for reactive failures inside the
	// list; mountComponent catches the setup that boundary sits inside.

	private renderChoicesView(setting: Setting): () => void {
		this.prepareFullWidthSetting(setting);

		this.choiceViewHandle?.destroy();
		const handle = mountComponent(
			setting.controlEl,
			ChoiceView,
			{
				app: this.app,
				plugin: this.plugin,
				choices: settingsStore.getState().choices,
				// Typed Plain<IChoice[]> (not IChoice[]) so a forgotten $state.snapshot at
				// the call site is a COMPILE error here — this is the real persistence sink
				// that must never receive a live Svelte $state proxy. Plain<T> is assignable
				// to T, so setState still accepts it.
				saveChoices: (choices: Plain<IChoice[]>) => {
					settingsStore.setState({ choices });
				},
			},
			// The choice list is the one view whose failure has a recovery story worth
			// spelling out (the data.json advice in ChoicesUnavailable), and the same
			// card the view itself shows when the tree is unreadable — so a mount
			// failure and a render failure look identical to the user.
			{ what: "your choices", fallbackComponent: ChoicesUnavailable },
		);
		this.choiceViewHandle = handle;

		// Capture the handle so a stale cleanup can only ever destroy its own
		// mount (and only nulls the field while it still points at this mount).
		return () => {
			handle.destroy();
			if (this.choiceViewHandle === handle) {
				this.choiceViewHandle = null;
			}
		};
	}

	private renderGlobalVariablesView(setting: Setting): () => void {
		this.prepareFullWidthSetting(setting);

		this.globalVariablesViewHandle?.destroy();
		const handle = mountComponent(
			setting.controlEl,
			GlobalVariablesView,
			{
				app: this.app,
				plugin: this.plugin,
			},
			{ what: "your global variables" },
		);
		this.globalVariablesViewHandle = handle;

		return () => {
			handle.destroy();
			if (this.globalVariablesViewHandle === handle) {
				this.globalVariablesViewHandle = null;
			}
		};
	}

	/** Packages description, with the reason Export is unavailable when it is. */
	private packagesDesc(hasNothingToExport: boolean): DocumentFragment {
		return this.descWithDocsLink(
			hasNothingToExport
				? `${PACKAGES_DESC} 创建至少一个选项后才能导出。`
				: `${PACKAGES_DESC} `,
			DOCS_URLS.packages,
			"了解打包",
		);
	}

	private renderPackages(setting: Setting): () => void {
		// Both package actions are secondary utilities — not the page's primary
		// action ("New choice" is) — so neither is a CTA. Keeping only one filled
		// primary button in the view avoids competing purple CTAs (per the
		// one-primary-button-per-page rule).
		let exportButton: ButtonComponent | undefined;
		setting.addButton((button) => {
			exportButton = button;
			button.setButtonText("导出包…").onClick(() => {
				const choicesSnapshot = rootChoicesOf(
					settingsStore.getState().choices,
				);
				new ExportPackageModal(
					this.app,
					this.plugin,
					choicesSnapshot,
				).open();
			});
		});

		// Import stays available with zero choices on purpose: importing a package
		// is one of the most useful things a brand-new user can do, so the block as
		// a whole is not de-emphasised, only the action that cannot work.
		setting.addButton((button) =>
		button.setButtonText("导入包…").onClick(() => {
			new ImportPackageModal(this.app).open();
		}),
	);

		// "Export package…" used to be the first concrete action a new user saw
		// below the "No choices yet" empty state, with nothing to export (issue
		// #1547). The tooltip covers desktop hover; the description carries the
		// same reason for touch, where there is no hover, and for screen readers.
		const apply = (hasNothingToExport: boolean): void => {
			setting.setDesc(this.packagesDesc(hasNothingToExport));
			if (!exportButton) return;
			exportButton.setDisabled(hasNothingToExport);
			if (hasNothingToExport) {
				exportButton.setTooltip("还没有可导出的选项");
			} else {
				// setTooltip("") is unspecified; Obsidian's tooltip is driven by
				// aria-label, so drop the attribute outright.
				exportButton.buttonEl.removeAttribute("aria-label");
			}
		};

		// The declarative tab renders once and does NOT re-render on store changes,
		// so subscribe to keep the state honest while the tab stays open.
		let hasNothingToExport =
			rootChoicesOf(settingsStore.getState().choices).length === 0;
		apply(hasNothingToExport);

		this.packagesUnsubscribe?.();
		const unsubscribe = settingsStore.subscribe((settings) => {
			const next = rootChoicesOf(settings.choices).length === 0;
			if (next === hasNothingToExport) return;
			hasNothingToExport = next;
			apply(next);
		});
		this.packagesUnsubscribe = unsubscribe;

		return () => {
			unsubscribe();
			if (this.packagesUnsubscribe === unsubscribe) {
				this.packagesUnsubscribe = null;
			}
		};
	}

	private renderDateAliases(setting: Setting): void {
		setting.settingEl.addClass("qa-date-alias-setting");
		setting.controlEl.addClass("qa-date-alias-control");

		let textAreaRef: TextAreaComponent | null = null;

		setting.addTextArea((textArea) => {
			textAreaRef = textArea;
			textArea
				.setPlaceholder("t = today\ntm = tomorrow\nyd = yesterday")
				.setValue(
					formatDateAliasLines(settingsStore.getState().dateAliases),
				)
				.onChange((value) => {
					settingsStore.setState({
						dateAliases: parseDateAliasLines(value),
					});
				});
			textArea.inputEl.addClass("qa-date-alias-input");
		});

		setting.addButton((button) => {
			button.setButtonText("恢复默认").onClick(() => {
				settingsStore.setState({ dateAliases: DEFAULT_DATE_ALIASES });
				textAreaRef?.setValue(formatDateAliasLines(DEFAULT_DATE_ALIASES));
			});
			button.buttonEl.addClass("qa-date-alias-reset");
		});
	}

	/**
	 * 数据库面板：
	 * - 状态查询（表格数 / 路径 / dirty 标志）
	 * - 初始化（已经初始化了，重置 dirty 标志）
	 * - 重建（清空表 + 全量重新扫描 vault）
	 *
	 * 状态会同步显示在按钮下方的 <pre> 块里。
	 */
	private renderDatabasePanel(setting: Setting): () => void {
		this.prepareFullWidthSetting(setting);
		setting.settingEl.addClass("qa-xdf-database-setting");
		setting.controlEl.addClass("qa-xdf-database-control");

		const container = setting.controlEl.createDiv("qa-xdf-database-panel");
		const statusEl = container.createEl("pre", {
			cls: "qa-xdf-database-status",
			text: "加载中…",
		});
		const buttonRow = container.createDiv("qa-xdf-database-buttons");

		const renderStatus = (): void => {
			const xdf = getXdfBaseInstance();
			if (!xdf) {
				statusEl.setText("（插件未完全初始化）");
				return;
			}
			const s = xdf.getDatabaseStatus();
			const lines = [
				`路径:   ${s.path}`,
				`已打开: ${s.isOpen}`,
				`有改动: ${s.isDirty}`,
				`表 (${s.tableCount}): ${s.tables.length ? s.tables.join(", ") : "（无）"}`,
			];
			statusEl.setText(lines.join("\n"));
		};

		setting.addButton((button) => {
			button.setButtonText("刷新状态").onClick(() => renderStatus());
		});

		buttonRow.createEl("button", {
			cls: "qa-xdf-db-init",
			text: "初始化数据库",
		}).addEventListener("click", async () => {
			const xdf = getXdfBaseInstance();
			if (!xdf) {
				new Notice("XDF-Base 尚未初始化");
				return;
			}
			try {
				await xdf.initDatabase();
				new Notice("数据库已初始化");
			} catch (err) {
				new Notice(`初始化失败：${err}`);
			}
			renderStatus();
		});

		buttonRow.createEl("button", {
			cls: "qa-xdf-db-rebuild",
			text: "重建数据库",
		}).addEventListener("click", async () => {
			const xdf = getXdfBaseInstance();
			if (!xdf) {
				new Notice("XDF-Base 尚未初始化");
				return;
			}
			buttonRow.querySelectorAll("button").forEach((b) => {
				(b as HTMLButtonElement).disabled = true;
			});
			try {
				new Notice("正在重建数据库…");
				const report = await xdf.rebuildDatabase();
				new Notice(
					`重建完成 — ${report.fileCount} 个文件（${report.durationMs}ms）`,
				);
			} catch (err) {
				new Notice(`重建失败：${err}`);
			} finally {
				buttonRow.querySelectorAll("button").forEach((b) => {
					(b as HTMLButtonElement).disabled = false;
				});
				renderStatus();
			}
		});

		// 首次渲染状态
		renderStatus();

		return () => {
			// 无需显式清理，settings 销毁时 containerEl 一起被清掉
		};
	}

	/**
	 * 脚本释放面板：
	 * - 显示当前已安装 / 缺失的预设脚本
	 * - 一键重新释放（仅补全缺失，不覆盖）
	 * - 一键补全 Choice（idempotent）
	 */
	private renderScriptPanel(setting: Setting): () => void {
		this.prepareFullWidthSetting(setting);
		setting.settingEl.addClass("qa-xdf-scripts-setting");
		setting.controlEl.addClass("qa-xdf-scripts-control");

		const container = setting.controlEl.createDiv("qa-xdf-scripts-panel");
		const statusEl = container.createEl("pre", {
			cls: "qa-xdf-scripts-status",
			text: "加载中…",
		});
		const buttonRow = container.createDiv("qa-xdf-scripts-buttons");

		const renderStatus = async (): Promise<void> => {
			const releaser = new ScriptReleaser(this.app);
			try {
				const status = await releaser.getStatus();
				const lines: string[] = [
					`系统目录:  ${status.systemDir}`,
					`已安装 (${status.installed.length}):`,
					...status.installed.map((p) => `  ✓ ${p}`),
				];
				if (status.missing.length > 0) {
					lines.push(
						`缺失 (${status.missing.length}):`,
						...status.missing.map((p) => `  ✗ ${p}`),
					);
				} else {
					lines.push("缺失:（无）");
				}
				statusEl.setText(lines.join("\n"));
			} catch (err) {
				statusEl.setText(`错误：${err}`);
			}
		};

		buttonRow.createEl("button", {
			cls: "qa-xdf-scripts-release",
			text: "重新释放脚本",
		}).addEventListener("click", async () => {
			buttonRow.querySelectorAll("button").forEach((b) => {
				(b as HTMLButtonElement).disabled = true;
			});
			try {
				const xdf = getXdfBaseInstance();
				if (!xdf) {
					new Notice("XDF-Base 尚未初始化");
					return;
				}
				const report = await xdf.releaseScripts();
				new Notice(
					`释放完成：新建 ${report.created.length}，覆盖 ${report.updated.length}，失败 ${report.failed.length}`,
				);
			} catch (err) {
				new Notice(`释放失败：${err}`);
			} finally {
				buttonRow.querySelectorAll("button").forEach((b) => {
					(b as HTMLButtonElement).disabled = false;
				});
				await renderStatus();
			}
		});

		buttonRow.createEl("button", {
			cls: "qa-xdf-scripts-choices",
			text: "同步预设 Choice",
		}).addEventListener("click", async () => {
			buttonRow.querySelectorAll("button").forEach((b) => {
				(b as HTMLButtonElement).disabled = true;
			});
			try {
				const xdf = getXdfBaseInstance();
				if (!xdf) {
					new Notice("XDF-Base 尚未初始化");
					return;
				}
				const result = await xdf.ensureChoices();
				if (result.updated) {
					new Notice(`同步完成：新增文件夹 ${result.added.length}，重建 ${result.replaced.length}`);
				} else {
					new Notice("所有预设文件夹已就位");
				}
			} catch (err) {
				new Notice(`同步失败：${err}`);
			} finally {
				buttonRow.querySelectorAll("button").forEach((b) => {
					(b as HTMLButtonElement).disabled = false;
				});
			}
		});

		void renderStatus();

		return () => {
			// no-op
		};
	}

	private renderTemplateFolderPaths(setting: Setting): () => void {
		// Let this row span the full pane (label/desc stacked above a full-width
		// list) instead of cramming a growing list into the narrow control column.
		setting.settingEl.addClass("qa-template-folders-setting");

		const container = setting.controlEl.createDiv("qa-template-folders");
		const listEl = container.createDiv("qa-template-folder-list");

		const getPaths = (): string[] =>
			normalizeTemplateFolderPaths(settingsStore.getState().templateFolderPaths);
		const setPaths = (paths: string[]): void => {
			settingsStore.setState({ templateFolderPaths: paths });
		};

		const renderList = (): void => {
			listEl.empty();
			const paths = getPaths();
			if (paths.length === 0) {
				listEl.createDiv({
					cls: "qa-template-folder-empty",
					text: "No folders added yet.",
				});
				return;
			}
			for (const folder of paths) {
				const row = listEl.createDiv("qa-template-folder-row");
				// title gives desktop a hover tooltip for paths truncated by ellipsis;
				// on mobile (no hover) the path wraps instead — see styles.css.
				row.createSpan({
					cls: "qa-template-folder-name",
					text: folder,
					attr: { title: folder },
				});
				new ExtraButtonComponent(row)
					.setIcon("trash-2")
					.setTooltip(`Remove ${folder}`)
					.onClick(() => {
						setPaths(getPaths().filter((f) => f !== folder));
						renderList();
					});
			}
		};

		const inputRow = container.createDiv("qa-template-folder-input-row");
		const input = new TextComponent(inputRow);
		input.setPlaceholder("templates/");
		input.inputEl.addClass("qa-template-folder-input");
		const suggester = new GenericTextSuggester(
			this.app,
			input.inputEl,
			sortFolderPathsByTree(getAllFolderPathsInVault(this.app)).filter(
				(path) => path !== "/",
			),
		);

		const addFolder = (): void => {
			// Store the canonical (normalized) form so "templates" and "templates/"
			// can't both be added, and dedupe against the existing list.
			const [folder] = normalizeTemplateFolderPaths([input.inputEl.value]);
			input.inputEl.value = "";
			if (!folder) return;
			const paths = getPaths();
			if (paths.includes(folder)) return;
			setPaths([...paths, folder]);
			renderList();
		};

		const onKeydown = (e: KeyboardEvent): void => {
			if (e.key === "Enter") {
				e.preventDefault();
				addFolder();
			}
		};
		input.inputEl.addEventListener("keydown", onKeydown);
		new ButtonComponent(inputRow)
			.setCta()
			.setButtonText("Add")
			.onClick(() => addFolder());

		renderList();

		// The suggester registers global (document/window) listeners while open;
		// tear it down when the row is rebuilt or the tab hides so nothing leaks.
		return () => {
			input.inputEl.removeEventListener("keydown", onKeydown);
			suggester.destroy();
		};
	}

	private renderDevInfo(setting: Setting): void {
		const infoContainer = setting.settingEl.createDiv();
		infoContainer.addClass("qa-dev-info");

		renderDevelopmentInfo(infoContainer, {
			branch: __DEV_GIT_BRANCH__,
			commit: __DEV_GIT_COMMIT__,
			dirty: __DEV_GIT_DIRTY__,
		});
	}
}
