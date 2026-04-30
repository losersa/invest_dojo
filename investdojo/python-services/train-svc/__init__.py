"""train-svc · 模型训练服务

职责：
- 接收训练任务，入 Celery 队列
- 支持 LightGBM/XGBoost/LSTM 等算法
- 训练结果保存到 MinIO + 元数据入 models 表
- 对应 API：docs/api/03_模型API.md §4
"""
