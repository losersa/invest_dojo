-- 008_training_jobs_user_target.sql
-- 训练任务：按「用户」与「预测目标股票」维度组织
--
-- 背景（2026-07-27）：训练页需要
--   1) 按预测目标股票（target_symbol）分模块 + 过滤最近任务；
--   2) 参数（config）与结果（model）按「用户 + 任务 id」区分保存。
-- 原 training_jobs.target_symbol 只藏在 config JSONB 里，无法索引/分组过滤
-- （后端 supabase_client 的列名白名单不允许 JSONB 路径过滤）；user_id 一直写 NULL。
-- 本迁移把 target_symbol 提升为独立列，并把 user_id 关联到用户主键（auth.users.id）。

-- ── 1. target_symbol 独立列（从 config 提升，便于索引/分组/过滤）──
ALTER TABLE training_jobs
    ADD COLUMN IF NOT EXISTS target_symbol TEXT;

COMMENT ON COLUMN training_jobs.target_symbol IS
    '预测目标股票代码（多股票输入预测单只）；NULL=全市场面板。冗余自 config.target_symbol，供分模块/过滤';

-- 回填历史任务：从 config JSONB 取 target_symbol（空串按 NULL 处理）
UPDATE training_jobs
   SET target_symbol = NULLIF(config->>'target_symbol', '')
 WHERE target_symbol IS NULL
   AND config ? 'target_symbol';

-- ── 2. user_id 关联到用户主键（public.users.id）──
-- training_jobs.user_id 已是 UUID（migration 002）。这里补外键（用主键 id 关联）+ 索引。
-- ON DELETE SET NULL：用户注销后保留任务记录，仅解除归属；NULL（匿名任务）不受 FK 约束。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'training_jobs_user_id_fkey'
           AND table_name = 'training_jobs'
    ) THEN
        ALTER TABLE training_jobs
            ADD CONSTRAINT training_jobs_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL
            NOT VALID;  -- 不校验历史行（均为 NULL），避免长事务
    END IF;
END$$;

-- ── 3. 查询索引 ──
-- 「我的任务」列表：按用户 + 时间倒序
CREATE INDEX IF NOT EXISTS idx_training_jobs_user_created
    ON training_jobs (user_id, created_at DESC);

-- 「某目标股票的任务」列表 / 分模块聚合：按目标 + 时间倒序
CREATE INDEX IF NOT EXISTS idx_training_jobs_target_created
    ON training_jobs (target_symbol, created_at DESC);

-- 「我的某目标任务」（模块页最近任务）：用户 + 目标 + 时间
CREATE INDEX IF NOT EXISTS idx_training_jobs_user_target
    ON training_jobs (user_id, target_symbol, created_at DESC);
