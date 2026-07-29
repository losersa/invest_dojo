-- ===============================================================
-- InvestDojo · 数据库初始化（Postgres 首次启动）
-- ===============================================================
-- 执行时机：Postgres 容器首次启动（docker-entrypoint-initdb.d）
-- 作用：仅建基础扩展。业务 schema / 角色 / 自建鉴权（public.users）
--       统一由 migrations/ 管理。
--
-- 注意：已彻底移除 Supabase（PostgREST / GoTrue / Kong），
--       不再创建 auth / storage / graphql_public schema 与 supabase_* 角色。
-- ===============================================================

-- ---- 0. 扩展 ---------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
