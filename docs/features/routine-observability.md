# 例行任务可观测性（运行记录 + 每日写入量图表）

> 创建：2026-07-25 · 状态：✅ 已上线
> 变更日志：见 `docs/ops/change-log.md`（搜"例行任务"）

## 功能概述

让 celery 例行任务（5m K线 / 市场快照 / 因子增量 / 每日汇总）的**每天运行情况**和
**数据是否真正写进库**在数据管理页一目了然——出问题不再依赖翻日志/查大表。

设计要点：**读接口全部走中间表（毫秒级），不在页面访问时实时扫大表**。

## 使用入口

- 页面：`http://localhost:3000/admin/data` → 顶部「例行任务巡检」区块
  - 状态格点表：近 14 天 × 4 任务（✓ 成功 / ✗ 失败 / ⊘ 非交易日跳过 / · 未运行）
  - 写入量条形图：近 30 天 × 4 指标（5m K线/日K/快照/因子值，行内各自归一化）
  - 「手动汇总」按钮：触发近 3 天汇总重算
- API（data-svc :8006，需 admin header）：
  - `GET /api/v1/data/admin/data/routine/runs?days=14`
  - `GET /api/v1/data/admin/data/routine/metrics?days=30`
  - `POST /api/v1/data/admin/data/routine/collect?days=N&date=YYYY-MM-DD`

## 架构与数据流

```
celery 例行任务（feature_tasks.py）
  ├─ 结束时埋点 → routine_task_runs        # 运行记录（状态/耗时/详情）
  └─ 每天 20:00 collect_daily_metrics
       → 按数据所属日聚合各表行数 → daily_data_metrics   # 图表数据源（幂等 upsert）

/admin/data 页面 → /svc/data 代理 → data-svc routine 端点 → 读两张中间表
```

- 中间表迁移：`migrations/007_routine_observability.sql`（含 `idx_klines_all_tf_dt` 索引）
- 埋点/汇总实现：`python-services/train-svc/feature_tasks.py`
  （`_record_run`、`collect_daily_metrics_task`）
- API：`python-services/data-svc/routers/admin.py`（routine 三个端点）
- 前端：`apps/web/src/app/admin/data/page.tsx::RoutineSection`

## 判定语义

- 写入量按**数据所属日期**统计（非写入时间）：周末/节假日为 0 属正常，
  **交易日为 0 = 异常信号**（任务没跑或数据源没出数）。
- `skipped` = 非交易日自检退出（零成本空转），非异常。
- klines 按北京日归属（`dt AT TIME ZONE 'Asia/Shanghai'`）。

## 配置项

- 汇总调度：celery beat `daily-metrics-collect` 每天 20:00（K线/因子任务之后）
- runs 默认近 14 天、metrics 默认近 30 天（API 参数可调，上限 90/365）

## 注意事项（已知坑）

- 汇总任务本身也写 `routine_task_runs`（自监控）；
- 回填历史：`POST /routine/collect?days=30`（约 1-2 分钟，klines count 走新索引）；
- `feature_values` 按 date 分区裁剪，`klines_all` 依赖 `idx_klines_all_tf_dt`（007 已建）——
  若未来新增大盘表到监控，记得同步检查索引；
- 因子增量仅工作日跑，周末格点为"未运行"属正常（与 skipped 语义不同：工作日非交易日
  才是 ⊘）。

## 变更历史

- 2026-07-25：初版上线（4 任务状态格点 + 4 指标 30 天条形图 + 手动汇总）
