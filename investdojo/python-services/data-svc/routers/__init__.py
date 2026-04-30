"""data-svc 路由聚合"""
from .fundamentals import router as fundamentals_router
from .klines import router as klines_router
from .market_snapshots import router as market_snapshots_router
from .news import router as news_router
from .scenarios import router as scenarios_router
from .symbols import router as symbols_router

__all__ = [
    "fundamentals_router",
    "klines_router",
    "market_snapshots_router",
    "news_router",
    "scenarios_router",
    "symbols_router",
]
