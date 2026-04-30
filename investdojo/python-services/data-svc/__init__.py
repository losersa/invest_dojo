"""data-svc · InvestDojo 数据 API 服务

提供所有其他模块（前端、feature-svc、backtest-svc 等）所需的统一数据接口：
- 股票元数据（symbols / industries）
- K 线（klines）—— 强制 as_of 注入
- 新闻（news）
- 财报（fundamentals）
- 市场快照（market_snapshots）
- 场景（scenarios）

对应文档：docs/api/01_数据API.md
"""
