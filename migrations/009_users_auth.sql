-- ==============================================================
-- InvestDojo Migration 009 · 自建鉴权用户表（替代 Supabase Auth / GoTrue）
-- ==============================================================
-- 目标：
--   1) 建立 public.users（自建鉴权的用户表）
--   2) 把原 auth.users（GoTrue 自管）的用户迁移过来（保留相同 UUID，
--      使既有 profiles / training_jobs 等外键与数据归属不丢）
--   3) 把引用 auth.users 的所有外键改指 public.users
--   4) 彻底 DROP auth schema，解除对 Supabase Auth 的依赖
--
-- 注意：本迁移通过动态 DO 块处理，可重复执行（幂等）。
-- ==============================================================


-- ── 1. 用户表 ──
CREATE TABLE IF NOT EXISTS public.users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT,                                  -- pbkdf2_sha256$iter$salt$hash（见 common/auth.py）
    display_name  TEXT,
    role          TEXT NOT NULL DEFAULT 'user',          -- admin | staff | employee | user
    provider      TEXT NOT NULL DEFAULT 'email',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.users IS '自建鉴权用户表（替代原 Supabase Auth 的 auth.users）';
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);


-- ── 2. 迁移既有用户（保留 UUID）──
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'auth' AND table_name = 'users'
    ) THEN
        INSERT INTO public.users (id, email, display_name, role, provider, created_at)
        SELECT
            u.id,
            u.email,
            COALESCE(
                u.raw_user_meta_data ->> 'display_name',
                u.raw_user_meta_data ->> 'full_name',
                split_part(u.email, '@', 1)
            ),
            COALESCE(u.raw_user_meta_data ->> 'role', 'user'),
            COALESCE(u.raw_app_meta_data ->> 'provider', 'email'),
            u.created_at
        FROM auth.users u
        WHERE NOT EXISTS (
            SELECT 1 FROM public.users w WHERE w.email = u.email
        )
        ON CONFLICT (id) DO NOTHING;

        RAISE NOTICE '── 已从 auth.users 迁移用户 ──';
    END IF;
END$$;


-- ── 3. 把引用 auth.users 的外键改指 public.users ──
DO $$
DECLARE
    r RECORD;
    refs TEXT;
BEGIN
    FOR r IN
        SELECT
            tc.constraint_name  AS constraint_name,
            tc.table_name       AS table_name,
            kcu.column_name     AS column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema   = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema   = 'public'
          AND (
                SELECT ccu.table_schema || '.' || ccu.table_name
                FROM information_schema.constraint_column_usage ccu
                WHERE ccu.constraint_name = tc.constraint_name
                  AND ccu.constraint_schema = tc.table_schema
          ) = 'auth.users'
    LOOP
        EXECUTE format(
            'ALTER TABLE %I DROP CONSTRAINT %I',
            r.table_name, r.constraint_name
        );
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I '
            'FOREIGN KEY (%I) REFERENCES public.users(id) ON DELETE SET NULL',
            r.table_name, r.constraint_name, r.column_name
        );
        RAISE NOTICE 'repoint FK % → public.users', r.constraint_name;
    END LOOP;
END$$;


-- ── 4. 彻底移除 auth schema（含 GoTrue 内部表 / auth.uid / auth.role）──
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth') THEN
        DROP SCHEMA auth CASCADE;
        RAISE NOTICE '── 已 DROP auth schema，Supabase Auth 依赖解除 ──';
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'drop auth schema skipped: %', SQLERRM;
END$$;
