-- ===============================================================
-- InvestDojo · post-GoTrue 补丁
-- ===============================================================
-- 执行时机：**GoTrue 成功跑完自己的 migration 之后**
-- 由 scripts/up.ps1 / up.sh 在 auth 容器健康后，以 supabase_auth_admin
-- 身份通过 psql 执行。
--
-- 做的事：
--   - 补全 auth.email() 和 auth.jwt()（GoTrue v2 可能没建）
--   - 统一把这些函数的执行权限给 anon/authenticated/service_role
-- ===============================================================

-- 先确保当前 role 能在 auth schema 里建函数
SET search_path = auth, public;

CREATE OR REPLACE FUNCTION auth.email() RETURNS TEXT
LANGUAGE SQL STABLE AS $$
    SELECT COALESCE(
        nullif(current_setting('request.jwt.claim.email', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::JSONB ->> 'email')
    );
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB
LANGUAGE SQL STABLE AS $$
    SELECT COALESCE(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::JSONB;
$$;

-- GoTrue 已经建好了 auth.uid() 和 auth.role()，这里只补授权
-- 用 IF EXISTS 兜底避免报错
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
               WHERE n.nspname = 'auth' AND p.proname = 'uid') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION auth.uid()   TO anon, authenticated, service_role';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
               WHERE n.nspname = 'auth' AND p.proname = 'role') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION auth.role()  TO anon, authenticated, service_role';
    END IF;
END $$;

GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt()   TO anon, authenticated, service_role;
