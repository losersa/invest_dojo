"""train-svc · 模型训练任务编排服务

职责（MVP / T-2.02）：
- 接收训练任务提交（POST /jobs）
- 推到 Celery 队列执行（queue=train）
- 实时查询任务状态（GET /jobs/{job_id}）
- 列出任务（GET /jobs）

Epic 3（T-3.02）补真正的训练逻辑（LightGBM / XGBoost baseline）。

对应文档：
- docs/product/99_MVP_Sprint0.md T-2.02
- docs/architecture/03_量化模块.md §训练
"""
