-- ===============================================================
-- InvestDojo · Supabase 兼容层初始化（极简版）
-- ===============================================================
-- 执行时机：Postgres 容器首次启动（docker-entrypoint-initdb.d）
-- 作用：
--   1. 建 schema（auth / storage / extensions / graphql_public）
--   2. 建 role（anon / authenticated / service_role / authenticator /
--      supabase_auth_admin）
--   3. 给 supabase_auth_admin 足够权限，让 GoTrue 自己跑完 auth
--      schema migration（包括 auth.users 表 + auth.uid()/role() 函数）
--
-- 不做的事：
--   - 不建 auth.users 表（GoTrue 自己建更完整的）
--   - 不建 auth.uid()/role()/jwt() 函数（GoTrue 自己建）
--   - 密码由 scripts/up.* 在容器启动后 ALTER ROLE 设置
-- ===============================================================

-- ---- 0. 扩展 ---------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;


-- ---- 1. Schema -------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS graphql_public;


-- ---- 2. Role（无密码创建，密码由 bootstrap 步骤后填）------------
DO $$ BEGIN CREATE ROLE anon           NOLOGIN NOINHERIT;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated  NOLOGIN NOINHERIT;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role   NOLOGIN NOINHERIT BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticator        LOGIN NOINHERIT;      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_auth_admin  LOGIN NOINHERIT;      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT anon, authenticated, service_role TO authenticator;


-- ---- 3. 关键：让 supabase_auth_admin 真正拥有 auth schema ------
-- GoTrue 会在 auth schema 里建表、改表、建函数。如果 schema 本身
-- owner 还是 postgres，GoTrue 的 CREATE OR REPLACE FUNCTION 会报
-- "must be owner of function ..." 错误。
ALTER SCHEMA auth OWNER TO supabase_auth_admin;


-- ---- 4. Schema 权限 --------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL   ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL    ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL    ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL    ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES    TO anon, authenticated;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- auth schema 的 ALL 权限已经通过 OWNER 给 supabase_auth_admin 了
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES    TO anon, authenticated, service_role;

GRANT USAGE ON SCHEMA storage    TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;


-- ---- 5. 结束 ---------------------------------------------------
COMMENT ON SCHEMA auth IS 'InvestDojo · Supabase compat · GoTrue 自托管';
