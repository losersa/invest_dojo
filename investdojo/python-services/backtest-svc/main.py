"""backtest-svc 主入口"""

from common import create_app, get_logger, settings

logger = get_logger("backtest-svc")

app = create_app(
    service_name="backtest-svc",
    version="0.1.0",
    description="回测服务（对应 docs/api/04_回测API.md）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "backtest-svc",
        "message": "骨架就位。具体接口见 Epic 4（T-4.03 起）。",
        "docs": "/docs",
        "health": "/health",
        "port": settings.backtest_svc_port,
    }
