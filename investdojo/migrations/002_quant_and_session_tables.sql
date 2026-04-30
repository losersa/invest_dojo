-- ==============================================================
-- InvestDojo Migration 002 · 量化 + 联动模块表
-- ==============================================================
-- 对应架构：docs/architecture/01_数据层.md §4
-- 对应 ADR：docs/adr/0002-平台官方模型与用户模型同等待遇.md
--
-- 包含表：
--   【用户】profiles / user_preferences
--   【量化】factor_definitions / feature_values / models / model_versions
--          / backtests / training_jobs
--   【联动】sessions / session_participants / session_events / orders
--          / training_samples
--   【市场】model_stars / share_links
--
-- 注意：feature_values 预计 60 亿行，使用声明式分区（按年）
-- ==============================================================


-- ═══════════════════════════════════════════
-- 【用户】
-- ═══════════════════════════════════════════

-- profiles 用户资料（配合 Supabase Auth）
CREATE TABLE IF NOT EXISTS profiles (
    id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name     TEXT,
    avatar_url       TEXT,
    bio              TEXT,
    experience_level TEXT,                              -- newbie/intermediate/advanced
    preferred_mode   TEXT,                              -- classic/blind/custom
    total_sessions   INT DEFAULT 0,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE profiles IS '用户资料（Supabase Auth 扩展）';


-- user_preferences 用户偏好
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id                    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    default_copilot_model      TEXT,
    data_collection_opt_in     BOOLEAN DEFAULT TRUE,
    contribute_to_public_pool  BOOLEAN DEFAULT FALSE,
    notifications              JSONB,
    ui_theme                   TEXT DEFAULT 'dark',
    updated_at                 TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE user_preferences IS '用户个性化设置';


-- ═══════════════════════════════════════════
-- 【量化】
-- ═══════════════════════════════════════════

-- factor_definitions 因子定义
CREATE TABLE IF NOT EXISTS factor_definitions (
    id               TEXT PRIMARY KEY,                  -- "ma_cross_20_60"
    name             TEXT NOT NULL,
    name_en          TEXT,
    description      TEXT,
    long_description TEXT,                              -- Markdown
    category         TEXT NOT NULL,                     -- technical/valuation/growth/sentiment/custom
    tags             JSONB,
    formula          TEXT NOT NULL,
    formula_type     TEXT NOT NULL,                     -- dsl/python
    output_type      TEXT NOT NULL,                     -- boolean/scalar/rank
    output_range     JSONB,
    lookback_days    INT DEFAULT 0,
    update_frequency TEXT DEFAULT 'daily',
    version          INT DEFAULT 1,
    owner            TEXT NOT NULL,                     -- user_id or 'platform'
    visibility       TEXT DEFAULT 'private',            -- public/private/unlisted
    stats_cache      JSONB,                             -- 历史表现统计缓存
    stats_cached_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    deprecated_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_factors_category   ON factor_definitions(category);
CREATE INDEX IF NOT EXISTS idx_factors_owner      ON factor_definitions(owner);
CREATE INDEX IF NOT EXISTS idx_factors_visibility ON factor_definitions(visibility);
CREATE INDEX IF NOT EXISTS idx_factors_tags       ON factor_definitions USING GIN (tags);

COMMENT ON TABLE factor_definitions IS '因子定义（200 内置 + 用户自定义）';


-- feature_values 因子值矩阵（分区大表）
-- 预计数据量：200 因子 × 3000 股票 × 2500 日 ≈ 15 亿行
CREATE TABLE IF NOT EXISTS feature_values (
    factor_id    TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    date         DATE NOT NULL,
    value_num    DOUBLE PRECISION,                     -- scalar/rank
    value_bool   BOOLEAN,                              -- boolean
    computed_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (factor_id, symbol, date)
) PARTITION BY RANGE (date);

COMMENT ON TABLE feature_values IS '因子值矩阵（按年分区，预计 15 亿行）';

-- 按年分区：2014 ~ 2030
DO $$
DECLARE
    y INT;
BEGIN
    FOR y IN 2014..2030 LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS feature_values_%s PARTITION OF feature_values
                FOR VALUES FROM (%L) TO (%L);',
            y, (y || '-01-01')::DATE, ((y + 1) || '-01-01')::DATE
        );
    END LOOP;
END$$;

CREATE INDEX IF NOT EXISTS idx_feature_values_date_factor
    ON feature_values(date, factor_id);


-- models 模型注册表
CREATE TABLE IF NOT EXISTS models (
    id                  TEXT PRIMARY KEY,               -- "model_abc123"
    name                TEXT NOT NULL,
    version             TEXT NOT NULL,                  -- "1.0.0"
    owner               TEXT NOT NULL,                  -- user_id or 'platform'
    source              TEXT NOT NULL,                  -- internal/uploaded/external_signal/official
    algorithm           TEXT,
    input_features      JSONB NOT NULL,
    target              TEXT,
    output_type         TEXT,
    training_range      JSONB,
    training_samples    INT,
    validation_metrics  JSONB,
    file_path           TEXT,                           -- MinIO 路径
    file_size           BIGINT,
    visibility          TEXT DEFAULT 'private',
    metadata            JSONB,                          -- 扩展字段（含官方模型 extras）
    status              TEXT DEFAULT 'draft',           -- draft/training/ready/failed/deprecated
    status_reason       TEXT,
    usage_count         INT DEFAULT 0,
    last_used_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (owner, name, version)
);

CREATE INDEX IF NOT EXISTS idx_models_owner      ON models(owner);
CREATE INDEX IF NOT EXISTS idx_models_source     ON models(source);
CREATE INDEX IF NOT EXISTS idx_models_visibility ON models(visibility, usage_count DESC);
CREATE INDEX IF NOT EXISTS idx_models_official   ON models(owner) WHERE owner = 'platform';
CREATE INDEX IF NOT EXISTS idx_models_status     ON models(status) WHERE status IN ('training', 'ready');

COMMENT ON TABLE  models         IS '模型注册表（统一用户模型 + 官方模型）';
COMMENT ON COLUMN models.owner   IS 'user_xxx 或 ''platform''';
COMMENT ON COLUMN models.metadata IS '官方模型在此存 PlatformModelExtras';


-- model_versions 模型版本
CREATE TABLE IF NOT EXISTS model_versions (
    model_id            TEXT REFERENCES models(id) ON DELETE CASCADE,
    version             TEXT NOT NULL,
    file_path           TEXT NOT NULL,
    validation_metrics  JSONB,
    is_current          BOOLEAN DEFAULT FALSE,
    training_job_id     TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    deprecated_at       TIMESTAMPTZ,
    PRIMARY KEY (model_id, version)
);

-- 一个模型只能有一个当前版本
CREATE UNIQUE INDEX IF NOT EXISTS uniq_current_version
    ON model_versions(model_id) WHERE is_current = TRUE;

COMMENT ON TABLE model_versions IS '模型版本管理（每次训练产生一个新版本）';


-- backtests 回测记录
CREATE TABLE IF NOT EXISTS backtests (
    id                   TEXT PRIMARY KEY,
    user_id              UUID REFERENCES auth.users(id),
    model_id             TEXT REFERENCES models(id),
    config               JSONB NOT NULL,
    mode                 TEXT NOT NULL,                 -- fast/realistic
    status               TEXT NOT NULL,                 -- pending/running/completed/failed
    summary              JSONB,                         -- 核心指标
    equity_curve         JSONB,                         -- 净值曲线
    segment_performance  JSONB,
    feature_importance   JSONB,
    trades_ref           TEXT,                          -- S3 路径（trades 大时落对象存储）
    error                JSONB,
    duration_ms          INT,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_backtests_user
    ON backtests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtests_model ON backtests(model_id);

COMMENT ON TABLE backtests IS '回测记录（trades 大时 ref 到 S3）';


-- training_jobs 训练任务
CREATE TABLE IF NOT EXISTS training_jobs (
    job_id           TEXT PRIMARY KEY,
    model_id         TEXT REFERENCES models(id),
    user_id          UUID,
    status           TEXT NOT NULL,                     -- pending/running/completed/failed/cancelled
    progress         NUMERIC(3, 2),
    stage            TEXT,
    config           JSONB NOT NULL,
    metrics_preview  JSONB,
    error            JSONB,
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_status
    ON training_jobs(status) WHERE status IN ('pending', 'running');

COMMENT ON TABLE training_jobs IS '训练任务队列（Celery 入库状态）';


-- ═══════════════════════════════════════════
-- 【联动】
-- ═══════════════════════════════════════════

-- sessions 会话（四种联动模式的核心）
CREATE TABLE IF NOT EXISTS sessions (
    id                      TEXT PRIMARY KEY,
    user_id                 UUID REFERENCES auth.users(id),
    scenario_id             TEXT REFERENCES scenarios(id),
    mode                    TEXT NOT NULL,             -- solo/copilot_observer/pk/copilot_interactive
    blind_options           JSONB,
    data_collection_opt_in  BOOLEAN DEFAULT TRUE,
    clock_start_ts          TIMESTAMPTZ NOT NULL,
    clock_end_ts            TIMESTAMPTZ NOT NULL,
    clock_current_ts        TIMESTAMPTZ NOT NULL,
    tick_granularity        TEXT DEFAULT '5m',
    total_ticks             INT,
    current_tick            INT DEFAULT 0,
    initial_capital         NUMERIC NOT NULL,
    status                  TEXT DEFAULT 'initializing', -- initializing/running/paused/finished/abandoned
    summary                 JSONB,                      -- 结束时的对账数据
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    started_at              TIMESTAMPTZ,
    finished_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON sessions(status) WHERE status IN ('initializing', 'running', 'paused');

COMMENT ON TABLE sessions IS '联动会话（四种模式共用）';


-- session_participants 会话参与者
CREATE TABLE IF NOT EXISTS session_participants (
    id                BIGSERIAL PRIMARY KEY,
    session_id        TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    participant_type  TEXT NOT NULL,                   -- human/model
    participant_id    TEXT NOT NULL,                   -- user_id 或 model_id
    model_version     TEXT,
    display_name      TEXT,
    initial_capital   NUMERIC NOT NULL,
    cash              NUMERIC NOT NULL,
    total_value       NUMERIC,
    total_return      NUMERIC,
    max_drawdown      NUMERIC,
    stats             JSONB,
    joined_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_participants
    ON session_participants(session_id);

COMMENT ON TABLE session_participants IS '会话参与者（人 + 模型）';


-- session_events 会话事件日志
CREATE TABLE IF NOT EXISTS session_events (
    id           BIGSERIAL PRIMARY KEY,
    session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    ts           TIMESTAMPTZ NOT NULL,                -- 会话时钟
    real_ts      TIMESTAMPTZ DEFAULT NOW(),           -- 墙钟
    actor_type   TEXT NOT NULL,
    actor_id     TEXT,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL,
    sequence     BIGINT                               -- 本会话内的严格序号
);

CREATE INDEX IF NOT EXISTS idx_session_events_session
    ON session_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_session_events_type
    ON session_events(session_id, event_type);

COMMENT ON TABLE session_events IS '会话事件日志（每次 tick/下单/信号）';


-- orders 订单
CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    session_id       TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    participant_id   TEXT NOT NULL,
    ts               TIMESTAMPTZ NOT NULL,            -- 会话时钟
    symbol           TEXT NOT NULL,
    side             TEXT NOT NULL,                   -- BUY/SELL
    quantity         INT NOT NULL,
    price            NUMERIC NOT NULL,
    order_type       TEXT DEFAULT 'limit',            -- limit/market
    status           TEXT NOT NULL,                   -- filled/partial/rejected/pending
    filled_quantity  INT,
    filled_price     NUMERIC,
    commission       NUMERIC,
    stamp_tax        NUMERIC,
    slippage_cost    NUMERIC,
    reason           TEXT,
    triggered_by     TEXT,                            -- 如 "model_suggestion:xxx"
    signal_id        TEXT,                            -- 关联的模型信号
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_session
    ON orders(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_orders_participant
    ON orders(session_id, participant_id);

COMMENT ON TABLE orders IS '会话内的订单（人 + 模型共用）';


-- training_samples 训练样本（模式 ④ 数据闭环）
CREATE TABLE IF NOT EXISTS training_samples (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    session_id          TEXT,
    ts                  TIMESTAMPTZ NOT NULL,
    symbol              TEXT,
    features            JSONB NOT NULL,
    label               TEXT NOT NULL,                -- buy_heavy/buy_light/hold/sell_light/sell_heavy
    context             JSONB,                        -- market_regime, future_return_*
    label_resolved_at   TIMESTAMPTZ,                  -- 标签回填时间（需等 N 日后）
    shared_to_public    BOOLEAN DEFAULT FALSE,
    shared_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_samples_user
    ON training_samples(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_samples_shared
    ON training_samples(shared_to_public) WHERE shared_to_public = TRUE;

COMMENT ON TABLE training_samples IS '训练样本（数据闭环）';


-- ═══════════════════════════════════════════
-- 【市场】
-- ═══════════════════════════════════════════

-- model_stars 模型收藏
CREATE TABLE IF NOT EXISTS model_stars (
    user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    model_id    TEXT REFERENCES models(id) ON DELETE CASCADE,
    starred_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, model_id)
);

COMMENT ON TABLE model_stars IS '用户收藏的模型';


-- share_links 分享链接
CREATE TABLE IF NOT EXISTS share_links (
    token          TEXT PRIMARY KEY,
    resource_type  TEXT NOT NULL,                     -- backtest/debrief/model
    resource_id    TEXT NOT NULL,
    created_by     UUID REFERENCES auth.users(id),
    options        JSONB,
    expires_at     TIMESTAMPTZ,
    access_count   INT DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_links_resource
    ON share_links(resource_type, resource_id);

COMMENT ON TABLE share_links IS '分享链接（回测报告/复盘/模型）';
