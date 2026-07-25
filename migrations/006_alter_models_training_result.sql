-- 006 · models 表扩展「训练结果」字段
-- 让训练完成后能一次性拿到：模型文件(file_path)、特征输入顺序(input_features)、
-- 完整特征重要度(feature_importance)、评估指标表(validation_metrics)。
-- 这些字段在回测 / 推理时直接可用。

-- 完整特征重要度（gain，与 input_features 同序），回测解释 / 特征筛选直接可读
ALTER TABLE models
    ADD COLUMN IF NOT EXISTS feature_importance JSONB;

COMMENT ON COLUMN models.feature_importance IS
    '完整特征重要度（LightGBM gain），键=特征名，与 input_features 顺序一致';
