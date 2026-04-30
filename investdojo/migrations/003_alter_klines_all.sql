-- ==============================================================
-- InvestDojo Migration 003 · klines_all 表改造
-- ==============================================================
-- 对应架构：docs/architecture/01_数据层.md §3.2 / §5.1
--
-- 改造内容：
--   1. scenario_id NOT NULL → NULL（全市场数据不依赖场景）
--   2. 新增 adj_factor 列（前/后复权切换）
--   3. 加唯一约束（symbol, timeframe, dt），防止批量导入重复
--   4. 删除冗余表 klines_5min（数据已在 klines_all + timeframe=5m）
--
-- 所有操作幂等，可重复执行。
-- ==============================================================

-- ── 1. scenario_id 改为允许 NULL ──
-- 全市场数据（symbols/industries 驱动）不需要 scenario_id
-- 场景数据仍然带 scenario_id
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'klines_all'
          AND column_name = 'scenario_id'
          AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE klines_all ALTER COLUMN scenario_id DROP NOT NULL;
        RAISE NOTICE '✓ klines_all.scenario_id 改为 NULL-able';
    ELSE
        RAISE NOTICE '✓ klines_all.scenario_id 已经是 NULL-able（跳过）';
    END IF;
END$$;


-- ── 2. 新增 adj_factor 列（前/后复权因子）──
ALTER TABLE klines_all
    ADD COLUMN IF NOT EXISTS adj_factor NUMERIC(12, 6) DEFAULT 1;

COMMENT ON COLUMN klines_all.adj_factor IS '复权因子：1=未复权 / 其他=前/后复权';


-- ── 3. 加唯一约束（symbol, timeframe, dt）──
-- 之前没约束，批量采集可能重复插入。
-- 注意：如果有重复数据会加不上，需先清理
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uniq_klines_symbol_tf_dt'
    ) THEN
        BEGIN
            ALTER TABLE klines_all
                ADD CONSTRAINT uniq_klines_symbol_tf_dt UNIQUE (symbol, timeframe, dt);
            RAISE NOTICE '✓ klines_all 唯一约束已添加';
        EXCEPTION WHEN unique_violation THEN
            RAISE WARNING '⚠ 发现重复数据，先清理后再加唯一约束';
        END;
    ELSE
        RAISE NOTICE '✓ klines_all 唯一约束已存在（跳过）';
    END IF;
END$$;


-- ── 4. 补充索引（如果 001/现有表没有）──
CREATE INDEX IF NOT EXISTS idx_klines_symbol_tf_dt_desc
    ON klines_all(symbol, timeframe, dt DESC);


-- ── 5. 删除冗余表 klines_5min ──
-- 历史遗留：早期为 5m 数据单独建的表，现在已统一到 klines_all + timeframe=5m
-- 已核实 klines_all (timeframe=5m) 有 69984 行，与 klines_5min 完全重复
DROP TABLE IF EXISTS klines_5min;


-- ── 6. 验证信息 ──
DO $$
DECLARE
    row_count BIGINT;
    has_adj_factor BOOLEAN;
    scenario_nullable BOOLEAN;
BEGIN
    SELECT COUNT(*) INTO row_count FROM klines_all;
    SELECT EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'klines_all' AND column_name = 'adj_factor')
        INTO has_adj_factor;
    SELECT is_nullable = 'YES' INTO scenario_nullable
        FROM information_schema.columns
        WHERE table_name = 'klines_all' AND column_name = 'scenario_id';

    RAISE NOTICE '── klines_all 迁移后状态 ──';
    RAISE NOTICE '  总行数: %', row_count;
    RAISE NOTICE '  adj_factor 列: %', has_adj_factor;
    RAISE NOTICE '  scenario_id 可空: %', scenario_nullable;
END$$;
