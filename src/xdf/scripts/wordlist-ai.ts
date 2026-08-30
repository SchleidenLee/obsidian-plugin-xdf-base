/**
 * WordListAI 简化版骨架
 * 释放到 00.SYSTEM/xdf_base/scripts/WordListAI.js
 */

export const WORDLIST_AI_SCRIPT = String.raw`module.exports = async (params) => {
    try {
        const { quickAddApi, app } = params;

        if (!quickAddApi.ai) {
            new Notice("⚠️ AI 功能未启用");
            return;
        }

        const file = app.workspace.getActiveFile();
        if (!file) {
            new Notice("⚠️ 请先打开一个笔记");
            return;
        }
        const noteContent = await app.vault.read(file);

        const messages = [
            {
                role: "system",
                content: "你是一位英语教师助手，擅长从课堂笔记中提炼单词、搭配、语法。"
            },
            {
                role: "user",
                content: "# 课堂笔记\n" + noteContent + "\n\n请按以下 markdown 结构整理：\n\n## 📚 核心词汇\n（单词 + 释义 + 例句）\n\n## 🔗 重点搭配\n（短语 + 释义 + 例句）\n\n## 📐 语法点\n（语法结构 + 例句 + 解析）\n"
            }
        ];

        const result = await quickAddApi.ai.prompt(messages, "deepseek-chat", {
            systemPrompt: "",
            modelOptions: { temperature: 0.3 }
        });

        if (!result || !result.output) {
            new Notice("❌ AI 调用失败");
            return;
        }

        await app.vault.modify(file, result.output);
        new Notice("✅ 单词语法整理完成");

    } catch (err) {
        console.error("WordListAI Error:", err);
        new Notice("❌ 整理失败：" + err.message);
    }
};
`;
