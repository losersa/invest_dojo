
-- ═══════════════════════════════════════════════════════════════
-- InvestDojo Bootstrap: 创建迁移工具所需的 RPC 函数
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION _exec_migration(sql_text TEXT)
RETURNS TABLE(success BOOLEAN, message TEXT, duration_ms INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
    start_ts TIMESTAMPTZ;
    elapsed INTEGER;
    ok_text TEXT := 'OK';
BEGIN
    start_ts := clock_timestamp();
    BEGIN
        EXECUTE sql_text;
        elapsed := EXTRACT(MILLISECONDS FROM clock_timestamp() - start_ts)::INTEGER;
        RETURN QUERY SELECT TRUE, ok_text, elapsed;
    EXCEPTION WHEN OTHERS THEN
        elapsed := EXTRACT(MILLISECONDS FROM clock_timestamp() - start_ts)::INTEGER;
        RETURN QUERY SELECT FALSE, SQLERRM::TEXT, elapsed;
    END;
END$fn$;

CREATE TABLE IF NOT EXISTS _migration_history (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms INTEGER
);

CREATE OR REPLACE FUNCTION _migration_status()
RETURNS TABLE(filename TEXT, checksum TEXT, applied_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER
AS $fn$
    SELECT filename, checksum, applied_at FROM _migration_history ORDER BY id;
$fn$;
