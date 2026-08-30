/**
 * 班课每课记录脚本
 * 释放到 00.SYSTEM/xdf_base/scripts/班课每课记录.js
 *
 * 编排：选档案 → 学员表 → 课次/课型/班型 → 时间 → 7 文件包 → 档案回填
 */

export const LESSON_CLASS_RECORD_SCRIPT = String.raw`module.exports = async () => {
    try {
        const utilsCode = await app.vault.adapter.read("00.SYSTEM/xdf_base/utils/ArchiveUtils.js");
        const utilsModule = { exports: {} };
        new Function("module", "exports", "app", utilsCode)(utilsModule, utilsModule.exports, app);
        const U = utilsModule.exports;

        const picked = await U.pickArchiveByKind("class", "请选择班级档案");
        if (!picked) return;

        const parsed = U.parseFrontmatter(picked.content);
        const subject = parsed.meta.subject || null;
        const courseType = U.lastCourseType(parsed, "班课");
        const scheduleType = parsed.meta.schedule_type || "full-time";
        const time = await U.pickLessonTime(U.CLASS_TIME_SLOTS);
        const parentFolder = picked.file.parent.path;
        const lessonNumber = U.getNextLessonNumber(parentFolder);
        const needSendFeedback = scheduleType === "weekend" || lessonNumber % 2 === 0;
        const students = U.parseStudentsFromTable(picked.content);

        const pkg = await U.writeLessonPackage({
            kind: "class",
            archiveName: picked.name,
            parentFolder: parentFolder,
            lessonNumber: lessonNumber,
            isoDate: time.iso,
            month: time.month,
            day: time.day,
            courseType: courseType,
            subject: subject,
            needSendFeedback: needSendFeedback,
            overwrite: false,
            students: students
        });

        await U.updateArchiveAfterLesson({
            archiveFile: picked.file,
            link: U.buildIndexLink("class", pkg.folderName, lessonNumber, time.dateStr),
            lessonNumber: lessonNumber,
            dateStr: time.dateStr,
            isNewCourseType: false,
            courseType: courseType,
            indexHeader: U.INDEX_HEADER
        });

        await U.openFile(pkg.folderPath + "/" + pkg.names.nav + ".md", true);
        new Notice("✅ Lesson " + lessonNumber + " 创建完成");
    } catch (err) {
        new Notice("❌ " + err.message, 6000);
        console.error(err);
    }
};
`;
