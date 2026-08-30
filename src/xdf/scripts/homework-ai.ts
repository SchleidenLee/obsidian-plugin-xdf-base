/**
 * HomeworkAI 简化版骨架
 * 释放到 00.SYSTEM/xdf_base/scripts/HomeworkAI.js
 *
 * 完整的三阶段流水线实现留给后续
 */

export const HOMEWORK_AI_SCRIPT = String.raw`module.exports = async (params) => {
    try {
        const { quickAddApi, app } = params;

        // 检查 AI 是否启用
        if (!quickAddApi.ai) {
            new Notice("⚠️ AI 功能未启用，请在 XDF-Base 设置里检查");
            return;
        }

        // 1. 收集配置
        const homeworkType = await quickAddApi.suggester(
            ["入门测 (15-20分钟)", "作业 (30+分钟)"],
            ["入门测", "作业"],
            false,
            "作业类型"
        );
        if (!homeworkType) return;

        const vocabLevel = await quickAddApi.suggester(
            ["不掺入", "A1", "A2", "B1", "B2", "C1"],
            ["不掺入", "A1", "A2", "B1", "B2", "C1"],
            false,
            "词汇等级"
        );
        if (!vocabLevel) return;

        const ratio = await quickAddApi.inputPrompt("掺入比例（0-100）", "20");
        const extraPoints = await quickAddApi.inputPrompt("补充考察点（可空）", "");

        // 2. 读当前笔记
        const file = app.workspace.getActiveFile();
        if (!file) {
            new Notice("⚠️ 请先打开一个笔记");
            return;
        }
        const noteContent = await app.vault.read(file);

        // 3. 构造 prompt
        // 注意：ai.prompt 的第一个参数是字符串（作为 user 消息），
        // system 角色走 settings.systemPrompt，不能传 messages 数组
        const systemPrompt = "你是一位经验丰富的英语教师，擅长根据课堂笔记出题。";
        const prompt = "# 课堂笔记\n" + noteContent + "\n\n# 作业类型\n" + homeworkType + "\n\n# 词汇等级\n" + vocabLevel + "\n\n# 掺入比例\n" + ratio + "%\n\n# 补充考察点\n" + extraPoints + "\n\n请按 markdown 格式输出作业题单。完整的三阶段流水线实现待后续填充。\n";

        // 4. 调 AI（模型在 XDF-Base 设置里统一配置，脚本不关心）
        const result = await quickAddApi.ai.prompt(prompt, undefined, {
            systemPrompt,
            modelOptions: { temperature: 0.7 }
        });

        if (!result || !result.output) {
            new Notice("❌ AI 调用失败");
            return;
        }

        // 5. 覆盖当前文件
        await app.vault.modify(file, result.output);
        new Notice("✅ 作业已生成");

    } catch (err) {
        console.error("HomeworkAI Error:", err);
        new Notice("❌ 出题失败：" + err.message);
    }
};
`;
