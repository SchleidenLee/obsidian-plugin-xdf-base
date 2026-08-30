/**
 * 脚本释放器
 *
 * 每次启动都把内置脚本释放到 00.SYSTEM/xdf_base/（无条件覆盖预设脚本）
 *
 * 设计原则：
 * - 释放目录：00.SYSTEM/xdf_base/（非点目录：QuickAdd 的
 *   getUserScript 走 vault 索引，点目录拿不到 TFile）
 * - 无条件覆盖：内置脚本升级随插件启动自动送达，老师不会修改预设脚本
 * - 只动预设清单内的文件：用户新建的脚本不在 PRESET_SCRIPTS 里，不会被动
 * - 自愈：用户删了再补回
 */

import { TFile, type App } from "obsidian";
import { PRESET_SCRIPTS, type PresetScript } from "./index";

const SYSTEM_DIR = "00.SYSTEM/xdf_base";

export class ScriptReleaser {
    private app: App;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * 释放所有预设脚本（idempotent，每次启动全量覆盖）
     */
    async releaseAll(): Promise<ReleaseReport> {
        const report: ReleaseReport = {
            created: [],
            updated: [],
            failed: []
        };

        // 确保系统目录存在
        await this.ensureDir(SYSTEM_DIR);

        for (const preset of PRESET_SCRIPTS) {
            try {
                const fullPath = `${SYSTEM_DIR}/${preset.path}`;
                const action = await this.releaseOne(fullPath, preset.content);
                if (action === "created") {
                    report.created.push(fullPath);
                } else {
                    report.updated.push(fullPath);
                }
            } catch (err) {
                report.failed.push({
                    path: preset.path,
                    error: String(err)
                });
            }
        }

        return report;
    }

    /**
     * 释放单个脚本：不存在则创建，已存在则覆盖
     * @returns "created" | "updated"
     */
    private async releaseOne(path: string, content: string): Promise<"created" | "updated"> {
        // 确保父目录
        const dir = path.substring(0, path.lastIndexOf("/"));
        if (dir) await this.ensureDir(dir);

        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            // TFile 已存在 → 覆盖
            await this.app.vault.modify(file, content);
            return "updated";
        }

        if (await this.app.vault.adapter.exists(path)) {
            // vault 索引未命中但磁盘存在（如启动早期）→ 直接写
            await this.app.vault.adapter.write(path, content);
            return "updated";
        }

        await this.app.vault.create(path, content);
        return "created";
    }

    /**
     * 确保目录存在
     */
    private async ensureDir(path: string): Promise<void> {
        if (await this.app.vault.adapter.exists(path)) return;
        await this.app.vault.adapter.mkdir(path);
    }

    /**
     * 获取释放状态
     */
    async getStatus(): Promise<ReleaseStatus> {
        const status: ReleaseStatus = {
            systemDir: SYSTEM_DIR,
            installed: [],
            missing: []
        };

        for (const preset of PRESET_SCRIPTS) {
            const fullPath = `${SYSTEM_DIR}/${preset.path}`;
            if (await this.app.vault.adapter.exists(fullPath)) {
                status.installed.push(fullPath);
            } else {
                status.missing.push(fullPath);
            }
        }

        return status;
    }
}

export interface ReleaseReport {
    created: string[];
    updated: string[];
    failed: Array<{ path: string; error: string }>;
}

export interface ReleaseStatus {
    systemDir: string;
    installed: string[];
    missing: string[];
}
