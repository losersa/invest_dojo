"""backtest-svc · 回测服务

职责（MVP / T-2.04）：
- `POST /api/v1/backtests/run-fast` · 快速回测（mock，< 30s）
- `POST /api/v1/backtests/quick-factor` · 单因子快测（不落库）
- `GET /api/v1/backtests/{id}` · 回测详情
- `GET /api/v1/backtests` · 历史列表

Epic 4（T-4.xx）接入 VectorBT / Backtrader 真引擎。

对应文档：docs/api/04_回测API.md
"""
