-- 007_routine_observability.sql
-- 例行化任务可观测性：运行记录 + 每日数据写入量中间表
--
-- 背景（2026-07-25）：例行任务（5m K线/市场快照/因子增量）每天跑得怎么样、
-- 数据有没有真正写进库，之前只能翻日志/查大表。这里建两张中间表，
-- 由 celery 任务埋点/汇总写入，admin 页面直接读（毫秒级，不扫大表）。

-- ── 例行任务运行记录 ──
-- 每个 celery 例行任务结束时写一条。
CREATE TABLE IF NOT EXISTS routine_task_runs (
    id            BIGSERIAL PRIMARY KEY,
    task_name     TEXT        NOT NULL,               -- 如 feature.update_klines_5m
    run_date      DATE        NOT NULL,               -- 北京时间日期（归属哪一天）
    status        TEXT        NOT NULL
                  CHECK (status IN ('success', 'failed', 'skipped')),
    detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- 任务返回的 summary/错误
    duration_sec  NUMERIC(10,1),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routine_runs_name_date
    ON routine_task_runs (task_name, run_date DESC);

-- ── 每日数据写入量（图表数据源）──
-- 每天 20:00 由 celery 汇总任务按"数据所属日期"聚合写入（幂等 upsert）。
CREATE TABLE IF NOT EXISTS daily_data_metrics (
    date            DATE   NOT NULL,
    metric          TEXT   NOT NULL
                    CHECK (metric IN ('klines_5m', 'klines_1d', 'market_snapshots', 'feature_values')),
    rows_count      BIGINT NOT NULL DEFAULT 0,        -- 该日该表的数据行数
    symbols_covered INT,                              -- K线类：覆盖股票数
    collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (date, metric)
);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_metric_date
    ON daily_data_metrics (metric, date DESC);

-- ── K线表按 (timeframe, dt) 的辅助索引 ──
-- 汇总查询按 timeframe + 日期范围 count；既有索引前导列是 symbol 用不上，
-- 全表 2800w+ 行 seq scan 会拖慢每日汇总，故加此复合索引。
-- （同时利好 supabase_client._latest_kline_date 之类的 order dt desc limit 1 查询）
CREATE INDEX IF NOT EXISTS idx_klines_all_tf_dt ON klines_all (timeframe, dt);
