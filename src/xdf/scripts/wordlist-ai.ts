/**
 * XDF 词表工具
 * 释放到 00.SYSTEM/xdf_base/scripts/WordListAI.js
 *
 * 流程：读当前笔记 → AI 提取词条（JSON）→ JS 打乱 → 排 6 列 md 表格 → 覆盖笔记
 * 模式：整理词表（单词|词性|汉意）/ 生成默写表（词性、汉意留空）
 * 短语不填词性。
 * 注意：ai.prompt 的第一个参数是字符串（作为 user 消息），system 走 settings.systemPrompt。
 */

export const WORDLIST_AI_SCRIPT = String.raw`module.exports = async (params) => {
    try {
        const { quickAddApi, app } = params;

        if (!quickAddApi.ai) {
            new Notice("⚠️ AI 功能未启用");
            return;
        }

        // 1. 选模式
        const mode = await quickAddApi.suggester(
            ["整理词表", "生成默写表"],
            ["dictation-false", "dictation-true"],
            false,
            "词表工具：选择生成模式"
        );
        if (!mode) return;
        const isDictation = mode === "dictation-true";

        // 2. 读当前笔记
        const file = app.workspace.getActiveFile();
        if (!file) {
            new Notice("⚠️ 请先打开一个笔记");
            return;
        }
        const noteContent = await app.vault.read(file);
        if (!noteContent.trim()) {
            new Notice("⚠️ 当前笔记是空的");
            return;
        }

        // 3. AI 提取词条 JSON
        new Notice("⏳ 正在提取词条…");
        const systemPrompt = "你是一位英语教师助手，擅长从课堂笔记中提取英语单词和短语。只输出 JSON，不要输出任何其他文字。";
        const prompt = "# 素材\n" + noteContent + "\n\n# 任务\n提取素材中所有值得学习的英语单词和短语，输出一个 JSON 数组，每个元素格式：\n" +
            '[{"word":"单词或短语","pos":"词性（如 n. / v. / adj.），短语留空字符串","meaning":"中文释义"}]\n' +
            "要求：\n- 只输出 JSON 数组，不要 markdown 代码块标记，不要解释\n- 按素材中出现顺序列出，不要去重不同义项\n- 短语的 pos 必须是空字符串\n";

        const result = await quickAddApi.ai.prompt(prompt, undefined, {
            systemPrompt,
            modelOptions: { temperature: 0.2 }
        });

        if (!result || !result.output) {
            new Notice("❌ AI 调用失败");
            return;
        }

        // 4. 解析 JSON（容忍代码块包裹、前后杂文字）
        let entries;
        try {
            let text = result.output.trim();
            // 剥离代码块围栏（反引号用 charCode 构造，避免与模板字面量冲突）
            const BT = String.fromCharCode(96);
            const fenceStart = text.indexOf(BT);
            if (fenceStart !== -1) {
                const firstNL = text.indexOf("\n", fenceStart);
                const fenceEnd = text.lastIndexOf(BT);
                if (firstNL !== -1 && fenceEnd > firstNL) text = text.slice(firstNL + 1, fenceEnd).trim();
            }
            const start = text.indexOf("[");
            const end = text.lastIndexOf("]");
            if (start === -1 || end === -1) throw new Error("未找到 JSON 数组");
            entries = JSON.parse(text.slice(start, end + 1));
        } catch (parseErr) {
            new Notice("❌ AI 返回内容无法解析为词条 JSON：" + parseErr.message);
            return;
        }

        if (!Array.isArray(entries) || entries.length === 0) {
            new Notice("❌ 未提取到任何单词或短语");
            return;
        }

        // 5. 打乱顺序（Fisher-Yates）
        for (let i = entries.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [entries[i], entries[j]] = [entries[j], entries[i]];
        }

        // 6. 排 6 列表格：|单词|词性|汉意|单词|词性|汉意|，每行两条
        const cell = (e) => {
            if (!e) return ["", "", ""];
            if (isDictation) return [e.word || "", "", ""];
            return [e.word || "", e.pos || "", e.meaning || ""];
        };
        const lines = ["| 单词 | 词性 | 汉意 | 单词 | 词性 | 汉意 |", "| --- | --- | --- | --- | --- | --- |"];
        for (let i = 0; i < entries.length; i += 2) {
            const a = cell(entries[i]);
            const b = cell(entries[i + 1]);
            lines.push("| " + a.join(" | ") + " | " + b.join(" | ") + " |");
        }

        // 7. 覆盖当前笔记
        await app.vault.modify(file, lines.join("\n") + "\n");
        new Notice("✅ 已生成" + (isDictation ? "默写表" : "词表") + "（" + entries.length + " 个词条）");

    } catch (err) {
        console.error("WordListAI Error:", err);
        new Notice("❌ 生成失败：" + err.message);
    }
};
`;
