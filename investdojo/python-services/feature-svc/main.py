"""feature-svc 主入口

启动：uvicorn feature-svc.main:app --port 8001
"""

from common import create_app, get_logger, settings

logger = get_logger("feature-svc")

app = create_app(
    service_name="feature-svc",
    version="0.1.0",
    description="因子计算与因子库服务（对应 docs/api/02_因子库API.md）",
)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "service": "feature-svc",
        "message": "骨架就位。具体接口见 Epic 3（T-3.01 起）。",
        "docs": "/docs",
        "health": "/health",
        "port": settings.feature_svc_port,
    }


# 占位：未来这里会挂载 /api/v1/factors 路由
# from feature_svc.api import factors_router
# app.include_router(factors_router, prefix="/api/v1")
