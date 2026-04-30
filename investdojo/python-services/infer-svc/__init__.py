"""infer-svc · 推理服务

职责：
- 在线推理（REST POST /predict）
- 批量推理（回测用）
- 流式推理（WebSocket，联动模式用）
- 防未来函数（as_of 强制）
- 对应 API：docs/api/05_推理API.md
"""
