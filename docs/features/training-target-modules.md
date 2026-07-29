# 模型训练 · 按预测目标股票分模块

> 创建：2026-07-27 · 状态：✅ 已上线（迁移 008 已执行，train-svc 已热更）
> 变更日志：见 `docs/ops/change-log.md`（搜"预测目标股票分模块"）

## 功能概述

把模型训练按「预测目标股票」组织成若干**模块**：每个模块 = 一只预测目标股票
（或「全市场面板」）。点击模块进入训练页，该目标下的历史任务与参数自动归拢，
点任务即可把参数回填表单继续改、再训练。同时通过 `X-User-Id` 把**参数（config）
与结果（model）按「用户主键 id + 任务 id」归属保存**，实现多用户隔离与复用。

设计要点：**模块卡片是数据驱动的**——按 `training_jobs.target_symbol` 聚合，
不预置固定股票池；用户每用某目标训练一次，就自动多一张卡片。

## 使用入口

- 页面：`http://localhost:3000/train` → 训练首页（模块列表）
  - 卡片区：每个 `target_symbol` 一张卡（股票名 + 行业、任务数、已完成数、
    最近状态）；「全市场面板」单独一组（= `target_symbol IS NULL`）。
  - 顶部入口：输入 6 位代码「进入训练」／「＋新建训练目标」(`?target=new`)／
    「全市场面板训练」(`?target=__all__`)。
  - 点卡片 → `/train?target=CODE`（预测目标锁定、最近任务只看该目标）。
- 训练页（`TrainPage`）：左侧参数表单、右侧监控 + 「最近任务」。
  - 进入具体股票模块时标题显示「预测 CODE」，说明自动取同业股票池、标签只留该股。
  - 「最近任务」标题标注当前范围（预测 CODE／全市场面板／我的全部）。
  - 点历史任务：参数回填表单并高亮「✓ 参数已填充」，可直接改后再训练。
- API（train-svc :8002）：
  - `GET /api/v1/training/targets?user_id=` —— 按目标聚合（分模块数据源）
  - `GET /api/v1/training/jobs?target_symbol=CODE&user_id=` —— 按目标过滤
    （`target_symbol=__none__` 只取全市场面板）
  - `POST /api/v1/training/jobs`（带 `X-User-Id` header）—— 提交时写入
    `user_id` 与 `config.owner`

## 架构与数据流

```
TrainHome（/train）
  ├─ GET /training/targets  → 按 target_symbol 聚合出模块卡片
  └─ 点卡片 → /train?target=CODE

TrainPage（/train?target=CODE）
  ├─ 初始 targetSymbol = CODE（锁定提示，仍可改）
  ├─ 最近任务 = GET /training/jobs?user_id=&target_symbol=CODE
  ├─ 点任务 → applyConfig(历史 config) 回填表单 + pollJob 拉结果
  └─ 提交 → POST /training/jobs（X-User-Id）
                ├─ training_jobs.user_id = 用户主键 id
                ├─ training_jobs.target_symbol = config.target_symbol
                └─ config.owner = 用户主键 id
                      ↓ 训练完成
                   models.owner = 同一用户 id
                   model_versions.training_job_id = 该任务（结果按 用户+任务 可取回）

DB：training_jobs
  ├─ target_symbol TEXT（独立列，冗余自 config，供索引/分组/过滤）
  ├─ user_id UUID → FK auth.users(id) ON DELETE SET NULL
  └─ 索引：user_created / target_created / user_target
```

- 迁移：`migrations/008_training_jobs_user_target.sql`
  （`target_symbol` 列 + `user_id` 外键 + 3 索引 + 历史回填；已执行）
- 后端：`python-services/train-svc/main.py`（create/list/targets）、
  `python-services/train-svc/common_utils.py`（TrainJobConfig 字段 + extra=allow）
- SDK：`packages/api/src/train-client.ts`（`listTargets` + `listJobs` 加
  `target_symbol` + `X-User-Id` 注入）、`packages/api/src/types/training.ts`
  （`TrainingJob.target_symbol`、`TrainingTargetGroup`）
- 前端：`apps/web/src/app/train/page.tsx`（路由）、`TrainHome.tsx`（模块首页）、
  `TrainPage.tsx`（参数回填 + 最近任务过滤）

## 用户主键关联

- 用户主键 = `profiles.id`（UUID）= `auth.users.id`。
- `training_jobs.user_id` 加外键 `REFERENCES auth.users(id) ON DELETE SET NULL`
  （用户注销保留任务、仅解除归属；匿名任务 user_id 为 NULL，不受 FK 约束）。
- `models.owner` 存同一 UUID，与任务同属一个用户，**均用主键关联**，非业务字段。

## 配置项 / 说明

- `_resolve_user_id` 对 `X-User-Id` 做宽松校验（anon/undefined/短串视为匿名，
  user_id 留 NULL、owner 回退 `platform`），避免污染用户列。
- 匿名（未登录）提交：参数/结果仍归属 `platform`，与旧行为兼容；登录后才按
  用户归拢、模块页与最近任务按用户过滤。
- `TrainJobConfig` 加 `extra="allow"`：保留未声明扩展字段，向后兼容历史 config。

## 注意事项（已知坑）

- **卡片是数据驱动**：历史 19 个任务均为全市场面板（原 `TrainJobConfig` 会
  静默丢弃 `target_symbol`/`peer` 字段，导致 config 无 `target_symbol`），
  故迁移回填后 `target_symbol` 全为 NULL，首页当前只显示「全市场面板」一张卡。
  **用某目标训练一次后（模块页已锁定目标）即自动出现对应卡片**——属预期。
- 模块首页卡片股票名经 `sdk.data.getSymbol` 解析；解析失败（代码不在 symbols
  表）时降级显示代码，不阻断卡片渲染。
- 若要在「不训练」时就把当前参数存成草稿/预设以便复用，可加 `training_presets`
  表（按用户 + 预设 id）——当前「保存参数」= 每次提交任务即持久化并可复用，
  未另设草稿表。

## 变更历史

- 2026-07-27：初版上线——训练分模块首页 + URL 路由 + 最近任务按用户/目标过滤
  + 点任务回填参数 + 参数/结果按用户主键 id 与任务 id 归属 + 迁移 008（已执行）
  + 修复 TrainJobConfig 丢字段 bug。
