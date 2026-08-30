# XDF-Base

XDF 教学系统核心 Obsidian 插件：在 [QuickAdd](https://github.com/chhoumann/quickadd) 引擎之上扩展了新东方教学业务所需的脚本释放、Choice 同步、AI 调用与 SQLite 数据库能力。

> 本插件是 QuickAdd 的深度定制分支。QuickAdd 的模板（Template）/ 捕获（Capture）/ 宏（Macro）/ 组合（Multi）Choice 引擎完整保留，XDF 自研代码位于 `src/xdf/`，与上游源码物理隔离。

## 功能

### 1. 预设脚本自动释放

每次插件启动时，把内置脚本（建档、每课记录、AI 出题等）**全量释放**到 vault 的 `00.SYSTEM/xdf_base/` 目录：

- 脚本升级随插件更新自动送达，无需手动同步
- 缺失自动补回（自愈）
- 只覆盖预设清单内的文件，用户新建的脚本不受影响

### 2. Choice 自动同步

- 预设 Choice（id 前缀 `xdf-base-`）按 id **原位覆盖**，保留用户排序
- 缺失的预设 Choice 自动追加
- 用户自建的 Choice 与其他设置完全不动

### 3. 教学记录脚本（QuickAdd UserScript）

内置 7 文件课次包体系：每节课生成 `nav / Note / Wordlist / Grammar / Homework / Quiz / Feedback`，统一 frontmatter 契约：

- 档案页：`#档案` + `#vip`（一对一）/ `#class`（班课）
- 课次页：`#课程记录` + `#vip` / `#class`，frontmatter `links` 维护 上一课 → 档案首页 → 下一课 链接链
- 公共工具函数集中在 `00.SYSTEM/xdf_base/utils/ArchiveUtils.js`，业务脚本只做编排

### 4. AI 能力

内置 AI（LLM）调用能力，供脚本以函数形式调用（作业生成、词表生成、反馈总结等），设置页不需要用户填写 prompt。

### 5. SQLite 数据库（建设中）

基于 sql.js (WASM) 的 vault 数据同步层：vault 文件变更实时监听（debounce），数据落地到 `vault/.xdf/xdf.db`，供 MCP 工具查询。

## 构建

```bash
pnpm install
pnpm run build     # 产物输出到 dist/（main.js + styles.css + manifest.json）
```

将 `dist/` 下的三件套拷贝到 `vault/.obsidian/plugins/xdf-base/` 即可安装。

开发模式：

```bash
pnpm run dev       # watch 增量构建
```

## 使用

1. 启用插件后，脚本自动释放到 `00.SYSTEM/xdf_base/`
2. QuickAdd 菜单中出现预设 Choice（一对一建档 / 班课建档 / 每课记录等）
3. 设置页提供脚本重新释放、数据库状态等管理入口

## 致谢

- 上游项目：[QuickAdd by chhoumann](https://github.com/chhoumann/quickadd)（MIT License）
- 本插件延续上游 MIT 协议开源
