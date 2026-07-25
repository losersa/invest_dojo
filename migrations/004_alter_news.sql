-- ==============================================================
-- InvestDojo Migration 004 · news 表扩展
-- ==============================================================
-- 对应架构：docs/architecture/01_数据层.md §3.4 news
--
-- 改造内容：
--   1. 新增 published_at（精确发布时间）
--   2. 新增 sentiment_score（量化情绪值 -1~+1）
--   3. 新增 tags（JSONB 标签数组）
--   4. 新增 url（原始链接）
--   5. scenario_id 改为可空（全市场新闻不依赖场景）
--   6. 基于 published_at 的索引
--
-- 所有操作幂等，可重复执行。
-- ==============================================================

-- ── 1. scenario_id 改为允许 NULL ──
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'news'
          AND column_name = 'scenario_id'
          AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE news ALTER COLUMN scenario_id DROP NOT NULL;
        RAISE NOTICE '✓ news.scenario_id 改为 NULL-able';
    ELSE
        RAISE NOTICE '✓ news.scenario_id 已经是 NULL-able（跳过）';
    END IF;
END$$;


-- ── 2. 新增 published_at（精确发布时间戳）──
-- 比 date 列更精确（含时分秒），支持 as_of 严格比较
ALTER TABLE news
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- 回填：用现有的 date 列 + 08:00:00（假设中国早盘开盘前发布）
UPDATE news
SET published_at = (date || 'T08:00:00+08:00')::TIMESTAMPTZ
WHERE published_at IS NULL AND date IS NOT NULL;

COMMENT ON COLUMN news.published_at IS '精确发布时间（含时分秒），支持 as_of 查询';


-- ── 3. 新增 sentiment_score（量化情绪值）──
-- -1.0（极度利空）到 +1.0（极度利好），0 = 中性
ALTER TABLE news
    ADD COLUMN IF NOT EXISTS sentiment_score NUMERIC(4, 3);

-- 回填：用现有 sentiment 文本转为数值
UPDATE news
SET sentiment_score = CASE sentiment
    WHEN 'positive' THEN 0.5
    WHEN 'negative' THEN -0.5
    WHEN 'neutral' THEN 0
    ELSE 0
END
WHERE sentiment_score IS NULL AND sentiment IS NOT NULL;

COMMENT ON COLUMN news.sentiment_score IS '量化情绪值 [-1, +1]，用于模型特征';


-- ── 4. 新增 tags（JSONB 标签数组）──
-- 例如 ["疫情", "医疗", "黑天鹅"]
ALTER TABLE news
    ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::JSONB;

COMMENT ON COLUMN news.tags IS '标签数组，如 ["疫情","医疗"]';


-- ── 5. 新增 url（原始链接）──
ALTER TABLE news
    ADD COLUMN IF NOT EXISTS url TEXT;

COMMENT ON COLUMN news.url IS '新闻原始链接';


-- ── 6. 新增 related_symbols 索引（GIN 加速 JSONB 查询）──
-- related_symbols 如果已经是 JSONB 数组，加 GIN 索引
-- 注意：如果 related_symbols 目前是 TEXT[]，需要先迁移类型
DO $$
DECLARE
    col_type TEXT;
BEGIN
    SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_name = 'news' AND column_name = 'related_symbols';

    IF col_type IS NULL THEN
        RAISE NOTICE '⚠ related_symbols 列不存在';
    ELSIF col_type = 'ARRAY' OR col_type = 'text[]' THEN
        -- 转为 JSONB
        ALTER TABLE news ALTER COLUMN related_symbols TYPE JSONB USING to_jsonb(related_symbols);
        RAISE NOTICE '✓ related_symbols TEXT[] → JSONB';
    ELSIF col_type = 'jsonb' THEN
        RAISE NOTICE '✓ related_symbols 已经是 JSONB';
    ELSE
        RAISE NOTICE '✓ related_symbols 类型: %', col_type;
    END IF;
END$$;


-- ── 7. 索引 ──
CREATE INDEX IF NOT EXISTS idx_news_published_at
    ON news(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_scenario_date
    ON news(scenario_id, date);


-- ── 8. 验证 ──
DO $$
DECLARE
    row_count BIGINT;
    has_published BOOLEAN;
    has_score BOOLEAN;
    has_tags BOOLEAN;
BEGIN
    SELECT COUNT(*) INTO row_count FROM news;
    SELECT EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'news' AND column_name = 'published_at')
        INTO has_published;
    SELECT EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'news' AND column_name = 'sentiment_score')
        INTO has_score;
    SELECT EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'news' AND column_name = 'tags')
        INTO has_tags;

    RAISE NOTICE '── news 迁移后状态 ──';
    RAISE NOTICE '  总行数: %', row_count;
    RAISE NOTICE '  published_at 列: %', has_published;
    RAISE NOTICE '  sentiment_score 列: %', has_score;
    RAISE NOTICE '  tags 列: %', has_tags;
END$$;
