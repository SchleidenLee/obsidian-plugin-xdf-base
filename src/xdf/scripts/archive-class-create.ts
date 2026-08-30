/**
 * 班课建档脚本
 * 释放到 00.SYSTEM/xdf_base/scripts/班课建档.js
 */

export const ARCHIVE_CLASS_CREATE_SCRIPT = String.raw`module.exports = async () => {
    try {
        const utilsCode = await app.vault.adapter.read("00.SYSTEM/xdf_base/utils/ArchiveUtils.js");
        const utilsModule = { exports: {} };
        new Function("module", "exports", "app", utilsCode)(utilsModule, utilsModule.exports, app);
        const U = utilsModule.exports;

        const className = await U.qa().inputPrompt("请输入班级名称（如：G3-01班）");
        if (!className) throw new Error("班级名称不能为空");

        const startingDate = await U.pickStartingDate();
        const scheduleType = await U.pickScheduleType("请选择班级类型");
        const courseType = await U.pickCourseType();
        const subject = await U.pickSubjectIfIELTS(courseType);

        const studentListInput = await U.qa().inputPrompt(
            "请输入学员名单（用空格分隔）\n例如：张三 李四 王五",
            "张三 李四"
        );
        if (!studentListInput) throw new Error("学员名单不能为空");
        const students = studentListInput.split(/\s+/).map(function (s) { return s.trim(); }).filter(Boolean);

        const basePath = await U.pickTargetFolder("请选择存放班级文件夹的位置");
        const classFolderPath = U.joinPath(basePath, className);
        const created = await U.ensureFolder(classFolderPath);
        new Notice(created
            ? "📁 班级文件夹 \"" + className + "\" 已创建"
            : "📁 班级文件夹 \"" + className + "\" 已存在");

        const frontmatter = U.buildFrontmatter(U.buildArchiveFrontmatterFields({
            kind: "class",
            startingDate: startingDate,
            scheduleType: scheduleType,
            courseType: courseType,
            subject: subject,
            studentCount: students.length
        }));
        const body = U.buildArchiveBody({
            kind: "class",
            students: students
        });
        const archiveFilePath = U.joinPath(classFolderPath, className + ".md");
        const action = await U.writeIfNotExists(archiveFilePath, frontmatter + body);
        if (action === "created") new Notice("📄 班级主页已创建");

        await U.openFile(archiveFilePath, true);
        new Notice("✅ 班级 \"" + className + "\" 创建完成！");
    } catch (err) {
        new Notice("❌ 运行失败：" + err.message, 6000);
        console.error("Class Archive Error:", err);
    }
};
`;
