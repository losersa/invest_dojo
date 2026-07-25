# InvestDojo 变更日志（change-log）

> 每次代码改动完成后追加一条，**最新在最上**。
> 由 `.codebuddy/skills/dev-docs/` 工作流维护；Epic/模块级里程碑另见
> `apps/web/src/app/admin/progress/progress-data.json`（生成 `progress-log.md`）。

---

## 2026-07-25（补 2）· 例行任务可观测性（数据管理页图表）

- **改动**：数据管理页新增「例行任务巡检」区块——近 14 天任务状态格点表（4 个 celery
  例行任务的成功/失败/跳过）+ 近 30 天每日写入量条形图（5m/1d/快照/因子值）；
  全部读中间表，页面访问不扫大表。
- **涉及文件**：`migrations/007_routine_observability.sql`（routine_task_runs +
  daily_data_metrics + idx_klines_all_tf_dt）、`train-svc/feature_tasks.py`
  （`_record_run` 埋点 + `collect_daily_metrics_task` 每日 20:00 汇总）、
  `train-svc/celery_worker.py`（beat ④）、`data-svc/routers/admin.py`（routine 三端点）、
  `apps/web/src/app/admin/data/page.tsx`（RoutineSection）。
- **验证**：30 天回填完成（120 行，67.8s）；图表即刻暴露因子 7-20/21 仅 281 行、
  7-23/24 为 0（待回补）；`/admin/data` 200、代理链路端到端通。
- **遗留**：因子值 7-23/24 缺口需补算（`feature.compute_range` 或等下周一只会覆盖新日期）。

---

## 2026-07-25（补）· git 版本管理恢复

- **改动**：工作区重建 git 管理——`git init` + 关联远程 `github.com/losersa/invest_dojo`
  （确认项目确为该仓库 clone，`.git` 在磁盘事故中丢失）；`git add -A` 时 git 自动识别出
  245 项 rename（远程 `investdojo/` 子目录 = 工作区根），以 `origin/main`(7962e5a, 07-17)
  为父提交快照提交（ef63ba2），49 提交历史完整保留。
- **验证**：`git log` 历史连通；`.gitignore` 补充排除运行时产物（logs/.venv/.task_history 等）。
- **推送**：已配置 HTTPS PAT 凭证并推送成功 → 远程新分支 `devcloud-snapshot`（2026-07-25）；
  之后日常改动高频 `git commit` 并推送。
- **合并 main**（2026-07-25）：保留外层有价值资产（investdojo-dev skill、CI workflows、
  pre-commit）后，main 快进至 `378e48e`；远程 main 结构统一为 devcloud 工作区结构
  （investdojo/ 子目录提升为根）；日常推送命令 `git push origin master:main`。

---

## 2026-07-25 · 告警中心 + 训练页因子修复 + 5m K线管线 + 磁盘事故 + 快照回滚重建

> ⚠️ 本日工作区曾因 devcloud 磁盘扩容被快照回滚，全部改动丢失后按记录重建
> （详见 `dev-troubleshooting.md` ## 18）。

- **改动**：
  1. 新增 admin 告警中心：monitor-svc `GET /api/v1/monitor/alerts`（6 模块报表+告警，
     含磁盘/市场快照监控）+ 前端 `/admin/alerts` 页面 + 导航入口；
  2. PG 连接池改 `ThreadedConnectionPool` + keepalive + maxconn 20，alerts 聚合加 Semaphore(6)；
  3. 训练页因子加载修复：`has_values` 标注 select_all 拉全量行（单页 15s+/60s 超时）
     → 主键索引 EXISTS（<150ms，~400 倍）；`list_factors` 新增 `value_start/value_end`
     区间判定；TrainPage 因子列表随训练区间 400ms 防抖重拉、无值因子禁选、默认区间近 3 个月；
  4. `batch_compute.py` 0 条写入告警放宽（`zero_records_written`）；
  5. **5m K线管线**：`scripts/update_5m_klines.py`（拉 5m→聚合日K落库，替代独立日K拉取），
     聚合日K与官方对比一致（open/close/volume/pctChg，high/low 偶差 0.01）；
     增量模式交易日自检（end 回退最近交易日，周末/节假日零空跑）；
  6. 例行化调度（celery beat）：17:35 5m K线（每天+自检）、17:45 市场快照（每天）、
     19:00 因子增量（仅工作日，原 17:00 改来）；
     admin 数据管理页注册 `update_5m_klines` / `backfill_5m_klines`；
  7. 前端 explorer/page.tsx 构建修复（非法命名导出 + Dispatch 类型）；生产构建发布（next start）；
  8. 新建 `.codebuddy/skills/dev-docs/` 文档工作流 skill（含 progress 同步流程）。
- **涉及文件**：见各功能说明文档（`docs/features/alerts-center.md`、`klines-5m-pipeline.md`）。
- **原因/背景**：训练页因子"加载不出来"排查（422 → 15s 慢查询双层根因）；K线数据例行化
  需求（5m 拉取+聚合日K）；排查中暴露连接池/进程管理/磁盘/回滚系列坑
  （手册 ## 11-18）。
- **验证**：`/api/v1/monitor/alerts` 全模块 ok；因子列表全页 <150ms、区间判定正确
  （近 3 月 100/100 可选、1 月 0/100 禁选）；聚合日K与官方对比一致；
  交易日自检周六实测正确回退；`/`、`/train`、`/admin/alerts`、`/admin/progress` HTTP 200。
- **磁盘事故**：/data 100% 写满 → PG WAL 失败崩溃循环（手册 ## 17）。清 18.1GB 无引用
  镜像恢复；告警中心已加磁盘监控（≥85%/≥95%）。用户随后扩容磁盘。
- **遗留**：
  1. 5m 回补（2026-05-01 起）在事故中中断，需断点续跑（增量模式自动从各股 MAX 续拉）；
  2. 基本面因子仅 ~202/2801 只股票有值（fundamentals JSONB 字段覆盖不足），待查；
  3. date_mask 时区 off-by-one（1d K线 `T00:00:00+08:00` vs UTC 边界）未修；
  4. uvicorn `--reload` 反复卡死（手册 ## 12），生产建议去掉；
  5. **项目无 git 版本管理**——本次回滚靠会话记录重建，强烈建议 git init + 高频提交。
