# K线数据管线（5m 例行拉取 → 聚合日K）

> 创建：2026-07-25 · 状态：✅ 已上线
> 变更日志：见 `docs/ops/change-log.md`（搜"5m K线"）

## 功能概述

K线数据例行化管线：**每个交易日盘后拉取 5 分钟 K线 → 落库 → 同进程聚合出日 K 落库**，
替代原先独立的日 K 拉取（`update_daily_klines.py` 保留为备用，不再例行跑）。
日 K 由 5m 直接算出，K线图/因子引擎读日 K 时无需再实时聚合。

## 数据流

```
BaoStock (frequency="5", adjustflag=2 前复权)
  → scripts/update_5m_klines.py
    → upsert klines_all(timeframe='5m')        # dt 由 time 字段解析为 ISO+08:00
    → 内存聚合（OHLCV/turnover/pre_close/change_percent）
    → upsert klines_all(timeframe='1d')        # dt = {date}T00:00:00+08:00
```

- 聚合首日的 `pre_close` 查库取该股前一交易日 1d close（走 symbol 索引点查）
- 5m 接口不支持 `pctChg` 字段（报 10004012），`change_percent` 由聚合自算
- 与官方日 K 对比：open/close/volume/pctChg 一致；high/low 偶差 0.01（集合竞价 tick）

## 例行化调度（celery beat）

分层原则：**「是否交易日」由数据源自检判定，不靠星期几硬编码**（星期几不可靠：
调休/规则变化/其他市场都可能打破"周一~周五开市"假设）。

| 时间 | 任务 | 交易日判定 |
|---|---|---|
| 17:35 每天 | `feature.update_klines_5m` | 脚本自检：end 回退到最近交易日，非交易日零成本退出 |
| 17:45 每天 | `feature.update_market_snapshots` | 脚本内对非交易日自然跳过 |
| 19:00 仅工作日 | `feature.compute_incremental`（days=2） | 周末 A 股必闭市无新 K线可算；周一 days=2 自动覆盖周末 |

配置位置：`python-services/train-svc/celery_worker.py::beat_schedule`；
任务实现：`python-services/train-svc/feature_tasks.py`。

## 手动操作入口

- **admin API**（数据管理页可触发）：
  - `update_5m_klines` — 增量更新（MAX(5m)+1 → 今天；自带交易日自检与断点续跑）
  - `backfill_5m_klines` — 回补空缺段（`--from 2026-05-01 --to 今天`）
- **脚本直跑**：
  ```bash
  cd python-services
  .venv/bin/python ../scripts/update_5m_klines.py                          # 增量
  .venv/bin/python ../scripts/update_5m_klines.py --from 2026-05-01 --to 2026-07-24  # 回补
  .venv/bin/python ../scripts/update_5m_klines.py --limit 10 --dry-run     # 测试
  ```

## 注意事项（已知坑）

- **BaoStock 限流**：间歇返回 `10001011 黑名单用户`（非真封禁），脚本已带退避重试
  （登录 5 次、拉取每股 3 次 + 重连）；大批量回补时速率 ~80 支/min 属正常。
- **全新股票**的 5m 起点是 `BACKFILL_DEFAULT_START=2026-01-01`（5m 数据量大，不从 2020 拉）。
- 非交易日/停牌股 BaoStock 返回空 → 跳过计数，不算失败。
- 聚合 1d 会 upsert 覆盖同日官方日 K（值同源一致，仅 high/low 可能 0.01 差）——可接受。
- celery 改动后必须重启 worker+beat 并确认 beat 唯一（见 dev-troubleshooting.md ## 12）。
- 大批量回补期间盯 `df -h /data`（WAL 持续增长，手册 ## 17 的磁盘事故就是在回补中发生）。

## 变更历史

- 2026-07-25：初版上线；回补 2026-05-01 起 5m 空缺段；market_snapshots 回补至 2026-07-24；
  因子增量调度 17:00 → 19:00（排在 K线后）；调度分层按"数据源自检"重构（不用星期几）
