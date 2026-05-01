-- ===============================================================
-- InvestDojo · Legacy tables bootstrap (for Supabase Lite)
-- ===============================================================
-- 这 3 张表原本在 Supabase Cloud 是"已有表"，migrations/001~005.sql
-- 只 ALTER 不 CREATE。但在本地自托管时我们是从零开始，所以要先
-- 建出它们的原始结构（字段定义抄自 docs/architecture/01_数据层.md §3.1-§3.3）。
--
-- 之后 migrations/003_alter_klines_all.sql 和 004_alter_news.sql
-- 会在这些表上做 ALTER 扩展，migrations/005_rls_policies.sql 会
-- 给它们加 RLS。
--
-- 幂等：全部用 CREATE TABLE IF NOT EXISTS。
-- ===============================================================

-- ---- 1. scenarios · 情景定义 -----------------------------------
CREATE TABLE IF NOT EXISTS scenarios (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    category        TEXT,                      -- black_swan/bull/trade_war/industry
    difficulty      TEXT,                       -- easy/medium/hard
    date_start      DATE,
    date_end        DATE,
    symbols         JSONB,                      -- ["000001", "600519"]
    initial_capital NUMERIC,
    tags            JSONB,
    cover_image     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE scenarios IS 'Scenarios for blind/classic/custom simulation modes';


-- ---- 2. klines_all · K线（多周期）-------------------------------
-- 原始定义：scenario_id NOT NULL；后续 003_alter 会改为可空 + adj_factor
CREATE TABLE IF NOT EXISTS klines_all (
    id              BIGSERIAL PRIMARY KEY,
    scenario_id     TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    timeframe       TEXT NOT NULL,              -- 1m/5m/15m/1h/1d/1w/1M
    dt              TIMESTAMPTZ NOT NULL,
    open            NUMERIC(12,4),
    high            NUMERIC(12,4),
    low             NUMERIC(12,4),
    close           NUMERIC(12,4),
    volume          BIGINT,
    turnover        NUMERIC(20,2),
    pre_close       NUMERIC(12,4),
    change_amount   NUMERIC(12,4),
    change_percent  NUMERIC(8,4)
);

-- 原有索引
CREATE INDEX IF NOT EXISTS idx_klines_symbol_timeframe
    ON klines_all(symbol, timeframe, dt DESC);

COMMENT ON TABLE klines_all IS 'Multi-timeframe K-line data';


-- ---- 3. news · 新闻 ---------------------------------------------
-- 原始定义：只有 date DATE；后续 004_alter 会加 published_at、tags 等
CREATE TABLE IF NOT EXISTS news (
    id              TEXT PRIMARY KEY,
    scenario_id     TEXT,
    date            DATE NOT NULL,
    title           TEXT NOT NULL,
    content         TEXT,
    source          TEXT,
    category        TEXT,                      -- macro/policy/industry/company/market
    sentiment       TEXT,                       -- positive/neutral/negative
    impact_level    INT,                        -- 1-5
    related_symbols JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_date ON news(date DESC);

COMMENT ON TABLE news IS 'Scenario/market news';
