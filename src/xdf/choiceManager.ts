/**
 * Choice 预设管理（分组版）
 *
 * 预设 Choice 以「文件夹（Multi Choice）」形式写入 data.json：
 *   档案管理 / 文件生成
 *
 * 每次启动同步（与脚本释放同一覆盖语义）：
 * - 预设文件夹 id 已存在 → 原位重建 children
 * - 存在用户手动建的同名 Multi（旧布局）→ 接管（换成预设 id + 重建 children，保留折叠状态和位置）
 * - 散落的预设单 choice（更旧的扁平布局）→ 移除（内容由文件夹重建）
 * - 已退役的预设文件夹（见 RETIRED_FOLDER_IDS）→ 移除
 * - 用户自己创建的 Choice → 完全不动
 */

import { PRESET_SCRIPTS, type PresetScript } from "./scripts";

const SYSTEM_DIR = "00.SYSTEM/xdf_base";

/** 预设文件夹定义（顺序即展示顺序） */
interface PresetFolder {
    id: string;
    name: string;
    scriptIds: string[];
}

export const PRESET_FOLDERS: PresetFolder[] = [
    {
        id: "xdf-base-folder-archive",
        name: "档案管理",
        scriptIds: [
            "archive-1on1-create",
            "archive-class-create",
            "lesson-1on1-record",
            "lesson-class-record"
        ]
    },
    {
        id: "xdf-base-folder-gen",
        name: "文件生成",
        scriptIds: ["wordlist-ai", "homework-ai"]
    }
];

/**
 * 已退役的预设文件夹 id（不再生成，启动同步时从 data.json 移除）。
 * - xdf-base-folder-utils：ArchiveUtils 是被其他脚本加载的工具库，
 *   文件照常释放到 utils/，但不该作为可运行 Choice 出现在菜单里。
 */
const RETIRED_FOLDER_IDS = new Set(["xdf-base-folder-utils"]);

/** 所有预设单 choice 的 id（不含文件夹） */
const PRESET_CHOICE_IDS = new Set(
    PRESET_SCRIPTS.map((p) => `xdf-base-${p.id}`)
);

/**
 * 把 PresetScript 转成 QuickAdd 的 Macro Choice（内含 UserScript 命令）
 *
 * QuickAdd 的合法 Choice 类型只有 Capture/Macro/Multi/Template，
 * 脚本必须通过 Macro 里的 UserScript 命令执行。
 * 业务脚本 command: true（可在命令面板触发，列表里的闪电图标）；
 * ArchiveUtils 是被其他脚本加载的工具库，不注册命令。
 */
function presetToChoice(preset: PresetScript): any {
    return {
        id: `xdf-base-${preset.id}`,
        name: preset.displayName,
        type: "Macro",
        command: preset.id !== "archive-utils",
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

/** 构建一个预设文件夹（Multi Choice，children 全量重建） */
function presetFolderToChoice(folder: PresetFolder, collapsed = false): any {
    return {
        id: folder.id,
        name: folder.name,
        type: "Multi",
        command: false,
        collapsed,
        choices: folder.scriptIds.map((scriptId) => {
            const preset = PRESET_SCRIPTS.find((p) => p.id === scriptId);
            if (!preset) {
                throw new Error(`Unknown preset script id: ${scriptId}`);
            }
            return presetToChoice(preset);
        })
    };
}

/** 递归移除列表（含嵌套 Multi children）中的散落预设单 choice */
function stripScatteredPresetScripts(list: any[]): void {
    for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (!c) continue;
        if (PRESET_CHOICE_IDS.has(c.id)) {
            list.splice(i, 1);
            continue;
        }
        if (c.type === "Multi" && Array.isArray(c.choices)) {
            stripScatteredPresetScripts(c.choices);
        }
    }
}

/**
 * 同步预设 Choice 文件夹（idempotent，每次启动调用）
 *
 * @param currentChoices 当前 settings.choices（顶层列表）
 */
export function syncPresetChoices(currentChoices: any[] = []): {
    updated: boolean;
    choices: any[];
    added: string[];
    replaced: string[];
} {
    const added: string[] = [];
    const replaced: string[] = [];
    const work = [...currentChoices];

    // 1. 记录接管位置：预设文件夹 id 精确匹配，或同名 choice
    //    （用户手动建的 Multi 文件夹 / 旧扁平布局的散落脚本）
    const takeoverIndex = new Map<string, number>();
    work.forEach((c, i) => {
        if (!c) return;
        const folder = PRESET_FOLDERS.find(
            (f) => f.id === c.id || f.name === c.name
        );
        if (folder && !takeoverIndex.has(folder.id)) {
            takeoverIndex.set(folder.id, i);
        }
    });

    // 2. 顶层未被接管位引用的散落预设脚本打墓碑（收进文件夹后统一清除）；
    //    已退役的预设文件夹同样打墓碑移除
    const takeoverSlots = new Set(takeoverIndex.values());
    work.forEach((c, i) => {
        if (!c) return;
        if (
            (PRESET_CHOICE_IDS.has(c.id) && !takeoverSlots.has(i)) ||
            RETIRED_FOLDER_IDS.has(c.id)
        ) {
            work[i] = null;
        }
    });

    // 3. 嵌套在用户文件夹里的散落预设脚本直接移除
    for (const c of work) {
        if (c && c.type === "Multi" && Array.isArray(c.choices)) {
            stripScatteredPresetScripts(c.choices);
        }
    }

    // 4. 重建文件夹：有接管位 → 原位覆盖；否则追加到末尾
    for (const folder of PRESET_FOLDERS) {
        const rebuilt = presetFolderToChoice(folder);
        const idx = takeoverIndex.get(folder.id);
        if (idx === undefined) {
            work.push(rebuilt);
            added.push(folder.id);
        } else {
            const existing = work[idx];
            rebuilt.collapsed = existing?.collapsed ?? false;
            work[idx] = rebuilt;
            replaced.push(folder.id);
        }
    }

    return {
        updated: added.length > 0 || replaced.length > 0,
        choices: work.filter((c) => c !== null),
        added,
        replaced
    };
}

/**
 * 获取所有预设 Choice ID（含文件夹）
 */
export function getPresetChoiceIds(): string[] {
    return [
        ...PRESET_FOLDERS.map((f) => f.id),
        ...PRESET_SCRIPTS.map((p) => `xdf-base-${p.id}`)
    ];
}
