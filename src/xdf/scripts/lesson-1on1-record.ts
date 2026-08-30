/**
 * 一对一每课记录脚本
 * 释放到 00.SYSTEM/xdf_base/scripts/一对一每课记录.js
 *
 * 编排：选档案 → 课型继承 → 时间 → 7 文件包 → 档案回填
 */

export const LESSON_1ON1_RECORD_SCRIPT = String.raw`module.exports = async () => {
    try {
        const utilsCode = await app.vault.adapter.read("00.SYSTEM/xdf_base/utils/ArchiveUtils.js");
        const utilsModule = { exports: {} };
        new Function("module", "exports", "app", utilsCode)(utilsModule, utilsModule.exports, app);
        const U = utilsModule.exports;

        const picked = await U.pickArchiveByKind("vip", "请选择学员档案");
        if (!picked) return;

        const parsed = U.parseFrontmatter(picked.content);
        const subject = parsed.meta.subject || null;
        const pickedType = await U.pickCourseTypeWithDefault(U.lastCourseType(parsed));
        const time = await U.pickLessonTime(U.LESSON_TIME_SLOTS);
        const parentFolder = picked.file.parent.path;
        const lessonNumber = U.getNextLessonNumber(parentFolder);

        const pkg = await U.writeLessonPackage({
            kind: "vip",
            archiveName: picked.name,
            parentFolder: parentFolder,
            lessonNumber: lessonNumber,
            isoDate: time.iso,
            month: time.month,
            day: time.day,
            courseType: pickedType.courseType,
            subject: subject,
            needSendFeedback: true,
            overwrite: true
        });

        await U.updateArchiveAfterLesson({
            archiveFile: picked.file,
            link: U.buildIndexLink("vip", pkg.folderName, lessonNumber, time.dateStr),
            lessonNumber: lessonNumber,
            dateStr: time.dateStr,
            isNewCourseType: pickedType.isNew,
            courseType: pickedType.courseType,
            indexHeader: "### 🏷️ " + pickedType.courseType
        });

        await U.openFile(pkg.folderPath + "/" + pkg.names.nav + ".md");
        new Notice("✅ 第 " + lessonNumber + " 课记录包生成成功！");
    } catch (err) {
        console.error("One-on-One Lesson Record Error:", err);
        new Notice("❌ 生成失败：" + err.message);
    }
};
`;
