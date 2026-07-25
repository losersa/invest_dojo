-- ==============================================================
-- InvestDojo Migration 001 · 新建基础数据表
-- ==============================================================
-- 生成日期：2026-04-28
-- 对应任务：docs/product/99_MVP_Sprint0.md · T-1.01
-- 对应架构：docs/architecture/01_数据层.md §4
--
-- 本迁移新建以下表（基础数据层）：
--   symbols              股票元数据（全市场 5000+）
--   industries           行业分类
--   fundamentals         财报（季度）
--   market_snapshots     市场快照（指数/资金流）
--   scenario_reveals     盲测揭晓信息
--
-- 全部用 CREATE TABLE IF NOT EXISTS，可重复执行。
-- ==============================================================

-- ───────────────────────────────────────────
-- 1. symbols 股票元数据
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS symbols (
    code            TEXT PRIMARY KEY,                   -- "600519"
    market          TEXT NOT NULL,                      -- SH/SZ/BJ
    name            TEXT NOT NULL,                      -- 贵州茅台
    short_name      TEXT,
    industry        TEXT,                               -- 白酒
    industry_level2 TEXT,                               -- 食品饮料
    listed_at       DATE,
    delisted_at     DATE,
    total_share     NUMERIC(20, 4),                     -- 亿股
    float_share     NUMERIC(20, 4),
    status          TEXT DEFAULT 'normal',              -- normal/suspended/delisted
    tags            JSONB,                              -- ["沪深300", "红利"]
    meta            JSONB,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_symbols_market    ON symbols(market);
CREATE INDEX IF NOT EXISTS idx_symbols_industry  ON symbols(industry);
CREATE INDEX IF NOT EXISTS idx_symbols_tags      ON symbols USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_symbols_status    ON symbols(status);

COMMENT ON TABLE  symbols IS 'A 股全市场股票元数据';
COMMENT ON COLUMN symbols.code   IS '6 位证券代码，如 600519';
COMMENT ON COLUMN symbols.market IS '交易所：SH 沪 / SZ 深 / BJ 北';
COMMENT ON COLUMN symbols.tags   IS 'JSONB 数组：["沪深300", "红利", ...]';


-- ───────────────────────────────────────────
-- 2. industries 行业分类（申万/中信）
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS industries (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    level           INT NOT NULL,                       -- 1 / 2
    parent_id       INT REFERENCES industries(id),
    code            TEXT UNIQUE,                        -- 申万/中信编码
    symbol_count    INT DEFAULT 0,                      -- 冗余字段，定时更新
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_industries_level  ON industries(level);
CREATE INDEX IF NOT EXISTS idx_industries_parent ON industries(parent_id);

COMMENT ON TABLE industries IS '行业分类（申万/中信一级二级）';


-- ───────────────────────────────────────────
-- 3. fundamentals 财报
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fundamentals (
    id              BIGSERIAL PRIMARY KEY,
    symbol          TEXT NOT NULL,
    report_date     TEXT NOT NULL,                      -- "2024-Q1"/"2024-H1"/"2024-Q3"/"2024"
    announce_date   DATE NOT NULL,                      -- 公告日期，防未来函数关键
    statement       TEXT NOT NULL,                      -- income/balance/cashflow
    data            JSONB NOT NULL,                     -- 原始字段（revenue/net_profit/...)
    derived         JSONB,                              -- 派生指标（roe/eps/...）
    source          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (symbol, report_date, statement)
);

CREATE INDEX IF NOT EXISTS idx_fundamentals_symbol_announce
    ON fundamentals(symbol, announce_date DESC);
CREATE INDEX IF NOT EXISTS idx_fundamentals_announce_date
    ON fundamentals(announce_date);

COMMENT ON TABLE  fundamentals IS '财报数据（季度/半年/年度）';
COMMENT ON COLUMN fundamentals.announce_date IS '公告日期 · 防未来函数的关键字段';


-- ───────────────────────────────────────────
-- 4. market_snapshots 市场快照
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_snapshots (
    date            DATE PRIMARY KEY,
    indexes         JSONB,                              -- {"000001": {close, change_pct, volume}}
    north_capital   NUMERIC(20, 2),                     -- 北向资金净流入（亿）
    money_flow      JSONB,                              -- 主力/超大/大/中/小 净流入
    advance_decline JSONB,                              -- 涨跌家数、涨跌停
    top_industries  JSONB,                              -- 板块涨幅 top 5
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE market_snapshots IS '每日市场快照（指数/资金流/板块）';


-- ───────────────────────────────────────────
-- 5. scenario_reveals 盲测揭晓信息
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scenario_reveals (
    scenario_id     TEXT PRIMARY KEY REFERENCES scenarios(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    summary         TEXT,
    key_events      JSONB,                              -- [{date, title}]
    revealed_symbols JSONB,                             -- {"stock_A": {code, name}}
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  scenario_reveals IS '盲测场景的揭晓信息（会话结束后才能访问）';
