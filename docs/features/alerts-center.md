# 告警中心（分模块数据报表 + 告警）

> 创建：2026-07-25 · 状态：✅ 已上线
> 变更日志：见 `docs/ops/change-log.md`（搜"告警中心"）

## 功能概述

面向内部员工的运维巡检页：把系统健康状况按 **6 个模块**（基础设施 / 微服务 / 数据 / 因子 /
训练 / 回测）聚合为实时数据报表 + 告警信息，替代人工翻日志排查"数据是不是没更新"
"任务是不是挂了"这类问题。

## 使用入口

- 页面：`http://localhost:3000/admin/alerts`（仅内部员工：admin/staff/employee，每分钟自动刷新）
- API：`GET /api/v1/monitor/alerts`（monitor-svc，:8005，无鉴权·内网信任）

## 架构与数据流

浏览器 → 同源代理 `/svc/monitor/*`（middleware 转发 :8005）→ monitor-svc
`alerts.py::collect_alerts_overview()` 并发采集 → 返回聚合 JSON：

- 前端：`apps/web/src/app/admin/alerts/page.tsx`（SDK：`sdk.monitor.getAlerts()`）
- 后端：`python-services/monitor-svc/alerts.py`（采集逻辑）、`monitor-svc/main.py`（路由）
- 数据来源：
  - infra/services：复用 `common_utils.probe_infra / probe_all_services`（Redis/MinIO/PG、5 个兄弟 svc /health）+ `shutil.disk_usage("/data")` 磁盘
  - data/feature/train/backtest：直连 PG 实时查询（klines_all、fundamentals、
    market_snapshots、factor_definitions、feature_values、training_jobs、backtests）

## 告警规则（当前版本）

| 模块 | 规则 |
|---|---|
| infra | 任一组件 down → critical；磁盘 ≥85% warning / ≥95% critical |
| services | 任一 svc 非 ok → critical |
| data | 1d K线最新日期落后今天 > 3 天 → warning；fundamentals 空 → warning；市场快照落后 > 3 天 → warning |
| feature | 近 7 天无因子值 → critical；因子值最新日期 < 1d K线最新日期 → warning；单日写入 < 1000 行 → warning |
| train/backtest | 最近 24h 有 failed 任务 → warning（含失败列表） |

模块状态取本模块告警最高级别，overall 取所有模块最差；`alerts` 数组含 `hint` 排查指引。

## 配置项

`alerts.py` 顶部常量：`KLINE_STALE_DAYS=3`、`FEATURE_LOOKBACK_DAYS=7`、
`JOB_FAILURE_WINDOW_HOURS=24`、DB 并发 `_DB_SEM=Semaphore(6)`、
`DISK_WARN_PCT=85 / DISK_CRIT_PCT=95`。

## 注意事项（已知坑）

- **feature_values 是 5000w+ 行分区表**：新鲜度用"逐天等值探测"而非全表 count/order desc
  （`_latest_feature_value_date`），改动时保持此约束（见 dev-troubleshooting.md ## 14）。
- 并发 DB 调用必须走 `_run_db()`（Semaphore 限流），直接 gather 会打爆连接池
  （见 dev-troubleshooting.md ## 11）。
- 当前为实时计算、无告警历史/已读；需要历史时再考虑落 `alerts` 表（新迁移）。
- monitor-svc 无鉴权，告警页若新增敏感操作需自行加角色校验。

## 变更历史

- 2026-07-25：初版上线（6 模块 + 实时告警 + 每分钟自动刷新 + 磁盘/快照监控）
