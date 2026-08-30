/**
 * 一对一建档脚本
 * 释放到 00.SYSTEM/xdf_base/scripts/一对一建档.js
 */

export const ARCHIVE_1ON1_CREATE_SCRIPT = String.raw`module.exports = async () => {
    try {
        const utilsCode = await app.vault.adapter.read("00.SYSTEM/xdf_base/utils/ArchiveUtils.js");
        const utilsModule = { exports: {} };
        new Function("module", "exports", "app", utilsCode)(utilsModule, utilsModule.exports, app);
        const U = utilsModule.exports;

        const studentName = await U.qa().inputPrompt("请输入学员姓名");
        if (!studentName) throw new Error("学员姓名不能为空");

        const startingDate = await U.pickStartingDate();
        const scheduleType = await U.pickScheduleType();
        const courseType = await U.pickCourseType();
        const subject = await U.pickSubjectIfIELTS(courseType);
        const basePath = await U.pickTargetFolder("请选择学员档案存放位置");

        const studentFolderPath = U.joinPath(basePath, studentName);
        const archiveFilePath = U.joinPath(studentFolderPath, studentName + ".md");

        await U.ensureFolderWithConfirm(
            studentFolderPath,
            "文件夹 \"" + studentFolderPath + "\" 已存在，是否继续写入档案页？\n(点击取消则停止)"
        );

        const frontmatter = U.buildFrontmatter(U.buildArchiveFrontmatterFields({
            kind: "vip",
            startingDate: startingDate,
            scheduleType: scheduleType,
            courseType: courseType,
            subject: subject
        }));
        const body = U.buildArchiveBody({
            kind: "vip",
            archiveName: studentName,
            courseType: courseType
        });
        const action = await U.writeOrUpdateFile(archiveFilePath, frontmatter + body);
        new Notice("✅ 档案已" + (action === "created" ? "创建" : "更新") + "：" + archiveFilePath);

        await U.openFile(archiveFilePath);
    } catch (err) {
        console.error("One-on-One Archive Error:", err);
        new Notice("❌ 建档失败：" + err.message);
    }
};
`;
