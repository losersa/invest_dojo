---
name: dev-docs
description: InvestDojo 项目文档工作流。本技能应在以下场景使用：(1) 排查并解决了一个非显然的问题/坑之后——把坑记录到 docs/ops/dev-troubleshooting.md 以免再犯；(2) 完成代码改动（修复、重构、优化、发布）之后——追加进度日志 docs/ops/change-log.md 并同步项目进展数据源 progress-data.json（驱动 /admin/progress 页面）；(3) 新增功能（页面、API 端点、模块、服务）之后——在 docs/features/ 下编写功能说明文档。也应在开始排查问题前使用——先查踩坑记录，避免重复排查。
---

# Dev Docs · 项目文档工作流

三条规定动作，在对应场景**完成后立即执行，不等用户提醒**：

| 场景 | 动作 | 落盘位置 |
|---|---|---|
| 排查/解决了非显然的坑 | 追加踩坑条目 | `docs/ops/dev-troubleshooting.md` |
| 完成代码改动（fix/refactor/发布/优化） | 追加进度条目 + **同步项目进展** | `docs/ops/change-log.md` + `apps/web/src/app/admin/progress/progress-data.json` |
| 新增功能（页面/端点/模块/服务） | 新建功能说明 | `docs/features/<功能名>.md` |

模板在 `assets/` 下：`pitfall-entry-template.md`、`progress-entry-template.md`、`feature-doc-template.md`。

## 场景 0：排查问题之前（先查）

开始排查"页面空白 / 加载失败 / 端口被占 / 数据为空 / 服务 500"类问题前，先 grep `docs/ops/dev-troubleshooting.md` 是否已有同类坑及标准解法：

```bash
grep -n -i "<关键词>" docs/ops/dev-troubleshooting.md
```

命中则按既有解法处理；未命中且解决后，按场景 1 回写。

## 场景 1：记录踩坑（解决后必记）

**触发条件**（满足其一即记）：
- 排查耗时超过几分钟、根因非显然（配置/环境/框架行为/并发/时区等）；
- 同一类问题第二次出现；
- 修复手法可复用（标准命令、标准检查项）。

**步骤**：
1. 复制 `assets/pitfall-entry-template.md` 的条目格式；
2. 追加到 `docs/ops/dev-troubleshooting.md` 末尾，沿用既有章节式编号 `## N. <标题>（日期）`（N = 现有最大章节号 + 1）；与既有坑同类的，并入该章节作子条目；
3. 条目必须包含：**现象**（可搜索的报错原文/关键词）、**根因**、**修复**（具体命令/代码位置）、**防范**（如何避免再犯）。现象一节写足可搜索关键词，方便场景 0 的 grep 命中。

## 场景 2：追加进度日志 + 同步项目进展（代码更新后）

**触发条件**：任何合入工作区的代码改动完成并验证后（修复、重构、新特性、发布、运维操作）。**每次都必须做全下面两步。**

**步骤 1 · 轻量日志**：复制 `assets/progress-entry-template.md` 的格式，追加到 `docs/ops/change-log.md` 顶部"最新在上"。条目写清：日期、改动概述、涉及文件（带路径）、原因/背景、验证方式、遗留问题；单条不超过 15 行，细节多就链到功能说明文档或踩坑条目。

**步骤 2 · 同步 /admin/progress 数据源**：在 `apps/web/src/app/admin/progress/progress-data.json` 的 `log` 数组**最前面**插入本次进展条目（该 json 直接驱动 `/admin/progress` 页面）。格式沿用既有条目：

```json
{
  "date": "YYYY-MM-DD",
  "status": "一句话总结",
  "highlights": [ { "title": "主题", "items": ["要点1", "要点2"] } ],
  "files": ["涉及文件路径"]
}
```

- `highlights` 1~4 个主题，每个 `items` 2~4 条要点，面向"看进展的人"而非开发者，少写实现细节多写结果；
- 改完必须验证：`python3 -c "import json; json.load(open('.../progress-data.json'))"`；
- **生产模式下该 json 是静态 import 打包进 bundle 的，改完必须重新 `pnpm build:web` + 重启 `next start`**，并 `grep -rl "新日期" apps/web/.next/static/chunks/` 确认已打包（curl 页面 HTML grep 不到是正常的，客户端渲染）；最后提醒用户强刷浏览器（Ctrl+Shift+R）；
- 若改动推进了 Epic/模块进度（如某模块 0→1），同步更新 `epics[].done/status` 与 `modules[].progress/details`；纯日常改动不动这两节；
- 随后在 `docs/ops/progress-log.md` 顶部手动补一节相同内容（该文件原是 Windows ps1 脚本从 json 生成的，Linux 环境无脚本，手动保持同步，并在首部注明"最后更新"日期）。

## 场景 3：写功能说明（新增功能后）

**触发条件**：新增页面、API 端点、模块、服务、定时任务等用户可用/可感知的功能。

**步骤**：
1. 复制 `assets/feature-doc-template.md` 到 `docs/features/<kebab-case-功能名>.md`；
2. 按模板填写：功能概述、使用入口、架构与数据流、API 清单、配置项、注意事项（已知坑）、变更历史；
3. 若功能伴随新的运维操作（重启步骤、新定时任务），同时在 `docs/ops/change-log.md` 记进度条目并互相链接。

## 通用要求

- 全部用简体中文书写；
- 文档里引用代码时带绝对路径或仓库相对路径 + 行号；
- 日期用 `YYYY-MM-DD`；
- `docs/ops/progress-log.md` 只在顶部追加"最新进展"一节并更新"最后更新"日期，下方生成区（Epic/模块表格）不要手改；
- 写完条目后不需要提交 git（除非用户明确要求）。
