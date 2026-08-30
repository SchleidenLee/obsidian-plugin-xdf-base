/**
 * Choice 预设管理
 *
 * 每次启动：预设 Choice（id 前缀 xdf-base-）按 id 原位覆盖（新增的追加到末尾），
 * 与脚本释放同一语义：内置项全量送达，老师不会修改预设 Choice。
 *
 * 用户自己创建的 Choice id 不同，完全不动。
 */

import { PRESET_SCRIPTS } from "./scripts";

const SYSTEM_DIR = "00.SYSTEM/xdf_base";

/**
 * 把 PresetScript 转成 QuickAdd 的 Macro Choice（内含 UserScript 命令）
 *
 * QuickAdd 的合法 Choice 类型只有 Capture/Macro/Multi/Template，
 * 脚本必须通过 Macro 里的 UserScript 命令执行。
 */
function presetToChoice(preset: typeof PRESET_SCRIPTS[number]): any {
    return {
        id: `xdf-base-${preset.id}`,
        name: preset.displayName,
        type: "Macro",
        command: false,
        runOnStartup: false,
        macro: {
            name: preset.displayName,
            id: `xdf-macro-${preset.id}`,
            commands: [
                {
                    name: preset.displayName,
                    type: "UserScript",
                    path: `${SYSTEM_DIR}/${preset.path}`,
                    settings: {}
                }
            ]
        }
    };
}

/**
 * 同步预设 Choice（idempotent）
 *
 * - 预设 id 已存在 → 原位覆盖（保留用户排序）
 * - 预设 id 缺失 → 追加
 * - 用户 Choice → 不动
 *
 * @param currentChoices 当前 settings.choices
 */
export function ensurePresetChoices(currentChoices: any[] = []): {
    updated: boolean;
    choices: any[];
    added: string[];
    replaced: string[];
} {
    const added: string[] = [];
    const replaced: string[] = [];
    // id -> index 映射，用于原位覆盖
    const indexById = new Map<string, number>();
    currentChoices.forEach((c, i) => {
        if (c && typeof c.id === "string") indexById.set(c.id, i);
    });

    const result = [...currentChoices];
    for (const preset of PRESET_SCRIPTS) {
        const choiceId = `xdf-base-${preset.id}`;
        const choice = presetToChoice(preset);
        const idx = indexById.get(choiceId);
        if (idx === undefined) {
            result.push(choice);
            added.push(choiceId);
        } else {
            result[idx] = choice;
            replaced.push(choiceId);
        }
    }

    return {
        updated: added.length > 0 || replaced.length > 0,
        choices: result,
        added,
        replaced
    };
}

/**
 * 获取所有 XDF-Base Choice ID
 */
export function getPresetChoiceIds(): string[] {
    return PRESET_SCRIPTS.map((p: typeof PRESET_SCRIPTS[number]) => `xdf-base-${p.id}`);
}
