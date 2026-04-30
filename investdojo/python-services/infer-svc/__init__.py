"""infer-svc · 推理服务

职责（MVP / T-2.03）：
- 提供 `POST /predict` · 请求响应推理（mock 模型）
- 强制 `as_of` 校验（防未来函数）
- WebSocket `/ws/stream` · 占位，Epic 6 完善

Epic 3（T-3.03）接入真实 LightGBM 模型加载 + sklearn predict。

对应文档：
- docs/api/05_推理API.md
"""
