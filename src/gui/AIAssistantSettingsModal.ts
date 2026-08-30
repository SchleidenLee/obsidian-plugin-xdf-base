import type { App } from "obsidian";
import { Modal, Setting, TextAreaComponent } from "obsidian";
import type { QuickAddSettings } from "src/settings";
import { mountSystemPromptLiteralNote } from "./ai/systemPromptLiteralNote";
import { AIAssistantProvidersModal } from "./AIAssistantProvidersModal";
import { populateModelDropdown } from "./modelSelect";
import { GenericTextSuggester } from "./suggesters/genericTextSuggester";
import { getAllFolderPathsInVault } from "src/utilityObsidian";

type AIAssistantSettings = QuickAddSettings["ai"];

export class AIAssistantSettingsModal extends Modal {
	public waitForClose: Promise<AIAssistantSettings>;

	private resolvePromise: (settings: AIAssistantSettings) => void;
	private rejectPromise: (reason?: unknown) => void;

	private settings: AIAssistantSettings;

	constructor(app: App, settings: AIAssistantSettings) {
		super(app);

		this.settings = settings;

		this.waitForClose = new Promise<AIAssistantSettings>(
			(resolve, reject) => {
				this.rejectPromise = reject;
				this.resolvePromise = resolve;
			}
		);

		this.open();
		this.display();
	}

	private display(): void {
		this.modalEl.addClass("qa-ai-wide-modal");
		this.contentEl.addClass("qa-ai-scroll-content");

		this.contentEl.createEl("h2", {
			text: "AI 设置",
			cls: "qa-modal-title",
		});

		this.addProvidersSetting(this.contentEl);
		this.addDefaultModelSetting(this.contentEl);
		this.addPromptTemplateFolderPathSetting(this.contentEl);
		this.addShowAssistantSetting(this.contentEl);
		this.addConfirmToolCallsSetting(this.contentEl);

		this.addDefaultSystemPromptSetting(this.contentEl);
	}

	private reload(): void {
		this.contentEl.empty();

		this.display();
	}

	addProvidersSetting(container: HTMLElement) {
		new Setting(container)
			.setName("AI 供应商")
			.setDesc("管理 AI 供应商（接口地址、API Key、模型列表）")
			.addButton((button) => {
				button.setButtonText("编辑供应商").onClick(() => {
					void new AIAssistantProvidersModal(
						this.settings.providers,
						this.app
					).waitForClose.then(() => {
						this.reload();
					});
				});
			});
	}
 
	addDefaultModelSetting(container: HTMLElement) {
		new Setting(container)
			.setName("默认模型")
			.setDesc("脚本调用 AI 时使用的模型")
			.addDropdown((dropdown) => {
				populateModelDropdown(
					dropdown,
					{
						model: this.settings.defaultModel,
						modelRef: this.settings.defaultModelRef,
					},
					(selection) => {
						this.settings.defaultModel = selection.model;
						this.settings.defaultModelRef = selection.modelRef;
					},
				);
			});
	}

	addPromptTemplateFolderPathSetting(container: HTMLElement) {
		new Setting(container)
			.setName("提示词模板文件夹")
			.setDesc("存放提示词模板的文件夹路径（可选）")
			.addText((text) => {
				text.setValue(this.settings.promptTemplatesFolderPath).onChange(
					(value) => {
						this.settings.promptTemplatesFolderPath = value;
					}
				);

				new GenericTextSuggester(
					this.app,
					text.inputEl,
					getAllFolderPathsInVault(this.app)
				);
			});
	}

	addShowAssistantSetting(container: HTMLElement) {
		new Setting(container)
			.setName("显示助手消息")
			.setDesc("显示 AI 助手的状态消息")
			.addToggle((toggle) => {
				toggle.setValue(this.settings.showAssistant);
				toggle.onChange((value) => {
					this.settings.showAssistant = value;
				});
			});
	}

	addConfirmToolCallsSetting(container: HTMLElement) {
		new Setting(container)
			.setName("AI 工具调用确认")
			.setDesc(
				"AI 执行脚本定义或内置的工具（写文件等）前是否需要确认。「仅危险工具」确认非只读工具；「总是」确认所有工具；「从不」按各工具自身设置执行。标记为必须确认的工具始终会确认。",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("destructive", "仅危险工具（推荐）");
				dropdown.addOption("always", "总是确认");
				dropdown.addOption("never", "从不（按各工具自身设置）");
				dropdown.setValue(this.settings.confirmToolCalls ?? "destructive");
				dropdown.onChange((value) => {
					this.settings.confirmToolCalls =
						value as QuickAddSettings["ai"]["confirmToolCalls"];
				});
			});
	}

	addDefaultSystemPromptSetting(contentEl: HTMLElement) {
		new Setting(contentEl)
			.setName("默认系统提示词")
			.setDesc("AI 助手的默认系统提示词（脚本会使用自己的提示词，此项留空即可）");

		const textAreaComponent = new TextAreaComponent(contentEl);
		textAreaComponent.inputEl.addClass("qa-ai-prompt-textarea");
		// The textarea is appended to contentEl rather than to the Setting's
		// controlEl (it needs the full modal width), so nothing associates it with
		// the "Default system prompt" name above.
		textAreaComponent.inputEl.setAttribute(
			"aria-label",
			"默认系统提示词",
		);

		// No format preview and no `{{` token autocomplete here: the system prompt
		// is sent to the model verbatim (see mountSystemPromptLiteralNote). The
		// preview this replaces resolved the tokens on screen and was, for the
		// shipped token-free default, a character-for-character duplicate of the
		// textarea above it (#1568).
		const updateLiteralNote = mountSystemPromptLiteralNote(
			contentEl,
			textAreaComponent.inputEl,
			this.settings.defaultSystemPrompt ?? "",
		);

		textAreaComponent
			.setValue(this.settings.defaultSystemPrompt)
			.onChange((value) => {
				this.settings.defaultSystemPrompt = value;
				updateLiteralNote(value);
			});
	}

	onClose(): void {
		this.resolvePromise(this.settings);
		super.onClose();
	}
}
