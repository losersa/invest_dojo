-- ==============================================================
-- InvestDojo Migration 005 · Row Level Security (RLS) 策略
-- ==============================================================
-- 对应架构：docs/architecture/01_数据层.md §6 RLS 策略
--
-- 策略原则：
--   1. 公共只读数据（行情/因子定义/官方模型）：任何认证用户可读
--   2. 用户数据（模型/会话/样本）：只能读写自己的
--   3. 官方模型写入：只有 service_role 可操作
--   4. 现有表（scenarios/klines_all/news）加只读策略
--
-- 所有操作幂等，可重复执行。
-- ==============================================================


-- ═══════ 辅助函数：获取当前用户 ID ═══════
-- Supabase 内置 auth.uid() 可用，但我们也用 JWT claim
CREATE OR REPLACE FUNCTION auth_uid()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        auth.uid(),
        (current_setting('request.jwt.claims', TRUE)::JSONB ->> 'sub')::UUID
    );
$$;


-- ═══════ 1. 公共只读表：scenarios ═══════
ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scenarios_read_all" ON scenarios;
CREATE POLICY "scenarios_read_all" ON scenarios
    FOR SELECT
    USING (TRUE);

-- 只有 service_role 可写
DROP POLICY IF EXISTS "scenarios_write_service" ON scenarios;
CREATE POLICY "scenarios_write_service" ON scenarios
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');


-- ═══════ 2. 公共只读表：klines_all ═══════
ALTER TABLE klines_all ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "klines_read_all" ON klines_all;
CREATE POLICY "klines_read_all" ON klines_all
    FOR SELECT
    USING (TRUE);

DROP POLICY IF EXISTS "klines_write_service" ON klines_all;
CREATE POLICY "klines_write_service" ON klines_all
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');


-- ═══════ 3. 公共只读表：news ═══════
ALTER TABLE news ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "news_read_all" ON news;
CREATE POLICY "news_read_all" ON news
    FOR SELECT
    USING (TRUE);

DROP POLICY IF EXISTS "news_write_service" ON news;
CREATE POLICY "news_write_service" ON news
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');


-- ═══════ 4. 公共只读表：symbols ═══════
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'symbols') THEN
        ALTER TABLE symbols ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "symbols_read_all" ON symbols;
        CREATE POLICY "symbols_read_all" ON symbols FOR SELECT USING (TRUE);
        DROP POLICY IF EXISTS "symbols_write_service" ON symbols;
        CREATE POLICY "symbols_write_service" ON symbols FOR ALL
            USING (auth.role() = 'service_role')
            WITH CHECK (auth.role() = 'service_role');
    END IF;
END$$;


-- ═══════ 5. 公共只读表：industries ═══════
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'industries') THEN
        ALTER TABLE industries ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "industries_read_all" ON industries;
        CREATE POLICY "industries_read_all" ON industries FOR SELECT USING (TRUE);
        DROP POLICY IF EXISTS "industries_write_service" ON industries;
        CREATE POLICY "industries_write_service" ON industries FOR ALL
            USING (auth.role() = 'service_role')
            WITH CHECK (auth.role() = 'service_role');
    END IF;
END$$;


-- ═══════ 6. 公共只读表：factor_definitions ═══════
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'factor_definitions') THEN
        ALTER TABLE factor_definitions ENABLE ROW LEVEL SECURITY;

        -- 所有人可读公共因子；用户因子只能自己看
        DROP POLICY IF EXISTS "factor_def_read" ON factor_definitions;
        CREATE POLICY "factor_def_read" ON factor_definitions
            FOR SELECT
            USING (
                visibility = 'public'
                OR owner = auth_uid()::TEXT
                OR auth.role() = 'service_role'
            );

        -- 用户只能创建自己的自定义因子
        DROP POLICY IF EXISTS "factor_def_insert" ON factor_definitions;
        CREATE POLICY "factor_def_insert" ON factor_definitions
            FOR INSERT
            WITH CHECK (
                owner = auth_uid()::TEXT
                OR auth.role() = 'service_role'
            );

        -- 只能修改/删除自己的
        DROP POLICY IF EXISTS "factor_def_update" ON factor_definitions;
        CREATE POLICY "factor_def_update" ON factor_definitions
            FOR UPDATE
            USING (owner = auth_uid()::TEXT OR auth.role() = 'service_role');

        DROP POLICY IF EXISTS "factor_def_delete" ON factor_definitions;
        CREATE POLICY "factor_def_delete" ON factor_definitions
            FOR DELETE
            USING (owner = auth_uid()::TEXT OR auth.role() = 'service_role');
    END IF;
END$$;


-- ═══════ 7. 用户数据表：models ═══════
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'models') THEN
        ALTER TABLE models ENABLE ROW LEVEL SECURITY;

        -- 公开模型所有人可读；私有只能自己读
        DROP POLICY IF EXISTS "models_read" ON models;
        CREATE POLICY "models_read" ON models
            FOR SELECT
            USING (
                visibility = 'public'
                OR owner = auth_uid()::TEXT
                OR auth.role() = 'service_role'
            );

        -- 只能创建自己的模型
        DROP POLICY IF EXISTS "models_insert" ON models;
        CREATE POLICY "models_insert" ON models
            FOR INSERT
            WITH CHECK (
                owner = auth_uid()::TEXT
                OR auth.role() = 'service_role'
            );

        -- 只能修改/删除自己的（官方模型 owner='platform' 只有 service_role 可改）
        DROP POLICY IF EXISTS "models_update" ON models;
        CREATE POLICY "models_update" ON models
            FOR UPDATE
            USING (owner = auth_uid()::TEXT OR auth.role() = 'service_role');

        DROP POLICY IF EXISTS "models_delete" ON models;
        CREATE POLICY "models_delete" ON models
            FOR DELETE
            USING (owner = auth_uid()::TEXT OR auth.role() = 'service_role');
    END IF;
END$$;


-- ═══════ 8. 用户数据表：sessions ═══════
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions') THEN
        ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

        -- 只能读自己的会话
        DROP POLICY IF EXISTS "sessions_read" ON sessions;
        CREATE POLICY "sessions_read" ON sessions
            FOR SELECT
            USING (user_id = auth_uid() OR auth.role() = 'service_role');

        DROP POLICY IF EXISTS "sessions_insert" ON sessions;
        CREATE POLICY "sessions_insert" ON sessions
            FOR INSERT
            WITH CHECK (user_id = auth_uid() OR auth.role() = 'service_role');

        DROP POLICY IF EXISTS "sessions_update" ON sessions;
        CREATE POLICY "sessions_update" ON sessions
            FOR UPDATE
            USING (user_id = auth_uid() OR auth.role() = 'service_role');
    END IF;
END$$;


-- ═══════ 9. 用户数据表：orders / portfolio_snapshots / decision_logs ═══════
DO $$ BEGIN
    -- orders: 通过 session 关联，靠 session 的 RLS 间接保护
    -- 但为安全起见也加直接策略
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'orders') THEN
        ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS "orders_rw" ON orders;
        CREATE POLICY "orders_rw" ON orders
            FOR ALL
            USING (
                session_id IN (SELECT id FROM sessions WHERE user_id = auth_uid())
                OR auth.role() = 'service_role'
            )
            WITH CHECK (
                session_id IN (SELECT id FROM sessions WHERE user_id = auth_uid())
                OR auth.role() = 'service_role'
            );
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'decision_logs') THEN
        ALTER TABLE decision_logs ENABLE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS "decision_logs_rw" ON decision_logs;
        CREATE POLICY "decision_logs_rw" ON decision_logs
            FOR ALL
            USING (
                session_id IN (SELECT id FROM sessions WHERE user_id = auth_uid())
                OR auth.role() = 'service_role'
            )
            WITH CHECK (
                session_id IN (SELECT id FROM sessions WHERE user_id = auth_uid())
                OR auth.role() = 'service_role'
            );
    END IF;
END$$;


-- ═══════ 10. 公共只读但 service_role 写的辅助表 ═══════
DO $blk$
DECLARE
    r RECORD;
    sr TEXT := 'service_role';
BEGIN
    FOR r IN (
        SELECT table_name FROM (VALUES
            ('fundamentals'),
            ('market_snapshots'),
            ('feature_values'),
            ('backtest_runs'),
            ('training_samples')
        ) AS t(table_name)
    ) LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = r.table_name AND table_schema = 'public') THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);

            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.table_name || '_read', r.table_name);
            EXECUTE format(
                'CREATE POLICY %I ON %I FOR SELECT USING (TRUE)',
                r.table_name || '_read', r.table_name
            );

            EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.table_name || '_write_service', r.table_name);
            EXECUTE format(
                'CREATE POLICY %I ON %I FOR ALL USING (auth.role() = %L) WITH CHECK (auth.role() = %L)',
                r.table_name || '_write_service', r.table_name, sr, sr
            );
        END IF;
    END LOOP;
END$blk$;


-- ═══════ 验证 ═══════
DO $$
DECLARE
    tbl RECORD;
    rls_count INT := 0;
BEGIN
    FOR tbl IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND rowsecurity = TRUE
    LOOP
        rls_count := rls_count + 1;
    END LOOP;

    RAISE NOTICE '── RLS 状态 ──';
    RAISE NOTICE '  已启用 RLS 的表数: %', rls_count;
END$$;
