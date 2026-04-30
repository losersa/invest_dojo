"""data-svc 主入口

启动：uvicorn main:app --app-dir data-svc --port 8000
本地开发：make dev（通过 Procfile）
"""

from routers import (
    fundamentals_router,
    klines_router,
    market_snapshots_router,
    news_router,
    scenarios_router,
    symbols_router,
)

from common import create_app, get_logger, settings

logger = get_logger("data-svc")

app = create_app(
    service_name="data-svc",
    version="0.1.0",
    description="数据 API 服务（对应 docs/api/01_数据API.md）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "data-svc",
        "docs": "/docs",
        "health": "/health",
        "port": settings.data_svc_port,
        "endpoints": [
            "/api/v1/data/symbols",
            "/api/v1/data/symbols/{code}",
            "/api/v1/data/industries",
            "/api/v1/data/klines",
            "/api/v1/data/klines/latest",
            "/api/v1/data/news",
            "/api/v1/data/fundamentals",
            "/api/v1/data/market/snapshot",
            "/api/v1/data/scenarios",
        ],
    }


# 业务路由
app.include_router(symbols_router, prefix="/api/v1/data", tags=["symbols"])
app.include_router(klines_router, prefix="/api/v1/data", tags=["klines"])
app.include_router(news_router, prefix="/api/v1/data", tags=["news"])
app.include_router(fundamentals_router, prefix="/api/v1/data", tags=["fundamentals"])
app.include_router(market_snapshots_router, prefix="/api/v1/data", tags=["market"])
app.include_router(scenarios_router, prefix="/api/v1/data", tags=["scenarios"])
