 
import type { App } from "obsidian";
import { ButtonComponent, Modal, Notice, SecretComponent, Setting } from "obsidian";
import type { AIProvider } from "src/ai/Provider";
import { ensureProviderIds } from "src/ai/Provider";
import { mergeModels } from "src/ai/modelsDirectory";
import { syncProviderModels } from "src/ai/modelSyncService";
import { settingsStore } from "src/settingsStore";
import { ModelDirectoryModal } from "./ModelDirectoryModal";
import { deepClone } from "src/utils/deepClone";
import GenericInputPrompt from "./GenericInputPrompt/GenericInputPrompt";
import { ProviderPickerModal } from "./ProviderPickerModal";
import GenericYesNoPrompt from "./GenericYesNoPrompt/GenericYesNoPrompt";
import type { IconType } from "src/types/IconType";

export class AIAssistantProvidersModal extends Modal {
	public waitForClose: Promise<AIProvider[]>;

	private resolvePromise: (settings: AIProvider[]) => void;
	private rejectPromise: (reason?: unknown) => void;

	private providers: AIProvider[];
	private selectedProvider: AIProvider | null;

	private _selectedProviderClone: AIProvider | null;

	constructor(providers: AIProvider[], app: App) {
		super(app);

		this.providers = providers;
		// Providers from hand-edited data.json may lack the stable id that
		// pinned model refs and the qualified script syntax rely on.
		ensureProviderIds(this.providers);

		this.waitForClose = new Promise<AIProvider[]>((resolve, reject) => {
			this.rejectPromise = reject;
			this.resolvePromise = resolve;
		});

		this.open();
		this.display();
		void this.autoSyncOnOpen();
	}

	/**
	 * Quiet refresh of every auto-sync provider when the settings open, so the
	 * lists a user is about to browse are current. Failures stay silent here —
	 * the explicit "Sync now" button is the loud path.
	 */
	private async autoSyncOnOpen(): Promise<void> {
		if (settingsStore.getState().disableOnlineFeatures) return;

		let changed = false;
		for (const provider of this.providers) {
			if (!provider.autoSyncModels) continue;
			try {
				const { added } = await syncProviderModels(this.app, provider);
				changed = changed || added > 0;
			} catch {
				// Quiet by design; "Sync now" surfaces errors.
			}
		}

		// Refresh whatever view is showing, but never clobber in-progress edits.
		if (changed && !this.selectedProvider) this.reload();
	}

	private display(): void {
		const modalName = this.selectedProvider
			? `${this.selectedProvider.name}`
			: "AI 供应商";

		this.contentEl.createEl("h2", {
			text: modalName,
			cls: "qa-modal-title",
		});

		if (this.selectedProvider) {
			this.addProviderSetting(this.contentEl);

			return;
		}

		this.addProvidersSetting(this.contentEl);
	}

	private reload(): void {
		this.contentEl.empty();

		this.display();
	}

	addProvidersSetting(container: HTMLElement) {
		new Setting(container)
			.setName("AI 供应商")
			.setDesc("AI 助手使用的供应商")
            .addButton((button) => {
                button.setButtonText("添加供应商").onClick(async () => {
                    await new ProviderPickerModal(this.app, this.providers).waitForClose;
                    this.reload();
                });

                button.setCta();
            });

		const providersContainer = container.createDiv({
			cls: "providers-container qa-ai-list-container",
		});

		this.providers.forEach((provider, i) => {
			new Setting(providersContainer)
				.setName(provider.name)
				.setDesc(provider.endpoint)
				.addButton((button) => {
					button.onClick(async () => {
						const confirmation = await GenericYesNoPrompt.Prompt(
							this.app,
							`确定要删除 ${provider.name} 吗？`
						);
						if (!confirmation) {
							return;
						}

						this.providers.splice(i, 1);
						this.reload();
					});
					button.setDestructive();
					button.setIcon("trash" as IconType);
				})
					.addButton((button) => {
						button.setButtonText("编辑").onClick(() => {
							this.selectedProvider = provider;
							this._selectedProviderClone = deepClone(provider);

							this.reload();
						});
					});
		});
	}

	addProviderSetting(container: HTMLElement) {
		this.addNameSetting(container);
		this.addEndpointSetting(container);
		this.addApiKeySetting(container);
		this.addKindSetting(container);
		this.addModelSourceSetting(container);

		this.addProviderModelsSetting(container);
		this.addImportModelsFromDirectorySetting(container);
		this.addAutoSyncSetting(container);

		this.addProviderSettingButtonRow(this.contentEl);
	}

	addNameSetting(container: HTMLElement) {
		const providerId = this.selectedProvider!.id;
		new Setting(container)
			.setName("名称")
			.setDesc(
				providerId
					? `供应商的显示名称。其稳定 ID 为 "${providerId}"，脚本中可用它限定模型，如 ai.prompt 使用 "${providerId}/模型名"。`
					: "供应商的显示名称",
			)
			.addText((text) => {
				text.setValue(this.selectedProvider!.name).onChange((value) => {
					this.selectedProvider!.name = value;
				});
			});
	}

	addEndpointSetting(container: HTMLElement) {
		new Setting(container)
			.setName("接口地址")
			.setDesc("供应商的 API 接口地址（从官网复制）")
			.addText((text) => {
				text.setValue(this.selectedProvider!.endpoint).onChange(
					(value) => {
						this.selectedProvider!.endpoint = value;
					}
				);
			});
	}

	addApiKeySetting(container: HTMLElement) {
		const hasLegacyKey =
			!!this.selectedProvider?.apiKey && !this.selectedProvider?.apiKeyRef;
		const description = hasLegacyKey
			? "检测到旧版明文 API Key，请选择一个 SecretStorage 条目完成迁移。"
			: "从 SecretStorage 选择或新建 API Key";

		new Setting(container)
			.setName("API Key")
			.setDesc(description)
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.selectedProvider?.apiKeyRef ?? "")
					.onChange((value) => {
						if (!this.selectedProvider) return;
						this.selectedProvider.apiKeyRef = value;
						this.selectedProvider.apiKey = "";
					}),
			);
	}

	addKindSetting(container: HTMLElement) {
		new Setting(container)
			.setName("接口类型")
			.setDesc(
				"该供应商期望的请求格式。自动识别可识别 Anthropic 和 Gemini 官方接口，其余一律按 OpenAI 兼容处理；代理或自定义接口请手动指定类型。",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("", "自动识别");
				dropdown.addOption("openai", "OpenAI 兼容");
				dropdown.addOption("anthropic", "Anthropic");
				dropdown.addOption("gemini", "Gemini");
				dropdown.setValue(this.selectedProvider?.kind ?? "");
				dropdown.onChange((value) => {
					if (!this.selectedProvider) return;
					this.selectedProvider.kind = value
						? (value as AIProvider["kind"])
						: undefined;
				});
			});
	}

	addModelSourceSetting(container: HTMLElement) {
		const provider = this.selectedProvider;
		new Setting(container)
			.setName("模型来源")
			.setDesc(
				"浏览或同步该供应商的模型列表时，从哪里获取。",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption(
					"providerApi",
					"供应商模型接口（需要 API Key）",
				);
				dropdown.addOption("modelsDev", "models.dev 目录");
				dropdown.addOption(
					"auto",
					"自动（先试供应商接口，失败则用 models.dev）",
				);
				const current = provider?.modelSource ?? "providerApi";
				dropdown.setValue(current);
				dropdown.onChange((value) => {
					if (!this.selectedProvider) return;
					this.selectedProvider.modelSource = value as AIProvider["modelSource"];
					this.reload();
				});
			});
	}

    addProviderModelsSetting(container: HTMLElement) {
        const modelsContainer = container.createDiv({
			cls: "models-container qa-ai-list-container",
		});

        this.selectedProvider!.models.forEach((model, i) => {
            const metadata = [`上下文：${model.maxTokens.toLocaleString()} tokens`];
            if (model.maxOutputTokens) {
                metadata.push(`输出上限：${model.maxOutputTokens.toLocaleString()} tokens`);
            }
            if (model.supportsTemperature === false) {
                metadata.push("固定采样（不支持温度参数）");
            }
            new Setting(modelsContainer)
                .setName(model.name)
                .setDesc(metadata.join(" · "))
                .addButton((button) => {
                    button.onClick(async () => {
                        const confirmation = await GenericYesNoPrompt.Prompt(
                            this.app,
                            `确定要删除 ${model.name} 吗？`
                        );
                        if (!confirmation) {
                            return;
                        }

                        this.selectedProvider!.models.splice(i, 1);
                        this.reload();
                    });
                    button.setDestructive();
                    button.setIcon("trash" as IconType);
                });
        });

        new Setting(modelsContainer)
            .setName("添加模型")
            .addButton((button) => {
                button.setButtonText("手动添加模型").onClick(async () => {
                    let modelName: string;
                    let maxTokens: string;
                    try {
                        modelName = await GenericInputPrompt.Prompt(
                            this.app,
                            "模型名称（如 deepseek-chat）"
                        );
                        maxTokens = await GenericInputPrompt.Prompt(
                            this.app,
                            "最大上下文 tokens（如 65536）"
                        );
                    } catch {
                        // Cancelling either prompt is a clean no-op.
                        return;
                    }

                    const trimmedName = modelName.trim();
                    if (!trimmedName) {
                        new Notice("模型名称不能为空。");
                        return;
                    }

                    // Reject non-numeric input outright: parseInt would silently
                    // accept "10abc" as 10. Require a plain positive integer.
                    const normalizedMaxTokens = maxTokens.trim();
                    if (!/^[1-9]\d*$/.test(normalizedMaxTokens)) {
                        new Notice("最大上下文必须是正整数。");
                        return;
                    }
                    const parsedMaxTokens = Number(normalizedMaxTokens);

                    this.selectedProvider!.models.push({
                        name: trimmedName,
                        maxTokens: parsedMaxTokens,
                    });

                    this.reload();
                });
                button.setCta();
            });
    }

	addImportModelsFromDirectorySetting(container: HTMLElement) {
		const sourceDescription = this.describeModelSource(this.selectedProvider);
		new Setting(container)
			.setName("Import models")
			.setDesc(`Browse and import models from ${sourceDescription}.`)
			.addButton((button) => {
				button.setButtonText("Browse models").onClick(async () => {
					const res = await new ModelDirectoryModal(this.app, this.selectedProvider!).waitForClose;
                    if (!res) return;
                    const { imported, mode } = res;
                    if (mode === "replace") {
                        this.selectedProvider!.models = imported;
                    } else {
                        // Merge (not append-only dedupe): re-importing a model the
                        // provider already has refreshes its context/output metadata.
                        this.selectedProvider!.models = mergeModels(
                            this.selectedProvider!.models,
                            imported
                        );
                    }
                    new Notice(`已导入 ${imported.length} 个模型${mode === "replace" ? "（已替换）" : "（已添加）"}。`);
                    this.reload();
                });
                button.setCta();
            });
    }

	addAutoSyncSetting(container: HTMLElement) {
		const sourceDescription = this.describeModelSource(this.selectedProvider);
			new Setting(container)
			.setName("自动同步模型")
			.setDesc(
				`自动保持该供应商的模型列表最新：每天一次及打开本设置时，从${sourceDescription}导入新模型和更新的上下文上限。`,
			)
			.addToggle((toggle) => {
				const current = !!this.selectedProvider?.autoSyncModels;
				toggle.setValue(current).onChange((value) => {
					if (this.selectedProvider) this.selectedProvider.autoSyncModels = value;
				});
			})
			.addButton((button) => {
				button.setButtonText("立即同步").onClick(async () => {
					try {
						const { added, updated } = await syncProviderModels(
							this.app,
							this.selectedProvider!,
						);
						new Notice(
							added > 0 || updated > 0
								? `已从${sourceDescription}同步：新增 ${added} 个模型，更新 ${updated} 个。`
								: `已从${sourceDescription}同步：已是最新。`,
						);
						this.reload();
					} catch (err) {
						new Notice(
							`同步失败：${(err as { message?: string }).message ?? err}`
						);
					}
				});
				button.setCta();
			});
	}

	// Discard in-progress edits to the selected provider by restoring the
	// snapshot taken on Edit. We swap the array entry wholesale rather than
	// Object.assign-ing the clone over the live object: Object.assign cannot
	// remove keys the edit ADDED but the snapshot lacks (e.g. an apiKeyRef set on
	// a default provider that had none), so those edits would survive Cancel.
	private restoreSelectedProviderFromClone(): void {
		if (!this.selectedProvider || !this._selectedProviderClone) return;

		const index = this.providers.indexOf(this.selectedProvider);
		if (index !== -1) {
			this.providers[index] = this._selectedProviderClone;
		}

		this.selectedProvider = null;
		this._selectedProviderClone = null;
	}

	addProviderSettingButtonRow(container: HTMLElement) {
		const buttonRow = container.createDiv({
			cls: "button-row qa-ai-provider-button-row",
		});

		const CancelButton = new ButtonComponent(buttonRow);
		CancelButton.setButtonText("取消");
		CancelButton.setDestructive();
		CancelButton.onClick(() => {
			// Cancel always returns to the provider list, discarding edits. We
			// never close() here so the modal doesn't flash-close-and-reopen via
			// onClose's path.
			this.restoreSelectedProviderFromClone();

			this.reload();
		});

		const SaveButton = new ButtonComponent(buttonRow);
		SaveButton.setButtonText("保存");
		SaveButton.setCta();
		SaveButton.onClick(() => {
			this.selectedProvider = null;
			this.reload();
		});
	}

	describeModelSource(provider: AIProvider | null): string {
		const mode = provider?.modelSource ?? "providerApi";
		switch (mode) {
			case "modelsDev":
				return "models.dev 目录";
			case "auto":
				return "供应商模型接口（失败则用 models.dev）";
			default:
				return "供应商模型接口";
		}
	}

	onClose(): void {
		// If the user dismissed while editing a provider (Escape / X), discard
		// the in-progress edits by restoring the snapshot, then resolve and close.
		// We do NOT reopen the modal here — reopening on close made Escape re-show
		// the dialog and required a second Escape to actually leave.
		this.restoreSelectedProviderFromClone();

		this.resolvePromise(this.providers);
		super.onClose();
	}
}
