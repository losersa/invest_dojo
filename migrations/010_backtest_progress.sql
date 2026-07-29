-- 异步回测进度（{pct, stage}）与元数据，供前端轮询展示
ALTER TABLE backtests ADD COLUMN IF NOT EXISTS progress JSONB;
COMMENT ON COLUMN backtests.progress IS '异步回测进度 { pct:int, stage:text }';
ALTER TABLE backtests ADD COLUMN IF NOT EXISTS meta JSONB;
COMMENT ON COLUMN backtests.meta IS '回测元数据（engine/benchmark/target_symbol/…）';
